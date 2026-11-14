"""Config entry diagnostics."""

from __future__ import annotations

from dataclasses import asdict
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from .discovery import async_device_geometry
from .home import HomeRuntime


async def async_get_config_entry_diagnostics(hass: HomeAssistant, entry: ConfigEntry) -> dict[str, Any]:
    runtime: HomeRuntime = entry.runtime_data
    radars = {}
    for rid, feed in runtime.feeds.items():
        frame = feed.last_frame
        radars[rid] = {
            "title": feed.title,
            "units": feed.units,
            "states": {eid: (st.state if (st := hass.states.get(eid)) else None) for eid in sorted(feed.entity_ids)},
            "last_frame": asdict(frame) if frame else None,
            "excluded_count": feed.excluded_count,
            "suppressed": feed.suppressed,
            "group": runtime.group_of[rid].anchor,
            "device_geometry": async_device_geometry(hass, feed.device_id),
        }
    return {
        "options": dict(entry.options),
        "subentries": {sid: {"type": s.subentry_type, "title": s.title, "data": dict(s.data)} for sid, s in entry.subentries.items()},
        "radars": radars,
        "zones": {
            zid: {"snapshot": asdict(runtime.zone_group(zid).snapshot.zones[zid]), "coverage": runtime.coverage(zid)}
            for zid in runtime.zones
        },
    }
