"""The head count's "Nobody home" button: everyone just left (or the count drifted), set the home to 0."""

from __future__ import annotations

from homeassistant.components.button import ButtonEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from .const import DOMAIN, MANUFACTURER, VERSION
from .headcount_runtime import HeadCountRuntime
from .home import HomeRuntime


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddConfigEntryEntitiesCallback
) -> None:
    runtime: HomeRuntime = entry.runtime_data
    if runtime.headcount.hc is not None:
        async_add_entities([NobodyHomeButton(entry, runtime.headcount)])


class NobodyHomeButton(ButtonEntity):
    """Press when the house is empty: clears every person from the head count (logged as a correction).
    Handy on a dashboard, or from an automation (an alarm armed away)."""

    _attr_has_entity_name = True
    _attr_translation_key = "nobody_home"
    _attr_icon = "mdi:home-export-outline"

    def __init__(self, entry: ConfigEntry, hc: HeadCountRuntime) -> None:
        self.hc = hc
        self._attr_unique_id = f"{entry.entry_id}_nobody_home"
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, f"home_{entry.entry_id}")},
            name=entry.title,
            manufacturer=MANUFACTURER,
            model="Head count",
            sw_version=VERSION,
        )

    async def async_press(self) -> None:
        self.hc.correct_home(0)
