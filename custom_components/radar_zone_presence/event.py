"""Exit passages: someone came in or left through an entry/exit point (doorway, stairs)."""

from __future__ import annotations

from typing import Any

from homeassistant.components.event import EventEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from .devices import radar_device_info
from .home import HomeRuntime, RadarFeed
from .engine import Zone


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddConfigEntryEntitiesCallback
) -> None:
    runtime: HomeRuntime = entry.runtime_data
    dev_reg = dr.async_get(hass)
    for feed in runtime.feeds.values():
        if not feed.exits:
            continue
        info = radar_device_info(feed, dev_reg.async_get(feed.device_id))
        async_add_entities([ExitPassageEvent(runtime, feed, z, info) for z in feed.exits], config_subentry_id=feed.id)


class ExitPassageEvent(EventEntity):
    _attr_has_entity_name = True
    _attr_should_poll = False
    _attr_event_types = ["arrived", "left"]
    _attr_translation_key = "passage"

    def __init__(self, runtime: HomeRuntime, feed: RadarFeed, zone: Zone, device_info: dr.DeviceInfo) -> None:
        self.runtime = runtime
        self.exit_id = f"{feed.id}:{zone.id}"
        self._attr_unique_id = passage_unique_id(feed.id, zone.id)
        self._attr_device_info = device_info
        self._attr_translation_placeholders = {"exit": zone.name}

    async def async_added_to_hass(self) -> None:
        self.async_on_remove(self.runtime.async_add_passage_listener(self.exit_id, self._on_passage))

    @callback
    def _on_passage(self, kind: str, attrs: dict[str, Any]) -> None:
        self._trigger_event(kind, attrs)
        self.async_write_ha_state()


def passage_unique_id(radar_id: str, exit_id: str) -> str:
    return f"{radar_id}_{exit_id}_passage"
