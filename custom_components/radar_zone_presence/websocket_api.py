"""Websocket API used by the Radar Zones panel."""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any
from uuid import uuid4

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.config_entries import ConfigEntry, ConfigEntryState
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import area_registry as ar, device_registry as dr, entity_registry as er
from homeassistant.util import dt as dt_util

from .const import (
    CONF_DEVICE_ID,
    CONF_DISPLAY,
    CONF_PROFILE,
    CONF_RECONNECT_GRACE,
    CONF_ZONES,
    DOMAIN,
    FOV_HALF_ANGLE_DEG,
    PRESENCE_KEY,
)
from .discovery import async_device_geometry, async_find_radars, async_legacy_polygons, async_resolve_units
from .engine import KIND_EXCLUDE, KIND_INCLUDE, EngineSnapshot, Frame, validate_polygon
from .history import async_history_frames, async_zone_events
from .runtime import RadarRuntime

MAX_HISTORY = timedelta(days=14)


@callback
def async_register(hass: HomeAssistant) -> None:
    for handler in (
        ws_list,
        ws_config,
        ws_save_zones,
        ws_subscribe_frames,
        ws_history_frames,
        ws_zone_events,
    ):
        websocket_api.async_register_command(hass, handler)


def _entry(hass: HomeAssistant, connection, msg) -> ConfigEntry | None:
    entry = hass.config_entries.async_get_entry(msg["entry_id"])
    if entry is None or entry.domain != DOMAIN:
        connection.send_error(msg["id"], "not_found", "Unknown radar")
        return None
    if entry.state is not ConfigEntryState.LOADED:
        connection.send_error(msg["id"], "not_loaded", "Radar is not loaded")
        return None
    return entry


def _zone_entity_ids(hass: HomeAssistant, entry: ConfigEntry) -> dict[str, str]:
    """zone id (or 'presence') -> binary_sensor entity_id."""
    ent_reg = er.async_get(hass)
    out = {}
    prefix = f"{entry.entry_id}_"
    for e in er.async_entries_for_config_entry(ent_reg, entry.entry_id):
        if e.domain == "binary_sensor" and e.unique_id.startswith(prefix):
            out[e.unique_id.removeprefix(prefix)] = e.entity_id
    return out


def _target_unit(hass: HomeAssistant, runtime: RadarRuntime) -> str | None:
    units = [u for u in async_resolve_units(hass, runtime.entity_ids).values() if u]
    return max(set(units), key=units.count) if units else None


@websocket_api.require_admin
@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/list"})
@callback
def ws_list(hass: HomeAssistant, connection, msg) -> None:
    dev_reg = dr.async_get(hass)
    area_reg = ar.async_get(hass)
    configured = {}
    radars = []
    for entry in hass.config_entries.async_entries(DOMAIN):
        configured[entry.data[CONF_DEVICE_ID]] = entry.entry_id
        device = dev_reg.async_get(entry.data[CONF_DEVICE_ID])
        area = area_reg.async_get_area(device.area_id) if device and device.area_id else None
        radars.append(
            {
                "entry_id": entry.entry_id,
                "title": entry.title,
                "device_id": entry.data[CONF_DEVICE_ID],
                "area": area.name if area else None,
                "profile": entry.data.get(CONF_PROFILE),
                "loaded": entry.state is ConfigEntryState.LOADED,
                "zone_count": len(entry.options.get(CONF_ZONES, [])),
            }
        )
    unconfigured = [
        {"device_id": r.device_id, "name": r.name, "profile": r.profile}
        for r in async_find_radars(hass)
        if r.device_id not in configured
    ]
    connection.send_result(msg["id"], {"radars": radars, "unconfigured": unconfigured})


@websocket_api.require_admin
@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/config", vol.Required("entry_id"): str})
@callback
def ws_config(hass: HomeAssistant, connection, msg) -> None:
    if (entry := _entry(hass, connection, msg)) is None:
        return
    runtime: RadarRuntime = entry.runtime_data
    device_id = entry.data[CONF_DEVICE_ID]
    device = dr.async_get(hass).async_get(device_id)
    geometry = async_device_geometry(hass, device_id)
    unit = _target_unit(hass, runtime)
    slug = runtime.targets[0].x.split(".", 1)[1].rsplit("_target", 1)[0] if runtime.targets else ""
    entity_ids = _zone_entity_ids(hass, entry)
    ent_reg = er.async_get(hass)
    zones = []
    for z in entry.options.get(CONF_ZONES, []):
        eid = entity_ids.get(z["id"])
        reg = ent_reg.async_get(eid) if eid else None
        zones.append({**z, "entity_id": eid, "registry_area_id": reg.area_id if reg else None})
    connection.send_result(
        msg["id"],
        {
            "entry_id": entry.entry_id,
            "title": entry.title,
            "device_id": device_id,
            "device_area_id": device.area_id if device else None,
            "profile": entry.data.get(CONF_PROFILE),
            "targets": [{"slot": t.slot, "x": t.x, "y": t.y} for t in runtime.targets],
            "target_unit": unit,
            "zones": zones,
            "presence_entity_id": entity_ids.get(PRESENCE_KEY),
            "settings": {
                CONF_RECONNECT_GRACE: entry.options.get(CONF_RECONNECT_GRACE, 0),
                CONF_DISPLAY: entry.options.get(CONF_DISPLAY, {}),
            },
            "fov": {"half_angle_deg": FOV_HALF_ANGLE_DEG, "max_distance_mm": geometry["max_distance_mm"]},
            "device_zones": geometry["device_zones"],
            "legacy_polygons": async_legacy_polygons(hass, slug, unit),
        },
    )


FILTERS_SCHEMA = vol.Schema(
    {
        vol.Optional("on_delay_s", default=0): vol.All(vol.Coerce(float), vol.Range(min=0, max=3600)),
        vol.Optional("off_delay_s", default=0): vol.All(vol.Coerce(float), vol.Range(min=0, max=3600)),
        vol.Optional("edge_margin_mm", default=0): vol.All(vol.Coerce(float), vol.Range(min=0, max=2000)),
    }
)
ZONE_SCHEMA = vol.Schema(
    {
        vol.Optional("id"): vol.Any(None, str),
        vol.Required("name"): vol.All(str, vol.Strip, vol.Length(min=1, max=100)),
        vol.Required("kind"): vol.In([KIND_INCLUDE, KIND_EXCLUDE]),
        vol.Required("polygon"): [vol.ExactSequence([vol.Coerce(float), vol.Coerce(float)])],
        vol.Optional("filters", default={}): FILTERS_SCHEMA,
        vol.Optional("area_id"): vol.Any(None, str),
    },
    extra=vol.REMOVE_EXTRA,
)


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/zones/save",
        vol.Required("entry_id"): str,
        vol.Required("zones"): [dict],
        vol.Optional("settings"): {
            vol.Optional(CONF_RECONNECT_GRACE): vol.All(vol.Coerce(float), vol.Range(min=0, max=600)),
            vol.Optional(CONF_DISPLAY): dict,
        },
    }
)
@websocket_api.async_response
async def ws_save_zones(hass: HomeAssistant, connection, msg) -> None:
    if (entry := _entry(hass, connection, msg)) is None:
        return
    zones = []
    seen: set[str] = set()
    for i, raw in enumerate(msg["zones"]):
        try:
            z = ZONE_SCHEMA(raw)
        except vol.Invalid as err:
            connection.send_error(msg["id"], "invalid_format", f"zone {i + 1}: {err}")
            return
        if err := validate_polygon(z["polygon"]):
            connection.send_error(msg["id"], "invalid_polygon", f"{z['name']}: {err}")
            return
        z["id"] = z.get("id") or f"z{uuid4().hex[:10]}"
        if z["id"] in seen or z["id"] == PRESENCE_KEY:
            connection.send_error(msg["id"], "invalid_format", f"duplicate zone id {z['id']}")
            return
        seen.add(z["id"])
        z["polygon"] = [[round(p[0], 1), round(p[1], 1)] for p in z["polygon"]]
        z.setdefault("area_id", None)
        zones.append(z)

    # A zone switched back to "inherit": clear the override on its entities now.
    old = {z["id"]: z for z in entry.options.get(CONF_ZONES, [])}
    ent_reg = er.async_get(hass)
    for z in zones:
        if z["area_id"] is None and old.get(z["id"], {}).get("area_id"):
            for domain, suffix in (("binary_sensor", ""), ("sensor", "_targets")):
                eid = ent_reg.async_get_entity_id(domain, DOMAIN, f"{entry.entry_id}_{z['id']}{suffix}")
                if eid:
                    ent_reg.async_update_entity(eid, area_id=None)

    options = {**entry.options, CONF_ZONES: zones}
    for key, value in msg.get("settings", {}).items():
        options[key] = value
    hass.config_entries.async_update_entry(entry, options=options)  # update listener reloads the entry
    connection.send_result(msg["id"], {"zones": zones})


def _frame_message(frame: Frame, snap: EngineSnapshot) -> dict[str, Any]:
    return {
        "t": frame.t,
        "available": frame.available,
        "targets": [[tg.slot, round(tg.x), round(tg.y)] for tg in frame.targets],
        "zones": {zid: [zs.occupied, zs.count] for zid, zs in snap.zones.items()},
        "presence": snap.presence,
        "excluded": snap.excluded_count,
        "suppressed": snap.suppressed,
    }


@websocket_api.require_admin
@websocket_api.websocket_command(
    {vol.Required("type"): f"{DOMAIN}/frames/subscribe", vol.Required("entry_id"): str}
)
@callback
def ws_subscribe_frames(hass: HomeAssistant, connection, msg) -> None:
    if (entry := _entry(hass, connection, msg)) is None:
        return
    runtime: RadarRuntime = entry.runtime_data

    @callback
    def forward(frame: Frame, snap: EngineSnapshot) -> None:
        connection.send_message(websocket_api.event_message(msg["id"], _frame_message(frame, snap)))

    @callback
    def closed() -> None:
        # The entry is reloading (e.g. zones saved): tell the panel to resubscribe.
        connection.send_message(websocket_api.event_message(msg["id"], {"closed": True}))

    unsubs = [runtime.async_add_frame_listener(forward), runtime.async_add_close_listener(closed)]

    @callback
    def unsubscribe() -> None:
        for u in unsubs:
            u()

    connection.subscriptions[msg["id"]] = unsubscribe
    connection.send_result(msg["id"])
    if runtime.last_frame is not None:
        forward(runtime.last_frame, runtime.snapshot)


def _recorder_missing(hass: HomeAssistant, connection, msg) -> bool:
    if "recorder" not in hass.config.components:
        connection.send_error(msg["id"], "no_recorder", "The recorder integration is not loaded")
        return True
    return False


def _parse_range(msg) -> tuple[datetime, datetime]:
    end = dt_util.parse_datetime(msg["end"]) if msg.get("end") else dt_util.utcnow()
    start = dt_util.parse_datetime(msg["start"])
    if start is None or end is None or start >= end:
        raise ValueError("invalid time range")
    if end - start > MAX_HISTORY:
        start = end - MAX_HISTORY
    return start, end


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/frames/history",
        vol.Required("entry_id"): str,
        vol.Required("start"): str,
        vol.Optional("end"): str,
    }
)
@websocket_api.async_response
async def ws_history_frames(hass: HomeAssistant, connection, msg) -> None:
    if (entry := _entry(hass, connection, msg)) is None or _recorder_missing(hass, connection, msg):
        return
    try:
        start, end = _parse_range(msg)
    except ValueError as err:
        connection.send_error(msg["id"], "invalid_format", str(err))
        return
    runtime: RadarRuntime = entry.runtime_data
    connection.send_result(msg["id"], await async_history_frames(hass, runtime.targets, start, end))


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/zone_events",
        vol.Required("entry_id"): str,
        vol.Required("start"): str,
        vol.Optional("end"): str,
    }
)
@websocket_api.async_response
async def ws_zone_events(hass: HomeAssistant, connection, msg) -> None:
    if (entry := _entry(hass, connection, msg)) is None or _recorder_missing(hass, connection, msg):
        return
    try:
        start, end = _parse_range(msg)
    except ValueError as err:
        connection.send_error(msg["id"], "invalid_format", str(err))
        return
    ids = _zone_entity_ids(hass, entry)
    events = await async_zone_events(hass, list(ids.values()), start, end)
    by_zone = {zid: events.get(eid, []) for zid, eid in ids.items()}
    connection.send_result(msg["id"], {"start": start.timestamp(), "end": end.timestamp(), "zones": by_zone})
