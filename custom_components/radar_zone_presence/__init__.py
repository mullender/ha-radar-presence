"""Radar Presence: room and spot occupancy and occupant counts for LD2450-style radar sensors."""

from __future__ import annotations

import hashlib
import json
import logging
from pathlib import Path
from types import MappingProxyType
from typing import Any

from homeassistant.components import frontend, panel_custom
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry, ConfigSubentry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import config_validation as cv, device_registry as dr, entity_registry as er
from homeassistant.helpers.typing import ConfigType

from . import websocket_api
from .const import (
    CONF_IMPORT_ZONES,
    CONF_RADAR,
    CONF_TARGETS,
    CONF_UNIT,
    DOMAIN,
    PANEL_COMPONENT,
    PANEL_URL,
    STATIC_URL,
    SUBENTRY_RADAR,
    SUBENTRY_ZONE,
)
from .devices import zone_device_identifier
from .discovery import async_device_geometry, async_resolve_units, common_unit
from .event import passage_unique_id
from .home import HomeRuntime

_LOGGER = logging.getLogger(__name__)

PLATFORMS = [Platform.BINARY_SENSOR, Platform.BUTTON, Platform.EVENT, Platform.SENSOR]
FRONTEND_DIR = Path(__file__).parent / "frontend"

CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)

type HomeConfigEntry = ConfigEntry[HomeRuntime]


def _frontend_version() -> str:
    manifest = json.loads((Path(__file__).parent / "manifest.json").read_text())
    digest = hashlib.sha256()
    for path in sorted(FRONTEND_DIR.rglob("*.js")):
        digest.update(path.read_bytes())
    return f"{manifest['version']}-{digest.hexdigest()[:10]}"


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    websocket_api.async_register(hass)
    version = await hass.async_add_executor_job(_frontend_version)
    # The version is part of the path, not a query string: the panel's relative
    # imports (./util.js, ...) then resolve under it too, so an update can never
    # mix a new panel.js with cached old modules.
    base = f"{STATIC_URL}/{version}"
    await hass.http.async_register_static_paths([StaticPathConfig(base, str(FRONTEND_DIR), cache_headers=True)])
    await panel_custom.async_register_panel(
        hass,
        frontend_url_path=PANEL_URL,
        webcomponent_name=PANEL_COMPONENT,
        sidebar_title="Presence",
        sidebar_icon="mdi:radar",
        module_url=f"{base}/panel.js",
        require_admin=True,
        config={"version": version},
    )
    # Dashboard card (custom:radar-zone-presence-card), loaded on every frontend page.
    frontend.add_extra_js_url(hass, f"{base}/card.js")
    return True


async def async_setup_entry(hass: HomeAssistant, entry: HomeConfigEntry) -> bool:
    # Runs before the update listener is registered, so these updates do not reload.
    _remember_units(hass, entry)
    _import_legacy_zones(hass, entry)
    runtime = HomeRuntime(hass, entry)
    for rid, feed in runtime.feeds.items():
        runtime.set_max_distance(rid, async_device_geometry(hass, feed.device_id)["max_distance_mm"])
    entry.runtime_data = runtime
    _remove_stale_entities(hass, entry, runtime)
    runtime.async_start()
    entry.async_on_unload(runtime.async_stop)
    await runtime.headcount.async_start()
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    _sync_zone_areas(hass, runtime)
    entry.async_on_unload(entry.add_update_listener(_async_entry_updated))
    return True


async def async_unload_entry(hass: HomeAssistant, entry: HomeConfigEntry) -> bool:
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)


async def _async_entry_updated(hass: HomeAssistant, entry: HomeConfigEntry) -> None:
    """Reload once for a batch of changes (the panel saves several subentries at a time)."""
    runtime = entry.runtime_data
    if runtime.reload_scheduled:
        return
    runtime.reload_scheduled = True
    hass.config_entries.async_schedule_reload(entry.entry_id)


@callback
def _remember_units(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Store each radar's coordinate unit so restarts with unit-less states still convert correctly."""
    for sub in list(entry.subentries.values()):
        if sub.subentry_type != SUBENTRY_RADAR:
            continue
        ids = [e for t in sub.data[CONF_TARGETS] for e in (t["x"], t["y"])]
        unit = common_unit(async_resolve_units(hass, ids, sub.data.get(CONF_UNIT)))
        if unit and unit != sub.data.get(CONF_UNIT):
            hass.config_entries.async_update_subentry(entry, sub, data={**sub.data, CONF_UNIT: unit})


@callback
def _import_legacy_zones(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Polygons picked up by the radar subentry flow become zone subentries on the first setup."""
    for sub in list(entry.subentries.values()):
        if sub.subentry_type != SUBENTRY_RADAR or not sub.data.get(CONF_IMPORT_ZONES):
            continue
        for z in sub.data[CONF_IMPORT_ZONES]:
            add_zone_subentry(hass, entry, {**z, CONF_RADAR: sub.subentry_id})
        hass.config_entries.async_update_subentry(
            entry, sub, data={k: v for k, v in sub.data.items() if k != CONF_IMPORT_ZONES}
        )


@callback
def add_zone_subentry(hass: HomeAssistant, entry: ConfigEntry, zone: dict[str, Any]) -> None:
    data = {k: v for k, v in zone.items() if k != "kind"}
    hass.config_entries.async_add_subentry(
        entry, ConfigSubentry(data=MappingProxyType(data), subentry_type=SUBENTRY_ZONE, title=data["name"], unique_id=data["id"])
    )


@callback
def _remove_stale_entities(hass: HomeAssistant, entry: ConfigEntry, runtime: HomeRuntime) -> None:
    """Drop entities that are no longer created (e.g. a radar no longer covers a zone)."""
    expected: set[str] = set()
    for zid in runtime.zones:
        expected |= {zid, f"{zid}_targets"}
        coverage = runtime.coverage(zid)
        if len(coverage) > 1:
            expected |= {f"{zid}_seen_{rid}" for rid in coverage}
    for rid, feed in runtime.feeds.items():
        expected |= {passage_unique_id(rid, z.id) for z in feed.exits}
    expected |= runtime.headcount.unique_ids()
    ent_reg = er.async_get(hass)
    for e in er.async_entries_for_config_entry(ent_reg, entry.entry_id):
        if e.unique_id not in expected:
            _LOGGER.debug("Removing stale entity %s", e.entity_id)
            ent_reg.async_remove(e.entity_id)
    # A radar whose exits were all removed no longer needs its (exits) device.
    dev_reg = dr.async_get(hass)
    keep = {(DOMAIN, f"radar_{f.device_id}") for f in runtime.feeds.values() if f.exits}
    for device in dr.async_entries_for_config_entry(dev_reg, entry.entry_id):
        ours = {i for i in device.identifiers if i[0] == DOMAIN and i[1].startswith("radar_")}
        if ours and not ours & keep:
            dev_reg.async_remove_device(device.id)


@callback
def _sync_zone_areas(hass: HomeAssistant, runtime: HomeRuntime) -> None:
    """Zone presence devices live in an area: the zone's own, or by default the radar's.

    An area chosen in the panel is applied to the device; without one, a new
    device starts in the radar's area and is then left alone (it can be moved
    in HA like any device).
    """
    dev_reg = dr.async_get(hass)
    for zd in runtime.zones.values():
        device = dev_reg.async_get_device_by_identifier(zone_device_identifier(zd.zone.id), runtime.entry.entry_id)
        if device is None:
            continue
        radar = dev_reg.async_get(runtime.feeds[zd.radar_id].device_id)
        want = zd.zone.area_id or (device.area_id or (radar.area_id if radar else None))
        if want != device.area_id:
            dev_reg.async_update_device(device.id, area_id=want)
