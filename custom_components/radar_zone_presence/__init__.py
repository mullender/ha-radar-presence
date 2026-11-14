"""Radar Zone Presence: polygon presence zones for LD2450-style radar sensors."""

from __future__ import annotations

import hashlib
import json
import logging
from pathlib import Path

from homeassistant.components import frontend, panel_custom
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import config_validation as cv, entity_registry as er
from homeassistant.helpers.typing import ConfigType

from . import websocket_api
from .const import CONF_TARGETS, CONF_UNIT, CONF_ZONES, DOMAIN, PANEL_COMPONENT, PANEL_URL, PRESENCE_KEY, STATIC_URL
from .discovery import async_resolve_units, common_unit
from .engine import KIND_INCLUDE
from .runtime import RadarRuntime

_LOGGER = logging.getLogger(__name__)

PLATFORMS = [Platform.BINARY_SENSOR, Platform.SENSOR]
FRONTEND_DIR = Path(__file__).parent / "frontend"

CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)

type RadarConfigEntry = ConfigEntry[RadarRuntime]


def _frontend_version() -> str:
    manifest = json.loads((Path(__file__).parent / "manifest.json").read_text())
    digest = hashlib.sha256()
    for path in sorted(FRONTEND_DIR.rglob("*.js")):
        digest.update(path.read_bytes())
    return f"{manifest['version']}-{digest.hexdigest()[:10]}"


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    websocket_api.async_register(hass)
    version = await hass.async_add_executor_job(_frontend_version)
    await hass.http.async_register_static_paths(
        [StaticPathConfig(STATIC_URL, str(FRONTEND_DIR), cache_headers=False)]
    )
    await panel_custom.async_register_panel(
        hass,
        frontend_url_path=PANEL_URL,
        webcomponent_name=PANEL_COMPONENT,
        sidebar_title="Radar Zones",
        sidebar_icon="mdi:radar",
        module_url=f"{STATIC_URL}/panel.js?v={version}",
        require_admin=True,
        config={"version": version},
    )
    # Dashboard card (custom:radar-zone-presence-card), loaded on every frontend page.
    frontend.add_extra_js_url(hass, f"{STATIC_URL}/card.js?v={version}")
    return True


async def async_setup_entry(hass: HomeAssistant, entry: RadarConfigEntry) -> bool:
    _remember_unit(hass, entry)
    runtime = RadarRuntime(hass, entry)
    entry.runtime_data = runtime
    _remove_stale_entities(hass, entry)
    runtime.async_start()
    entry.async_on_unload(runtime.async_stop)
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    _sync_zone_areas(hass, entry)
    entry.async_on_unload(entry.add_update_listener(_async_reload))
    return True


async def async_unload_entry(hass: HomeAssistant, entry: RadarConfigEntry) -> bool:
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)


async def _async_reload(hass: HomeAssistant, entry: RadarConfigEntry) -> None:
    await hass.config_entries.async_reload(entry.entry_id)


@callback
def _remember_unit(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Store the radar's coordinate unit so restarts with unit-less states still convert correctly."""
    ids = [e for t in entry.data[CONF_TARGETS] for e in (t["x"], t["y"])]
    unit = common_unit(async_resolve_units(hass, ids, entry.data.get(CONF_UNIT)))
    if unit and unit != entry.data.get(CONF_UNIT):
        # Runs before the update listener is registered, so this does not reload.
        hass.config_entries.async_update_entry(entry, data={**entry.data, CONF_UNIT: unit})


@callback
def _expected_unique_ids(entry: ConfigEntry) -> set[str]:
    p = entry.entry_id
    ids = {f"{p}_{PRESENCE_KEY}", f"{p}_excluded_targets"}
    for z in entry.options.get(CONF_ZONES, []):
        if z.get("kind", KIND_INCLUDE) == KIND_INCLUDE:
            ids |= {f"{p}_{z['id']}", f"{p}_{z['id']}_targets"}
    return ids


@callback
def _remove_stale_entities(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Drop entities of zones that were deleted or turned into exclusions."""
    ent_reg = er.async_get(hass)
    expected = _expected_unique_ids(entry)
    for e in er.async_entries_for_config_entry(ent_reg, entry.entry_id):
        if e.unique_id not in expected:
            _LOGGER.debug("Removing stale entity %s", e.entity_id)
            ent_reg.async_remove(e.entity_id)


@callback
def _sync_zone_areas(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Apply explicit per-zone area overrides (zones without one keep whatever the registry has)."""
    ent_reg = er.async_get(hass)
    p = entry.entry_id
    for z in entry.options.get(CONF_ZONES, []):
        if not z.get("area_id"):
            continue
        for uid in (f"{p}_{z['id']}", f"{p}_{z['id']}_targets"):
            eid = ent_reg.async_get_entity_id("binary_sensor" if not uid.endswith("_targets") else "sensor", DOMAIN, uid)
            if eid and (reg := ent_reg.async_get(eid)) and reg.area_id != z["area_id"]:
                ent_reg.async_update_entity(eid, area_id=z["area_id"])
