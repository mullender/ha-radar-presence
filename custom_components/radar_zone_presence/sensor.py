"""Count sensors: per-zone target count (disabled by default), excluded targets."""

from __future__ import annotations

from homeassistant.components.sensor import SensorEntity, SensorStateClass
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from .engine import KIND_INCLUDE, Zone
from .entity import RadarEntity
from .runtime import RadarRuntime


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddConfigEntryEntitiesCallback
) -> None:
    runtime: RadarRuntime = entry.runtime_data
    entities: list[SensorEntity] = [ExcludedTargetsSensor(runtime, entry)]
    entities += [ZoneTargetCountSensor(runtime, entry, z) for z in runtime.zones if z.kind == KIND_INCLUDE]
    async_add_entities(entities)


class ZoneTargetCountSensor(RadarEntity, SensorEntity):
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_entity_registry_enabled_default = False
    _attr_translation_key = "zone_targets"
    _attr_icon = "mdi:account-multiple"

    def __init__(self, runtime: RadarRuntime, entry: ConfigEntry, zone: Zone) -> None:
        super().__init__(runtime, entry, f"{zone.id}_targets")
        self.zone = zone
        self._attr_translation_placeholders = {"zone": zone.name}
        self._update_from_snapshot()

    def _update_from_snapshot(self) -> bool:
        zs = self.runtime.snapshot.zones.get(self.zone.id)
        value = zs.count if zs else None
        changed = value != self._attr_native_value
        self._attr_native_value = value
        return changed


class ExcludedTargetsSensor(RadarEntity, SensorEntity):
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_entity_category = EntityCategory.DIAGNOSTIC
    _attr_translation_key = "excluded_targets"
    _attr_icon = "mdi:account-cancel"

    def __init__(self, runtime: RadarRuntime, entry: ConfigEntry) -> None:
        super().__init__(runtime, entry, "excluded_targets")
        self._update_from_snapshot()

    def _update_from_snapshot(self) -> bool:
        value = self.runtime.snapshot.excluded_count
        changed = value != self._attr_native_value
        self._attr_native_value = value
        return changed
