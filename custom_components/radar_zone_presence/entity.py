"""Shared entity base for the entities of a zone's presence device."""

from __future__ import annotations

from homeassistant.helpers.entity import Entity

from .devices import zone_device_info
from .home import GroupRuntime, HomeRuntime, ZoneDef


class ZoneEntity(Entity):
    """Entity of a zone's presence device, updated by the zone's group engine."""

    _attr_has_entity_name = True
    _attr_should_poll = False

    def __init__(self, runtime: HomeRuntime, zd: ZoneDef, key: str | None = None) -> None:
        self.runtime = runtime
        self.zone = zd.zone
        self.group: GroupRuntime = runtime.zone_group(zd.zone.id)
        self._attr_unique_id = zd.zone.id if key is None else f"{zd.zone.id}_{key}"
        radar = runtime.feeds[zd.radar_id]
        self._attr_device_info = zone_device_info(zd.zone, zd.radar_id, radar.device_id, zd.spot)

    @property
    def available(self) -> bool:
        """Unavailable while every radar of the zone's group is unavailable."""
        return self.group.available

    async def async_added_to_hass(self) -> None:
        self.async_on_remove(self.runtime.async_add_entity_listener(self.group, self._handle_update))

    def _handle_update(self) -> None:
        available = self.available
        if self._update_from_snapshot() or available != getattr(self, "_last_available", None):
            self._last_available = available
            self.async_write_ha_state()

    def _update_from_snapshot(self) -> bool:
        """Refresh cached attributes; return True if anything changed."""
        raise NotImplementedError
