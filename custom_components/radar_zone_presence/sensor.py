"""Per-zone target count (disabled by default), on the zone's presence device."""

from __future__ import annotations

from homeassistant.components.sensor import SensorEntity, SensorStateClass
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from .entity import ZoneEntity
from .home import HomeRuntime, ZoneDef


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddConfigEntryEntitiesCallback
) -> None:
    runtime: HomeRuntime = entry.runtime_data
    for zd in runtime.zones.values():
        async_add_entities([ZoneTargetCountSensor(runtime, zd)], config_subentry_id=zd.subentry_id)


class ZoneTargetCountSensor(ZoneEntity, SensorEntity):
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_entity_registry_enabled_default = False
    _attr_translation_key = "zone_targets"
    _attr_icon = "mdi:account-multiple"

    def __init__(self, runtime: HomeRuntime, zd: ZoneDef) -> None:
        super().__init__(runtime, zd, "targets")
        self._update_from_snapshot()

    def _update_from_snapshot(self) -> bool:
        zs = self.group.snapshot.zones.get(self.zone.id)
        value = zs.count if zs else None
        changed = value != self._attr_native_value
        self._attr_native_value = value
        return changed
