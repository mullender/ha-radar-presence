"""Presence binary sensors: one per include zone, plus the sensor-wide catch-all."""

from __future__ import annotations

from typing import Any

from homeassistant.components.binary_sensor import BinarySensorDeviceClass, BinarySensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from .const import PRESENCE_KEY
from .engine import KIND_INCLUDE, Zone
from .entity import RadarEntity
from .runtime import RadarRuntime


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddConfigEntryEntitiesCallback
) -> None:
    runtime: RadarRuntime = entry.runtime_data
    entities: list[BinarySensorEntity] = [RadarPresenceSensor(runtime, entry)]
    entities += [ZonePresenceSensor(runtime, entry, z) for z in runtime.zones if z.kind == KIND_INCLUDE]
    async_add_entities(entities)


class ZonePresenceSensor(RadarEntity, BinarySensorEntity):
    _attr_device_class = BinarySensorDeviceClass.PRESENCE

    def __init__(self, runtime: RadarRuntime, entry: ConfigEntry, zone: Zone) -> None:
        super().__init__(runtime, entry, zone.id)
        self.zone = zone
        self._attr_name = zone.name
        self._attr_icon = "mdi:vector-polygon"
        self._update_from_snapshot()

    def _update_from_snapshot(self) -> bool:
        zs = self.runtime.snapshot.zones.get(self.zone.id)
        if zs is None:
            return False
        attrs: dict[str, Any] = {"target_count": zs.count, "targets": list(zs.slots), "zone_id": self.zone.id}
        if self.zone.filters.hold_until_exit:
            attrs["held"] = zs.held  # occupants that went still inside and were not seen leaving
        changed = zs.occupied != self._attr_is_on or attrs != self._attr_extra_state_attributes
        self._attr_is_on = zs.occupied
        self._attr_extra_state_attributes = attrs
        return changed


class RadarPresenceSensor(RadarEntity, BinarySensorEntity):
    """Any target that is not inside an exclusion zone."""

    _attr_device_class = BinarySensorDeviceClass.PRESENCE
    _attr_translation_key = "radar_presence"

    def __init__(self, runtime: RadarRuntime, entry: ConfigEntry) -> None:
        super().__init__(runtime, entry, PRESENCE_KEY)
        self._attr_extra_state_attributes = {}
        self._update_from_snapshot()

    def _update_from_snapshot(self) -> bool:
        snap = self.runtime.snapshot
        attrs = {
            "target_count": snap.target_count,
            "excluded_count": snap.excluded_count,
            "suppressed": snap.suppressed,
        }
        changed = snap.presence != self._attr_is_on or attrs != self._attr_extra_state_attributes
        self._attr_is_on = snap.presence
        self._attr_extra_state_attributes = attrs
        return changed
