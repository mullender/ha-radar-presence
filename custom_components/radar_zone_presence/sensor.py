"""Per-zone target count (disabled by default), on the zone's presence device."""

from __future__ import annotations

from homeassistant.components.sensor import SensorEntity, SensorStateClass
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from .engine import KIND_INCLUDE, Zone
from .entity import RadarEntity
from .runtime import RadarRuntime


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddConfigEntryEntitiesCallback
) -> None:
    runtime: RadarRuntime = entry.runtime_data
    async_add_entities(ZoneTargetCountSensor(runtime, entry, z) for z in runtime.zones if z.kind == KIND_INCLUDE)


class ZoneTargetCountSensor(RadarEntity, SensorEntity):
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_entity_registry_enabled_default = False
    _attr_translation_key = "zone_targets"
    _attr_icon = "mdi:account-multiple"

    def __init__(self, runtime: RadarRuntime, entry: ConfigEntry, zone: Zone) -> None:
        super().__init__(runtime, entry, f"{zone.id}_targets", zone)
        self.zone = zone
        self._update_from_snapshot()

    def _update_from_snapshot(self) -> bool:
        zs = self.runtime.snapshot.zones.get(self.zone.id)
        value = zs.count if zs else None
        changed = value != self._attr_native_value
        self._attr_native_value = value
        return changed
