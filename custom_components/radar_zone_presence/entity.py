"""Shared entity base."""

from __future__ import annotations

from homeassistant.config_entries import ConfigEntry
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers.entity import Entity

from .const import CONF_DEVICE_ID
from .devices import zone_device_info
from .engine import Zone
from .runtime import RadarRuntime


class RadarEntity(Entity):
    """Entity of a zone's presence device (or the radar's own device), updated by the runtime."""

    _attr_has_entity_name = True
    _attr_should_poll = False

    def __init__(self, runtime: RadarRuntime, entry: ConfigEntry, key: str, zone: Zone | None = None) -> None:
        self.runtime = runtime
        self._attr_unique_id = f"{entry.entry_id}_{key}"
        radar = dr.async_get(runtime.hass).async_get(entry.data[CONF_DEVICE_ID])
        if zone is None:
            self.device_entry = radar  # helper pattern: attach to the radar's existing device
        else:
            self._attr_device_info = zone_device_info(entry, zone, radar.id if radar else None)

    @property
    def available(self) -> bool:
        """Unavailable while every coordinate entity of the radar is unavailable."""
        frame = self.runtime.last_frame
        return frame is None or frame.available

    async def async_added_to_hass(self) -> None:
        self.async_on_remove(self.runtime.async_add_entity_listener(self._handle_update))

    def _handle_update(self) -> None:
        available = self.available
        if self._update_from_snapshot() or available != getattr(self, "_last_available", None):
            self._last_available = available
            self.async_write_ha_state()

    def _update_from_snapshot(self) -> bool:
        """Refresh cached attributes; return True if anything changed."""
        raise NotImplementedError
