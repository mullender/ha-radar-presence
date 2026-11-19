"""Occupancy binary sensors of each zone's presence device."""

from __future__ import annotations

from typing import Any

from homeassistant.components.binary_sensor import BinarySensorDeviceClass, BinarySensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from .entity import ZoneEntity
from .home import HomeRuntime, ZoneDef


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddConfigEntryEntitiesCallback
) -> None:
    runtime: HomeRuntime = entry.runtime_data
    for zd in runtime.zones.values():
        entities: list[ZoneEntity] = [ZonePresenceSensor(runtime, zd)]
        coverage = runtime.coverage(zd.zone.id)
        if len(coverage) > 1:  # seen by several radars: show which ones see someone
            entities += [ZoneSeenBySensor(runtime, zd, rid) for rid in coverage]
        async_add_entities(entities, config_subentry_id=zd.subentry_id)


class ZonePresenceSensor(ZoneEntity, BinarySensorEntity):
    _attr_device_class = BinarySensorDeviceClass.OCCUPANCY  # Detected / Clear (presence means home / away)
    _attr_translation_key = "occupancy"  # "Desk Occupancy"

    def __init__(self, runtime: HomeRuntime, zd: ZoneDef) -> None:
        super().__init__(runtime, zd)
        self._update_from_snapshot()

    def _update_from_snapshot(self) -> bool:
        zs = self.group.snapshot.zones.get(self.zone.id)
        if zs is None:
            return False
        attrs: dict[str, Any] = {"target_count": zs.count, "zone_id": self.zone.id}
        if self.zone.filters.hold_until_exit:
            attrs["held"] = zs.held  # occupants that went still inside and were not seen leaving
        changed = zs.occupied != self._attr_is_on or attrs != self._attr_extra_state_attributes
        self._attr_is_on = zs.occupied
        self._attr_extra_state_attributes = attrs
        return changed


class ZoneSeenBySensor(ZoneEntity, BinarySensorEntity):
    """Diagnostic: this radar currently sees someone in the zone (before delays and holds)."""

    _attr_device_class = BinarySensorDeviceClass.OCCUPANCY
    _attr_entity_category = EntityCategory.DIAGNOSTIC
    _attr_translation_key = "seen_by"

    def __init__(self, runtime: HomeRuntime, zd: ZoneDef, radar_id: str) -> None:
        super().__init__(runtime, zd, f"seen_{radar_id}")
        self.radar_id = radar_id
        self._attr_translation_placeholders = {"radar": runtime.feeds[radar_id].title}
        self._update_from_snapshot()

    @property
    def available(self) -> bool:
        return self.runtime.feeds[self.radar_id].available

    def _update_from_snapshot(self) -> bool:
        on = self.radar_id in self.group.seen_by(self.zone.id)
        changed = on != self._attr_is_on
        self._attr_is_on = on
        return changed
