"""Discovery of radar devices, device geometry and legacy polygons."""

from __future__ import annotations

import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry

from homeassistant.core import HomeAssistant
from homeassistant.helpers import device_registry as dr, entity_registry as er

from custom_components.radar_zone_presence.discovery import (
    async_device_geometry,
    async_find_radars,
    async_legacy_polygons,
)

SCREEK = "screek_human_sensor_2a_b3b6c4"


@pytest.fixture
def screek(hass: HomeAssistant) -> str:
    source = MockConfigEntry(domain="esphome")
    source.add_to_hass(hass)
    device = dr.async_get(hass).async_get_or_create(
        config_entry_id=source.entry_id,
        connections={(dr.CONNECTION_NETWORK_MAC, "11:22:33:44:55:66")},
        manufacturer="Screek",
        model="Human_Presence_Sensor",
        name="Human Sensor 2A b3b6c4",
    )
    ent_reg = er.async_get(hass)

    def add(domain: str, object_id: str, state: str, unit: str | None) -> None:
        ent_reg.async_get_or_create(domain, "esphome", object_id, suggested_object_id=object_id,
                                    device_id=device.id, config_entry=source)
        hass.states.async_set(f"{domain}.{object_id}", state, {"unit_of_measurement": unit} if unit else {})

    for n in (1, 2, 3):
        add("sensor", f"{SCREEK}_target{n}_x", "0", "in")
        add("sensor", f"{SCREEK}_target{n}_y", "0", "in")
        add("sensor", f"{SCREEK}_target{n}_speed", "0", "mph")  # must not be picked up
    # Firmware exclusion rectangle (Screek naming: zout1_x_begin) and an unused zone.
    for field, value in {"x_begin": 1016, "x_end": 2540, "y_begin": 0, "y_end": 5080}.items():
        add("number", f"{SCREEK}_zout1_{field}", str(value), "mm")
    for field in ("x_begin", "x_end", "y_begin", "y_end"):
        add("number", f"{SCREEK}_zone1_{field}", "0", "mm")
    return device.id


async def test_find_screek(hass: HomeAssistant, screek: str) -> None:
    (radar,) = async_find_radars(hass)
    assert radar.device_id == screek
    assert radar.profile == "screek_2a"
    assert radar.slug == SCREEK
    assert [(t.slot, t.x, t.y) for t in radar.targets] == [
        (n, f"sensor.{SCREEK}_target{n}_x", f"sensor.{SCREEK}_target{n}_y") for n in (1, 2, 3)
    ]


async def test_device_geometry(hass: HomeAssistant, screek: str) -> None:
    geo = async_device_geometry(hass, screek)
    assert geo["max_distance_mm"] == 6000  # default when the device has no max_distance number
    (zone,) = geo["device_zones"]  # the all-zero zone1 is skipped
    assert zone["key"] == "zout1" and zone["kind"] == "exclude"
    assert zone["polygon"] == [[1016, 0], [2540, 0], [2540, 5080], [1016, 5080]]


async def test_legacy_polygons_skip_garbage(hass: HomeAssistant) -> None:
    hass.states.async_set(f"input_text.{SCREEK}_zone_polygon_1", "[[-115, 110], [-115, 160], [-40, 160], [-40, 110]]")
    hass.states.async_set(f"input_text.{SCREEK}_zone_polygon_2", "not json")
    hass.states.async_set(f"input_text.{SCREEK}_zone_polygon_3", "[[0, 0], [1, 1]]")
    (p,) = async_legacy_polygons(hass, SCREEK, "in")
    assert p["n"] == "1"
    assert p["polygon"][0] == pytest.approx([-2921.0, 2794.0])
