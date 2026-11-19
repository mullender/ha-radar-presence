"""Report a problem: one time window of the home, anonymized, as a file to attach to an issue.

The file holds what is needed to replay the moment (tools/load_report.py):
raw radar readings in the export_history format, door / hint / occupancy
sensor history, each radar's configuration, floors, and what happened
(Activity with corrections, our zone entities' on/off). Names are replaced by
aliases (Room A, Radar 1, Door 1, ...), entity ids too, and every time is
moved to 2000-01-01 (keeping the time of day only if asked). Nothing is sent
anywhere: the panel downloads it.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from typing import Any

from homeassistant.components.recorder import get_instance
from homeassistant.const import __version__ as HA_VERSION
from homeassistant.core import HomeAssistant
from homeassistant.helpers import area_registry as ar, entity_registry as er, floor_registry as fr
from homeassistant.util import dt as dt_util

from .const import CONF_EVIDENCE, CONF_EVIDENCE_ON, CONF_OCCUPANCY, CONF_OUTSIDE_DOORS, CONF_VACUUMS, DOMAIN, VERSION
from .history import _fetch, _state_rows

REPORT_FORMAT = "radar-presence-report/1"
MAX_WINDOW_S = 1800
EPOCH_2000 = datetime(2000, 1, 1, tzinfo=timezone.utc).timestamp()
KIND_LABEL = {"include": "Room", "exclude": "Ignore", "exit": "Doorway", "linger": "Spot", "transient": "Walkway"}


def _letters(n: int) -> str:
    s = ""
    while True:
        s = chr(65 + n % 26) + s
        n = n // 26 - 1
        if n < 0:
            return s


class Aliases:
    """Real names and ids -> stand-ins, applied to every string of the report."""

    def __init__(self) -> None:
        self.map: dict[str, str] = {}
        self._n: dict[str, int] = {}

    def add(self, real: str | None, alias: str) -> str:
        if real and real not in self.map:
            self.map[real] = alias
        return self.map.get(real, alias) if real else alias

    def next(self, kind: str) -> int:
        self._n[kind] = self._n.get(kind, 0) + 1
        return self._n[kind]

    def entity(self, entity_id: str, kind: str) -> str:
        if entity_id in self.map:
            return self.map[entity_id]
        domain = entity_id.split(".", 1)[0]
        return self.add(entity_id, f"{domain}.{kind}_{self.next(kind)}")

    def apply(self, value: Any) -> Any:
        """Exact matches for keys and values; inside free text (log details), whole-word matches, longest first."""
        if self._re is None:
            keys = sorted(self.map, key=len, reverse=True)
            self._re = re.compile("|".join(rf"(?<![\w.]){re.escape(k)}(?![\w])" for k in keys)) if keys else None
        if isinstance(value, dict):
            return {self.apply(k): self.apply(v) for k, v in value.items()}
        if isinstance(value, list):
            return [self.apply(v) for v in value]
        if isinstance(value, str):
            if value in self.map:
                return self.map[value]
            return self._re.sub(lambda m: self.map[m.group(0)], value) if self._re else value
        return value

    _re: re.Pattern | None = None


async def async_build_report(
    hass: HomeAssistant,
    entry,
    start: datetime,
    end: datetime,
    *,
    symptom: str,
    expected: str = "",
    keep_time_of_day: bool = False,
) -> dict[str, Any]:
    from .websocket_api import radar_config, _zone_entity_ids, _zone_subentries  # (circular at import time)

    runtime = entry.runtime_data
    hc = runtime.headcount
    if (end - start).total_seconds() > MAX_WINDOW_S:
        start = end - timedelta(seconds=MAX_WINDOW_S)
    t0, t1 = start.timestamp(), end.timestamp()
    if keep_time_of_day:
        local = dt_util.as_local(start)
        midnight = local.replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
        shift = EPOCH_2000 - midnight
    else:
        shift = EPOCH_2000 - t0

    def sh(t: float) -> float:
        return round(t + shift, 3)

    al = Aliases()
    area_reg, floor_reg = ar.async_get(hass), fr.async_get(hass)
    al.add(entry.title, "Home")
    al.add(hass.config.location_name, "Home")
    for n, area in enumerate(sorted(area_reg.async_list_areas(), key=lambda a: a.name)):
        al.add(area.id, f"room_{_letters(n).lower()}")
        al.add(area.name, f"Room {_letters(n)}")
    for n, (sid, sp) in enumerate(sorted(hc.spaces.items())):  # an area seen by two radar groups: "<area>_<radar>"
        if sid != sp.area_id:
            al.add(sid, f"{al.map.get(sp.area_id, 'room')}_{n}")
    for floor in floor_reg.async_list_floors():
        al.add(floor.floor_id, f"floor_{floor.level if floor.level is not None else 'x'}")
        al.add(floor.name, f"Floor {floor.level if floor.level is not None else '?'}")

    # Radars: configuration and raw readings (export_history format: per entity [t, state], the last state before the window kept).
    radars = []
    entity_ids: list[str] = []
    for i, (rid, feed) in enumerate(runtime.feeds.items(), start=1):
        sub = entry.subentries[rid]
        cfg = radar_config(hass, entry, runtime, sub)
        al.add(feed.title, f"Radar {i}")
        al.add(feed.device_id, f"device_{i}")
        for t in feed.targets:
            al.add(t.x, f"sensor.radar_{i}_target_{t.slot}_x")
            al.add(t.y, f"sensor.radar_{i}_target_{t.slot}_y")
        counts: dict[str, int] = {}
        for z in cfg["zones"]:
            kind = "include" if z.get("kind") == "include" and not z.get("spot") else ("linger" if z.get("spot") else z.get("kind", "include"))
            counts[kind] = counts.get(kind, 0) + 1
            alias = f"{KIND_LABEL.get(kind, 'Shape')} {i}.{counts[kind]}"
            al.add(z.get("name"), alias)  # (in free text: the first shape with that name)
            z["name"] = alias
        cfg.pop("device_zones", None)
        radars.append({"config": cfg, "entities": [e for t in feed.targets for e in (t.x, t.y)], "area_id": cfg.get("device_area_id"), "profile": cfg.get("profile")})
        entity_ids += radars[-1]["entities"]

    # Doors, hints, occupancy sensors, vacuums.
    doors = sorted(set(hc._door_kind) | set(entry.options.get(CONF_OUTSIDE_DOORS, [])))
    for d in doors:
        al.entity(d, "door")
    evidence = sorted(set(entry.options.get(CONF_EVIDENCE, [])) | set(entry.options.get(CONF_EVIDENCE_ON, [])))
    for e in evidence:
        al.entity(e, "hint")
    occupancy = sorted(entry.options.get(CONF_OCCUPANCY, []))
    for e in occupancy:
        al.entity(e, "occupancy")
    vacuums = sorted({e for pair in hc._vacuums.items() for e in pair if e})
    for e in vacuums:
        al.entity(e, "vacuum")
    zone_ids = _zone_entity_ids(hass, _zone_subentries(entry))
    for zid, eid in sorted(zone_ids.items()):
        al.entity(eid, "zone")

    all_ids = sorted(set(entity_ids + doors + evidence + occupancy + vacuums + list(zone_ids.values())))
    raw = await get_instance(hass).async_add_executor_job(_fetch, hass, start, end, all_ids) if all_ids else {}
    rows = {eid: [[sh(max(t, t0 - 0.001)), s] for t, s in _state_rows(r)] for eid, r in raw.items()}

    report_radars = [
        {
            "config": r["config"],
            "export": {
                "meta": {"entities": r["entities"], "area_id": r["area_id"], "profile": r["profile"],
                         "units": {e: r["config"].get("target_unit") for e in r["entities"]}},
                "history": {e: rows.get(e, []) for e in r["entities"]},
            },
        }
        for r in radars
    ]
    for i, (r, feed) in enumerate(zip(report_radars, runtime.feeds.values()), start=1):
        r["export"]["meta"]["slug"] = f"radar_{i}"  # as the aliased target entities: sensor.radar_<i>_target_<n>_x
        r["export"]["meta"]["name"] = feed.title

    spaces = {sid: sp for sid, sp in hc.spaces.items()}
    levels = {f.floor_id: f.level for f in floor_reg.async_list_floors()}
    floors = {a.id: levels.get(a.floor_id) for a in area_reg.async_list_areas() if levels.get(a.floor_id) is not None}
    floors |= {sp.area_id: sp.level for sp in spaces.values()}
    outside = {}
    for d in entry.options.get(CONF_OUTSIDE_DOORS, []):
        st = er.async_get(hass).async_get(d)
        area = st.area_id if st else None
        if area is None and st and st.device_id:
            from homeassistant.helpers import device_registry as dr

            dev = dr.async_get(hass).async_get(st.device_id)
            area = dev.area_id if dev else None
        if area:
            outside[d] = area

    activity = [
        {**e, "t": sh(e["t"])} for e in hc.log if t0 <= e["t"] <= t1 and e.get("kind") != "seen"
    ]
    before = next((e for e in reversed(hc.log) if e["t"] < t0), None)
    report = {
        "format": REPORT_FORMAT,
        "meta": {
            "symptom": symptom,
            "expected": expected,
            "window": {"start": sh(t0), "end": sh(t1), "seconds": round(t1 - t0)},
            "time_of_day_kept": keep_time_of_day,
            "versions": {"integration": VERSION, "home_assistant": HA_VERSION},
            "unit_system": "imperial" if hass.config.units is not None and hass.config.units.length_unit == "mi" else "metric",
            "domain": DOMAIN,
        },
        "radars": report_radars,
        "floors": floors,
        "spaces": [{"id": sp.id, "area_id": sp.area_id, "level": sp.level, "observed": sp.observed} for sp in spaces.values()],
        "doors": {d: rows.get(d, []) for d in doors},
        "door_kinds": {d: hc._door_kind.get(d, "door") for d in doors},
        "outside_doors": outside,
        "evidence": {e: rows.get(e, []) for e in evidence},
        "evidence_areas": {e: [hc._evidence[e][0], hc._evidence[e][1]] for e in evidence if e in hc._evidence},
        "occupancy": {e: rows.get(e, []) for e in occupancy},
        "occupancy_areas": {e: r for e, r in hc._occupancy.items()},
        "vacuums": {e: rows.get(e, []) for e in vacuums},
        "activity": activity,
        "activity_before": {**before, "t": sh(before["t"])} if before else None,
        "zone_events": {eid: rows.get(eid, []) for eid in zone_ids.values()},
    }
    return al.apply(report)
