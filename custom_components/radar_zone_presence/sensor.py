"""Per-zone target count (disabled by default), on the zone's presence device; the home's head count."""

from __future__ import annotations

from typing import Any

from homeassistant.components.sensor import SensorEntity, SensorStateClass
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from .const import DOMAIN, MANUFACTURER, VERSION
from .entity import ZoneEntity
from .headcount_runtime import HeadCountRuntime
from .home import HomeRuntime, ZoneDef


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddConfigEntryEntitiesCallback
) -> None:
    runtime: HomeRuntime = entry.runtime_data
    for zd in runtime.zones.values():
        async_add_entities([ZoneTargetCountSensor(runtime, zd)], config_subentry_id=zd.subentry_id)
    hc = runtime.headcount
    if hc.hc is not None:
        entities: list[PeopleSensor] = [HomePeopleSensor(entry, hc)]
        entities += [FloorPeopleSensor(entry, hc, level) for level in sorted(hc.floors)]
        entities += [SpacePeopleSensor(entry, hc, sid) for sid in hc.spaces]
        async_add_entities(entities)


class PeopleSensor(SensorEntity):
    """A head count: unknown while an exit door on its floor is in use."""

    _attr_has_entity_name = True
    _attr_should_poll = False
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_icon = "mdi:account-group"
    _attr_native_unit_of_measurement = "people"

    def __init__(self, entry: ConfigEntry, hc: HeadCountRuntime, key: str) -> None:
        self.hc = hc
        self._attr_unique_id = f"{entry.entry_id}_{key}"
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, f"home_{entry.entry_id}")},
            name=entry.title,
            manufacturer=MANUFACTURER,
            model="Head count",
            sw_version=VERSION,
        )
        self._update()

    async def async_added_to_hass(self) -> None:
        self.async_on_remove(self.hc.async_add_listener(self._handle))

    @callback
    def _handle(self) -> None:
        if self._update():
            self.async_write_ha_state()

    def _update(self) -> bool:
        value, attrs = self._value()
        changed = value != self._attr_native_value or attrs != self._attr_extra_state_attributes
        self._attr_native_value, self._attr_extra_state_attributes = value, attrs
        return changed

    def _value(self) -> tuple[int | None, dict[str, Any]]:
        raise NotImplementedError


class HomePeopleSensor(PeopleSensor):
    _attr_translation_key = "people_home"

    def __init__(self, entry: ConfigEntry, hc: HeadCountRuntime) -> None:
        super().__init__(entry, hc, "people")

    def _value(self) -> tuple[int | None, dict[str, Any]]:
        value = self.hc.home_count()
        attrs: dict[str, Any] = {"at_least": self.hc.known()} if value is None else {}
        return value, attrs


class FloorPeopleSensor(PeopleSensor):
    _attr_translation_key = "people_floor"

    def __init__(self, entry: ConfigEntry, hc: HeadCountRuntime, level: int) -> None:
        self.level = level
        floor_id, name = hc.floors[level]
        self._attr_translation_placeholders = {"floor": name}
        super().__init__(entry, hc, f"people_floor_{level}")
        self._attr_extra_state_attributes = {"floor_id": floor_id, "level": level}

    def _value(self) -> tuple[int | None, dict[str, Any]]:
        floor_id, _name = self.hc.floors[self.level]
        return self.hc.floor_count(self.level), {"floor_id": floor_id, "level": self.level}


class SpacePeopleSensor(PeopleSensor):
    _attr_translation_key = "people_space"

    def __init__(self, entry: ConfigEntry, hc: HeadCountRuntime, space_id: str) -> None:
        self.space_id = space_id
        sp = hc.spaces[space_id]
        self._attr_translation_placeholders = {"space": sp.name}
        super().__init__(entry, hc, f"people_{space_id}")

    def _value(self) -> tuple[int | None, dict[str, Any]]:
        sp = self.hc.spaces[self.space_id]
        return self.hc.space_count(self.space_id), {"area_id": sp.area_id, "radar": sp.observed}


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
