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
    assert geo["max_distance_mm"] == 8000  # the LD2450's own range when the device has no max_distance number
    (zone,) = geo["device_zones"]  # the all-zero zone1 is skipped
    assert zone["key"] == "zout1" and zone["kind"] == "exclude"
    assert zone["polygon"] == [[1016, 0], [2540, 0], [2540, 5080], [1016, 5080]]
    assert geo["mounting"] == {}  # Screek firmware has no mounting settings


async def test_device_geometry_reads_ep_lite_mounting(hass: HomeAssistant, screek: str) -> None:
    ent_reg = er.async_get(hass)
    source = hass.config_entries.async_entries("esphome")[0]
    for domain, object_id, state in (
        ("switch", "everything_presence_lite_252dd0_upside_down_mounting", "on"),
        ("number", "everything_presence_lite_252dd0_installation_angle", "15.0"),
    ):
        ent_reg.async_get_or_create(domain, "esphome", object_id, suggested_object_id=object_id,
                                    device_id=screek, config_entry=source)
        hass.states.async_set(f"{domain}.{object_id}", state)
    assert async_device_geometry(hass, screek)["mounting"] == {"upside_down": True, "installation_angle_deg": 15.0}


async def test_legacy_polygons_skip_garbage(hass: HomeAssistant) -> None:
    hass.states.async_set(f"input_text.{SCREEK}_zone_polygon_1", "[[-115, 110], [-115, 160], [-40, 160], [-40, 110]]")
    hass.states.async_set(f"input_text.{SCREEK}_zone_polygon_2", "not json")
    hass.states.async_set(f"input_text.{SCREEK}_zone_polygon_3", "[[0, 0], [1, 1]]")
    (p,) = async_legacy_polygons(hass, SCREEK, "in")
    assert p["n"] == "1"
    assert p["polygon"][0] == pytest.approx([-2921.0, 2794.0])


def test_a_range_without_a_unit_is_read_by_its_size() -> None:
    from custom_components.radar_zone_presence.discovery import _distance_mm

    assert _distance_mm(600, None) == 6000  # Everything Presence: cm (a restored state without attributes)
    assert _distance_mm(6, None) == 6000
    assert _distance_mm(6000, None) == 6000
    assert _distance_mm(600, "cm") == 6000


def test_coordinate_sensors_are_guessed_from_many_naming_styles() -> None:
    from custom_components.radar_zone_presence.discovery import guess_targets

    assert guess_targets([("sensor.r_target_1_x", "Target 1 X"), ("sensor.r_target_1_y", "Target 1 Y"), ("sensor.r_target_1_speed", "Target 1 Speed")]) == {
        1: {"x": "sensor.r_target_1_x", "y": "sensor.r_target_1_y"}
    }
    assert guess_targets([("sensor.a_person2x", None), ("sensor.a_person2y", None)]) == {2: {"x": "sensor.a_person2x", "y": "sensor.a_person2y"}}
    assert guess_targets([("sensor.z_x1", None), ("sensor.z_y1", None), ("sensor.z_x2", None)]) == {1: {"x": "sensor.z_x1", "y": "sensor.z_y1"}}  # x2 alone: no pair
    assert guess_targets([("sensor.m_x", "X coordinate"), ("sensor.m_y", "Y coordinate"), ("sensor.m_distance", "Distance")]) == {
        1: {"x": "sensor.m_x", "y": "sensor.m_y"}
    }
    assert guess_targets([("sensor.m_temperature", "Temperature"), ("binary_sensor.m_target_1_x", None)]) == {}
