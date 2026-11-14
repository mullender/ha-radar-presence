"""Config entry diagnostics."""

from __future__ import annotations

from dataclasses import asdict
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from .discovery import async_device_geometry
from .runtime import RadarRuntime


async def async_get_config_entry_diagnostics(hass: HomeAssistant, entry: ConfigEntry) -> dict[str, Any]:
    runtime: RadarRuntime = entry.runtime_data
    frame = runtime.last_frame
    snap = runtime.snapshot
    return {
        "data": dict(entry.data),
        "options": dict(entry.options),
        "units": runtime.units,
        "states": {eid: (st.state if (st := hass.states.get(eid)) else None) for eid in runtime.entity_ids},
        "last_frame": asdict(frame) if frame else None,
        "snapshot": {
            "presence": snap.presence,
            "target_count": snap.target_count,
            "excluded_count": snap.excluded_count,
            "suppressed": snap.suppressed,
            "zones": {k: asdict(v) for k, v in snap.zones.items()},
        },
        "device_geometry": async_device_geometry(hass, entry.data["device_id"]),
    }
