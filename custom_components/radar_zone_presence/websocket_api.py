"""Websocket API used by the Radar Zones panel."""

from __future__ import annotations

from datetime import datetime, timedelta
from types import MappingProxyType
from typing import Any
from uuid import uuid4

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.config_entries import ConfigEntry, ConfigEntryState, ConfigSubentry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import area_registry as ar, device_registry as dr, entity_registry as er, floor_registry as fr
from homeassistant.util import dt as dt_util

from .const import (
    CONF_DEVICE_ID,
    CONF_DISPLAY,
    CONF_HEADCOUNT,
    CONF_PROFILE,
    CONF_RADAR,
    CONF_RECONNECT_GRACE,
    CONF_ZONES,
    DOMAIN,
    FOV_HALF_ANGLE_DEG,
    SUBENTRY_RADAR,
    SUBENTRY_ZONE,
)
from .devices import zone_device_identifier
from .discovery import async_device_geometry, async_find_radars, async_resolve_units, common_unit
from .engine import KIND_EXCLUDE, KIND_EXIT, KIND_INCLUDE, KIND_LINGER, KIND_TRANSIENT, validate_polygon
from .history import async_history_frames, async_zone_events
from .home import HomeRuntime, RadarView

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
        ws_headcount,
    ):
        websocket_api.async_register_command(hass, handler)


def _home(hass: HomeAssistant) -> ConfigEntry | None:
    entries = hass.config_entries.async_entries(DOMAIN)
    return entries[0] if entries else None


def _radar(hass: HomeAssistant, connection, msg) -> tuple[ConfigEntry, HomeRuntime, ConfigSubentry] | None:
    entry = _home(hass)
    sub = entry.subentries.get(msg["radar_id"]) if entry else None
    if entry is None or sub is None or sub.subentry_type != SUBENTRY_RADAR:
        connection.send_error(msg["id"], "not_found", "Unknown radar")
        return None
    if entry.state is not ConfigEntryState.LOADED or sub.subentry_id not in entry.runtime_data.feeds:
        connection.send_error(msg["id"], "not_loaded", "Radar is not loaded")
        return None
    return entry, entry.runtime_data, sub


def _zone_subentries(entry: ConfigEntry, radar_id: str | None = None) -> dict[str, ConfigSubentry]:
    """zone id -> zone subentry (of one radar, or all)."""
    return {
        s.data["id"]: s
        for s in entry.subentries.values()
        if s.subentry_type == SUBENTRY_ZONE and (radar_id is None or s.data.get(CONF_RADAR) == radar_id)
    }


def _zone_entity_ids(hass: HomeAssistant, zone_ids) -> dict[str, str]:
    """zone id -> occupancy binary_sensor entity_id."""
    ent_reg = er.async_get(hass)
    return {zid: eid for zid in zone_ids if (eid := ent_reg.async_get_entity_id("binary_sensor", DOMAIN, zid))}


def _target_unit(hass: HomeAssistant, runtime: HomeRuntime, radar_id: str) -> str | None:
    feed = runtime.feeds[radar_id]
    return common_unit(async_resolve_units(hass, feed.entity_ids, feed.unit_fallback))


@websocket_api.require_admin
@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/list"})
@callback
def ws_list(hass: HomeAssistant, connection, msg) -> None:
    dev_reg = dr.async_get(hass)
    area_reg = ar.async_get(hass)
    floor_reg = fr.async_get(hass)
    entry = _home(hass)
    configured = set()
    radars = []
    if entry is not None:
        loaded = entry.state is ConfigEntryState.LOADED
        runtime: HomeRuntime | None = entry.runtime_data if loaded else None
        zones = _zone_subentries(entry)
        for sid, sub in entry.subentries.items():
            if sub.subentry_type != SUBENTRY_RADAR:
                continue
            configured.add(sub.data[CONF_DEVICE_ID])
            device = dev_reg.async_get(sub.data[CONF_DEVICE_ID])
            area = area_reg.async_get_area(device.area_id) if device and device.area_id else None
            floor = floor_reg.async_get_floor(area.floor_id) if area and area.floor_id else None
            group = runtime.group_of.get(sid) if runtime else None
            radars.append(
                {
                    "radar_id": sid,
                    "title": sub.title,
                    "device_id": sub.data[CONF_DEVICE_ID],
                    "area": area.name if area else None,
                    "floor_id": floor.floor_id if floor else None,
                    "floor": floor.name if floor else None,
                    "floor_level": floor.level if floor else None,
                    "profile": sub.data.get(CONF_PROFILE),
                    "loaded": runtime is not None and sid in runtime.feeds,
                    "group": group.anchor if group else sid,
                    "zone_count": len(sub.data.get(CONF_ZONES, []))
                    + sum(1 for z in zones.values() if z.data.get(CONF_RADAR) == sid),
                }
            )
    unconfigured = [
        {"device_id": r.device_id, "name": r.name, "profile": r.profile}
        for r in async_find_radars(hass)
        if r.device_id not in configured
    ]
    home = {"entry_id": entry.entry_id, "title": entry.title} if entry else None
    connection.send_result(msg["id"], {"home": home, "radars": radars, "unconfigured": unconfigured})


@websocket_api.require_admin
@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/config", vol.Required("radar_id"): str})
@callback
def ws_config(hass: HomeAssistant, connection, msg) -> None:
    if (found := _radar(hass, connection, msg)) is None:
        return
    entry, runtime, sub = found
    rid = sub.subentry_id
    feed = runtime.feeds[rid]
    dev_reg = dr.async_get(hass)
    device = dev_reg.async_get(feed.device_id)
    geometry = async_device_geometry(hass, feed.device_id)
    zone_subs = _zone_subentries(entry, rid)
    entity_ids = _zone_entity_ids(hass, zone_subs)
    zones = []
    for zid, zsub in zone_subs.items():
        z = {k: v for k, v in zsub.data.items() if k != CONF_RADAR}
        zdev = dev_reg.async_get_device_by_identifier(zone_device_identifier(zid), entry.entry_id)
        seen_by = [runtime.feeds[r].title for r in runtime.coverage(zid)] if zid in runtime.zones else []
        zones.append(
            {
                **z,
                "kind": KIND_INCLUDE,
                "entity_id": entity_ids.get(zid),
                "device_id": zdev.id if zdev else None,
                "registry_area_id": zdev.area_id if zdev else None,
                "seen_by": seen_by,
            }
        )
    zones += [dict(z) for z in sub.data.get(CONF_ZONES, [])]
    group = runtime.group_of[rid]
    connection.send_result(
        msg["id"],
        {
            "radar_id": rid,
            "home_entry_id": entry.entry_id,
            "title": sub.title,
            "device_id": feed.device_id,
            "device_area_id": device.area_id if device else None,
            "profile": sub.data.get(CONF_PROFILE),
            "targets": [{"slot": t.slot, "x": t.x, "y": t.y} for t in feed.targets],
            "target_unit": _target_unit(hass, runtime, rid),
            "zones": zones,
            "settings": {
                CONF_RECONNECT_GRACE: entry.options.get(CONF_RECONNECT_GRACE, 0),
                CONF_DISPLAY: sub.data.get(CONF_DISPLAY, {}),
                CONF_HEADCOUNT: sub.data.get(CONF_HEADCOUNT, True),
            },
            "group": {"anchor": group.anchor, "members": [f.id for f in group.feeds]},
            "fov": {"half_angle_deg": FOV_HALF_ANGLE_DEG, "max_distance_mm": geometry["max_distance_mm"]},
            "device_zones": geometry["device_zones"],
            "device_mounting": geometry["mounting"],
        },
    )


FILTERS_SCHEMA = vol.Schema(
    {
        vol.Optional("on_delay_s", default=0): vol.All(vol.Coerce(float), vol.Range(min=0, max=3600)),
        vol.Optional("off_delay_s", default=0): vol.All(vol.Coerce(float), vol.Range(min=0, max=3600)),
        vol.Optional("edge_margin_mm", default=0): vol.All(vol.Coerce(float), vol.Range(min=0, max=2000)),
        vol.Optional("hold_until_exit", default=False): bool,
        vol.Optional("hold_max_s", default=0): vol.All(vol.Coerce(float), vol.Range(min=0, max=86400)),
    }
)
ZONE_SCHEMA = vol.Schema(
    {
        vol.Optional("id"): vol.Any(None, str),
        vol.Required("name"): vol.All(str, vol.Strip, vol.Length(min=1, max=100)),
        vol.Required("kind"): vol.In([KIND_INCLUDE, KIND_EXCLUDE, KIND_EXIT, KIND_LINGER, KIND_TRANSIENT]),
        vol.Required("polygon"): [vol.ExactSequence([vol.Coerce(float), vol.Coerce(float)])],
        vol.Optional("filters", default={}): FILTERS_SCHEMA,
        vol.Optional("area_id"): vol.Any(None, str),
        vol.Optional("door_entity_id"): vol.Any(None, vol.All(str, vol.Match(r"^binary_sensor\.\w+$"))),
        # Exits: the areas this opening leads to, or "outside" (head count).
        vol.Optional("leads_to"): vol.Any(None, [vol.All(str, vol.Length(min=1, max=100))]),
        # Exits: a door in the threshold rectangle (drawing / analysis only).
        vol.Optional("door"): vol.Any(None, {vol.Required("swing"): vol.In(["none", "in", "out"]), vol.Optional("hinge_end", default=0): vol.In([0, 1])}),
    },
    extra=vol.REMOVE_EXTRA,
)


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/zones/save",
        vol.Required("radar_id"): str,
        vol.Required("zones"): [dict],
        vol.Optional("settings"): {
            vol.Optional(CONF_RECONNECT_GRACE): vol.All(vol.Coerce(float), vol.Range(min=0, max=600)),
            vol.Optional(CONF_DISPLAY): dict,
            vol.Optional(CONF_HEADCOUNT): bool,
        },
    }
)
@websocket_api.async_response
async def ws_save_zones(hass: HomeAssistant, connection, msg) -> None:
    """Save one radar's zones: include zones are zone subentries, exclusions and exits live on the radar."""
    if (found := _radar(hass, connection, msg)) is None:
        return
    entry, _runtime, sub = found
    rid = sub.subentry_id
    zones = []
    seen: set[str] = set()
    others = _zone_subentries(entry)
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
        owner = others.get(z["id"])
        if z["id"] in seen or (owner is not None and owner.data.get(CONF_RADAR) != rid):
            connection.send_error(msg["id"], "invalid_format", f"duplicate zone id {z['id']}")
            return
        seen.add(z["id"])
        z["polygon"] = [[round(p[0], 1), round(p[1], 1)] for p in z["polygon"]]
        z.setdefault("area_id", None)
        zones.append(z)

    current = _zone_subentries(entry, rid)
    dev_reg = dr.async_get(hass)
    radar_device = dev_reg.async_get(sub.data[CONF_DEVICE_ID])
    radar_zones = []
    for z in zones:
        if z["kind"] != KIND_INCLUDE:
            radar_zones.append(z)
            continue
        data = {k: v for k, v in z.items() if k not in ("kind", "door", "door_entity_id", "leads_to")} | {CONF_RADAR: rid}
        if (zsub := current.pop(z["id"], None)) is None:
            hass.config_entries.async_add_subentry(
                entry,
                ConfigSubentry(data=MappingProxyType(data), subentry_type=SUBENTRY_ZONE, title=z["name"], unique_id=z["id"]),
            )
            continue
        if z["area_id"] is None and zsub.data.get("area_id"):
            # Switched back to "same as the radar": move its presence device back now.
            if zdev := dev_reg.async_get_device_by_identifier(zone_device_identifier(z["id"]), entry.entry_id):
                dev_reg.async_update_device(zdev.id, area_id=radar_device.area_id if radar_device else None)
        hass.config_entries.async_update_subentry(entry, zsub, data=data, title=z["name"])
    for zsub in current.values():  # deleted, or turned into an exclusion / exit
        hass.config_entries.async_remove_subentry(entry, zsub.subentry_id)

    radar_data = {**sub.data, CONF_ZONES: radar_zones}
    settings = msg.get("settings", {})
    if CONF_DISPLAY in settings:
        radar_data[CONF_DISPLAY] = settings[CONF_DISPLAY]
    if CONF_HEADCOUNT in settings:
        radar_data[CONF_HEADCOUNT] = settings[CONF_HEADCOUNT]
    hass.config_entries.async_update_subentry(entry, sub, data=radar_data)
    if CONF_RECONNECT_GRACE in settings:
        hass.config_entries.async_update_entry(
            entry, options={**entry.options, CONF_RECONNECT_GRACE: settings[CONF_RECONNECT_GRACE]}
        )
    # The update listener reloads the home once for all of these changes.
    connection.send_result(msg["id"], {"zones": zones})


@websocket_api.require_admin
@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/headcount"})
@callback
def ws_headcount(hass: HomeAssistant, connection, msg) -> None:
    """The head count's spaces, connections, people (tokens) and recent changes."""
    entry = _home(hass)
    if entry is None or entry.state is not ConfigEntryState.LOADED:
        connection.send_error(msg["id"], "not_loaded", "The home is not loaded")
        return
    connection.send_result(msg["id"], entry.runtime_data.headcount.debug())


def _frame_message(view: RadarView) -> dict[str, Any]:
    snap = view.zones
    msg: dict[str, Any] = {
        "t": view.frame.t,
        "available": view.frame.available,
        "zones": {zid: [zs.occupied, zs.count, zs.held] for zid, zs in snap.zones.items() if ":" not in zid},
        "presence": bool(view.kept),
        "excluded": view.excluded_count,
        "suppressed": view.suppressed,
    }
    if view.fresh:  # otherwise only the zone states changed
        msg["targets"] = [[tg.slot, round(tg.x), round(tg.y)] for tg in view.frame.targets]
    return msg


@websocket_api.require_admin
@websocket_api.websocket_command(
    {vol.Required("type"): f"{DOMAIN}/frames/subscribe", vol.Required("radar_id"): str}
)
@callback
def ws_subscribe_frames(hass: HomeAssistant, connection, msg) -> None:
    if (found := _radar(hass, connection, msg)) is None:
        return
    _entry, runtime, sub = found
    rid = sub.subentry_id

    @callback
    def forward(view: RadarView) -> None:
        connection.send_message(websocket_api.event_message(msg["id"], _frame_message(view)))

    @callback
    def closed() -> None:
        # The home is reloading (zones saved): tell the panel to resubscribe.
        connection.send_message(websocket_api.event_message(msg["id"], {"closed": True}))

    unsubs = [runtime.async_add_frame_listener(rid, forward), runtime.async_add_close_listener(closed)]

    @callback
    def unsubscribe() -> None:
        for u in unsubs:
            u()

    connection.subscriptions[msg["id"]] = unsubscribe
    connection.send_result(msg["id"])
    if (view := runtime.radar_view(rid)) is not None:
        forward(view)


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
        vol.Required("radar_id"): str,
        vol.Required("start"): str,
        vol.Optional("end"): str,
    }
)
@websocket_api.async_response
async def ws_history_frames(hass: HomeAssistant, connection, msg) -> None:
    if (found := _radar(hass, connection, msg)) is None or _recorder_missing(hass, connection, msg):
        return
    try:
        start, end = _parse_range(msg)
    except ValueError as err:
        connection.send_error(msg["id"], "invalid_format", str(err))
        return
    feed = found[1].feeds[found[2].subentry_id]
    connection.send_result(msg["id"], await async_history_frames(hass, feed.targets, start, end, feed.unit_fallback))


@websocket_api.require_admin
@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/zone_events",
        vol.Required("radar_id"): str,
        vol.Required("start"): str,
        vol.Optional("end"): str,
    }
)
@websocket_api.async_response
async def ws_zone_events(hass: HomeAssistant, connection, msg) -> None:
    if (found := _radar(hass, connection, msg)) is None or _recorder_missing(hass, connection, msg):
        return
    try:
        start, end = _parse_range(msg)
    except ValueError as err:
        connection.send_error(msg["id"], "invalid_format", str(err))
        return
    entry, runtime, sub = found
    group = runtime.group_of[sub.subentry_id]  # zones of the whole group show up in this radar's view
    ids = _zone_entity_ids(hass, group.zone_defs)
    events = await async_zone_events(hass, list(ids.values()), start, end)
    by_zone = {zid: events.get(eid, []) for zid, eid in ids.items()}
    connection.send_result(msg["id"], {"start": start.timestamp(), "end": end.timestamp(), "zones": by_zone})
