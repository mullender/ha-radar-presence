"""Shared fixtures."""

from __future__ import annotations

import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry

from homeassistant.core import HomeAssistant
from homeassistant.helpers import device_registry as dr, entity_registry as er

SLUG = "everything_presence_lite_abc123"


@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(enable_custom_integrations):
    yield


@pytest.fixture
def radar_device(hass: HomeAssistant) -> str:
    """A fake ESPHome-style EP Lite: 3 targets of X/Y sensors in inches."""
    source = MockConfigEntry(domain="esphome", title="EPL")
    source.add_to_hass(hass)
    dev_reg = dr.async_get(hass)
    ent_reg = er.async_get(hass)
    device = dev_reg.async_get_or_create(
        config_entry_id=source.entry_id,
        connections={(dr.CONNECTION_NETWORK_MAC, "aa:bb:cc:dd:ee:ff")},
        manufacturer="EverythingSmartTechnology",
        model="Everything Presence Lite",
        name="Everything Presence Lite abc123",
    )
    for n in (1, 2, 3):
        for axis in "xy":
            ent_reg.async_get_or_create(
                "sensor",
                "esphome",
                f"{SLUG}_t{n}{axis}",
                suggested_object_id=f"{SLUG}_target_{n}_{axis}",
                device_id=device.id,
                config_entry=source,
            )
            hass.states.async_set(f"sensor.{SLUG}_target_{n}_{axis}", "0.0", {"unit_of_measurement": "in"})
    ent_reg.async_get_or_create(
        "number", "esphome", f"{SLUG}_maxd", suggested_object_id=f"{SLUG}_max_distance",
        device_id=device.id, config_entry=source,
    )
    hass.states.async_set(f"number.{SLUG}_max_distance", "600", {"unit_of_measurement": "cm"})
    return device.id
