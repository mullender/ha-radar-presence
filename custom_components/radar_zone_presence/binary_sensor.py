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
    hc = runtime.headcount
    if hc.hc is not None:
        async_add_entities(
            [SpaceOccupancySensor(entry, runtime, sid) for sid in hc.area_spaces() if runtime.room_zone(hc.spaces[sid].area_id) is None]
        )
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

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        if not self.runtime.seen(self.zone.id):  # no radar sees this room: its occupancy follows its occupant count
            self.async_on_remove(self.runtime.headcount.async_add_listener(self._handle_update))

    def _update_from_snapshot(self) -> bool:
        if not self.runtime.seen(self.zone.id):
            area = self.zone.area_id or self.runtime.zone_area(self.zone.id)
            n = self.runtime.headcount.area_count(area) if area else None
            on = None if n is None else n > 0
            attrs = {"zone_id": self.zone.id, "from_occupants": True}
            changed = on != self._attr_is_on or attrs != self._attr_extra_state_attributes
            self._attr_is_on, self._attr_extra_state_attributes = on, attrs
            return changed
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


class SpaceOccupancySensor(BinarySensorEntity):
    """A room no shape stands for (no radar): occupied while its occupant count is above 0."""

    _attr_has_entity_name = True
    _attr_should_poll = False
    _attr_device_class = BinarySensorDeviceClass.OCCUPANCY
    _attr_translation_key = "occupancy"

    def __init__(self, entry: ConfigEntry, runtime: HomeRuntime, space_id: str) -> None:
        from .devices import area_device_info

        self.hc = runtime.headcount
        self.space_id = space_id
        sp = self.hc.spaces[space_id]
        self._attr_unique_id = f"{entry.entry_id}_occupied_{space_id}"
        self._attr_device_info = area_device_info(sp.area_id, sp.name)
        self._update()

    async def async_added_to_hass(self) -> None:
        self.async_on_remove(self.hc.async_add_listener(self._handle))

    def _handle(self) -> None:
        if self._update():
            self.async_write_ha_state()

    def _update(self) -> bool:
        n = self.hc.space_count(self.space_id)
        on = None if n is None else n > 0
        changed = on != self._attr_is_on
        self._attr_is_on = on
        self._attr_extra_state_attributes = {"from_occupants": True}
        return changed
