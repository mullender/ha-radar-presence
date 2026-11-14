"""Dev-only radar simulator.

Recreates the production radar devices from exports in dev/data (see
tools/export_history.mjs) with the same entity ids, then:

1. On first start, backfills the recorder with the whole export, time-shifted
   so it ends "now" (states are written with explicit past timestamps).
2. Replays the export live, in a loop, with the original timing (X then Y
   ~1–4 ms later), so the integration sees the real update pattern.

Also publishes the legacy input_text polygon helpers from the export so the
import path can be exercised.

configuration.yaml:
    radar_sim:
      data_dir: /path/to/dev/data
"""

from __future__ import annotations

import asyncio
import bisect
import gzip
import json
import logging
import time
from datetime import datetime
from pathlib import Path

import voluptuous as vol

from homeassistant.config_entries import SOURCE_IMPORT, ConfigEntry
from homeassistant.const import EVENT_HOMEASSISTANT_STOP
from homeassistant.core import HomeAssistant, callback
from homeassistant.components.recorder import get_instance
from homeassistant.helpers import config_validation as cv, device_registry as dr, entity_registry as er
from homeassistant.helpers.start import async_at_started

DOMAIN = "radar_sim"
_LOGGER = logging.getLogger(__name__)

CONFIG_SCHEMA = vol.Schema(
    {DOMAIN: vol.Schema({vol.Required("data_dir"): cv.string, vol.Optional("backfill", default=True): bool})},
    extra=vol.ALLOW_EXTRA,
)


async def async_setup(hass: HomeAssistant, config) -> bool:
    if DOMAIN in config:
        hass.async_create_task(
            hass.config_entries.flow.async_init(DOMAIN, context={"source": SOURCE_IMPORT}, data=dict(config[DOMAIN]))
        )
    return True


def _load(data_dir: str) -> list[dict]:
    docs = []
    for path in sorted(Path(data_dir).glob("*.json.gz")):
        with gzip.open(path) as f:
            docs.append(json.load(f))
    return docs


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    docs = await hass.async_add_executor_job(_load, entry.data["data_dir"])
    if not docs:
        _LOGGER.warning("radar_sim: no exports found in %s", entry.data["data_dir"])
        return True
    dev_reg = dr.async_get(hass)
    ent_reg = er.async_get(hass)
    sims = []
    for doc in docs:
        meta = doc["meta"]
        device = dev_reg.async_get_or_create(
            config_entry_id=entry.entry_id,
            identifiers={(DOMAIN, meta["slug"])},
            name=meta["name"],
            manufacturer=meta.get("manufacturer"),
            model=meta.get("model"),
            sw_version=meta.get("sw_version"),
            suggested_area=(meta.get("area_id") or "").replace("_", " ").title() or None,
        )
        for eid in meta["entities"]:
            domain, object_id = eid.split(".", 1)
            ent_reg.async_get_or_create(
                domain, DOMAIN, eid, suggested_object_id=object_id, device_id=device.id, config_entry=entry,
                unit_of_measurement=meta.get("units", {}).get(eid),  # like real ESPHome sensors
            )
        for eid, state in meta.get("polygons", {}).items():
            hass.states.async_set(eid, state, {"friendly_name": eid.split(".", 1)[1], "max": 255})
        sims.append(DeviceSim(hass, doc))

    state_file = Path(hass.config.path(".radar_sim.json"))
    saved = await hass.async_add_executor_job(
        lambda: json.loads(state_file.read_text()) if state_file.exists() else {}
    )
    tasks: list[asyncio.Task] = []

    async def start(_hass: HomeAssistant | None = None) -> None:
        nonlocal saved
        if entry.data.get("backfill", True) and not saved.get("backfilled"):
            # Wait for the recorder, then feed it in chunks: a startup burst of
            # ~300k states stalls the recorder's startup event processing.
            recorder = get_instance(hass)
            await recorder.async_db_ready
            now = time.time()
            for sim in sims:
                await sim.backfill(now, recorder, _dump_recorder_stack)
            saved = {"backfilled": True, "anchor": now}
            await hass.async_add_executor_job(state_file.write_text, json.dumps(saved))
        anchor = saved.get("anchor", time.time())
        for sim in sims:
            tasks.append(entry.async_create_background_task(hass, sim.run(anchor), f"radar_sim {sim.slug}"))

    @callback
    def _on_started(_hass: HomeAssistant) -> None:
        entry.async_create_background_task(hass, start(), "radar_sim start")

    entry.async_on_unload(async_at_started(hass, _on_started))

    def _stop(_event=None) -> None:
        for t in tasks:
            t.cancel()

    entry.async_on_unload(_stop)
    entry.async_on_unload(hass.bus.async_listen_once(EVENT_HOMEASSISTANT_STOP, _stop))
    return True


def _dump_recorder_stack() -> None:
    import sys
    import threading
    import traceback

    for th in threading.enumerate():
        if "Recorder" in th.name or th.name.startswith("Recorder"):
            frame = sys._current_frames().get(th.ident)
            if frame:
                _LOGGER.warning("radar_sim: recorder thread %s stack:\n%s", th.name, "".join(traceback.format_stack(frame)[-14:]))


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    return True


class DeviceSim:
    def __init__(self, hass: HomeAssistant, doc: dict) -> None:
        self.hass = hass
        meta = doc["meta"]
        self.slug = meta["slug"]
        self.units = meta.get("units", {})
        keep = set(meta["entities"])
        events = [(t, eid, s) for eid, rows in doc["history"].items() if eid in keep for t, s in rows]
        events.sort(key=lambda e: e[0])
        self.events = events
        self.times = [e[0] for e in events]
        self.start = datetime.fromisoformat(meta["start"].replace("Z", "+00:00")).timestamp()
        self.end = datetime.fromisoformat(meta["end"].replace("Z", "+00:00")).timestamp()
        self.span = self.end - self.start

    def _set(self, eid: str, state: str, timestamp: float | None = None) -> None:
        attrs = {"unit_of_measurement": self.units.get(eid), "state_class": "measurement"}
        if attrs["unit_of_measurement"] is None:
            del attrs["unit_of_measurement"]
        self.hass.states.async_set(eid, state, attrs, timestamp=timestamp)

    async def backfill(self, now: float, recorder, on_stall=None) -> None:
        """Write the whole export into the recorder, shifted to end at ``now``."""
        shift = now - self.end
        # Paced: each recorded state links to the entity's previous state, and
        # SQLAlchemy's flush sorts those chains quadratically. Long chains in
        # one commit stall the recorder, so keep each commit small.
        for i, (t, eid, s) in enumerate(self.events):
            self._set(eid, s, timestamp=t + shift)
            if i % 200 == 0:
                await asyncio.sleep(0.25)
                waited = 0.0
                while recorder.backlog > 5000:
                    await asyncio.sleep(0.2)
                    waited += 0.2
                    if on_stall and abs(waited - 20) < 0.1:
                        on_stall()
        _LOGGER.info("radar_sim: backfilled %s (%d states)", self.slug, len(self.events))

    async def run(self, anchor: float) -> None:
        """Loop the export in real time. At ``anchor`` the replay is at the export start."""
        while True:
            elapsed = (time.time() - anchor) % self.span
            loop_base = time.time() - elapsed  # wall time of export start in this loop
            i = bisect.bisect_left(self.times, self.start + elapsed)
            # Seed every entity with its state at this point of the export;
            # otherwise it stays unavailable until its next change (hours if quiet).
            current: dict[str, str] = {}
            for _t, eid, s in self.events[:i]:
                current[eid] = s
            for eid, s in current.items():
                self._set(eid, s)
            while i < len(self.events):
                t, eid, s = self.events[i]
                delay = (t - self.start) + loop_base - time.time()
                if delay > 0:
                    await asyncio.sleep(delay)
                self._set(eid, s)
                i += 1
            await asyncio.sleep(0.5)
