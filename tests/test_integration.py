"""End-to-end tests inside a Home Assistant test instance."""

from __future__ import annotations

from datetime import timedelta

import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry, async_fire_time_changed

from homeassistant import config_entries
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResultType
from homeassistant.helpers import entity_registry as er
from homeassistant.util import dt as dt_util

from custom_components.radar_zone_presence.const import DOMAIN

from .conftest import SLUG

# Inches, like the production polygons. 1 in = 25.4 mm.
CHAIR_IN = [[0, 100], [40, 100], [40, 140], [0, 140]]


def mm(poly):
    return [[x * 25.4, y * 25.4] for x, y in poly]


async def setup_entry(hass: HomeAssistant, device_id: str, zones=None) -> MockConfigEntry:
    entry = MockConfigEntry(
        domain=DOMAIN,
        title="Everything Presence Lite abc123",
        unique_id=device_id,
        data={
            "device_id": device_id,
            "profile": "everything_presence",
            "targets": [
                {"slot": n, "x": f"sensor.{SLUG}_target_{n}_x", "y": f"sensor.{SLUG}_target_{n}_y"}
                for n in (1, 2, 3)
            ],
        },
        options={"zones": zones or [], "reconnect_grace_s": 0},
    )
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    return entry


def zone(zid, name, poly, kind="include", **filters):
    return {"id": zid, "name": name, "kind": kind, "polygon": mm(poly), "filters": filters, "area_id": None}


async def move(hass: HomeAssistant, slot: int, x: float, y: float) -> None:
    hass.states.async_set(f"sensor.{SLUG}_target_{slot}_x", str(x), {"unit_of_measurement": "in"})
    hass.states.async_set(f"sensor.{SLUG}_target_{slot}_y", str(y), {"unit_of_measurement": "in"})
    async_fire_time_changed(hass, dt_util.utcnow() + timedelta(seconds=0.06))
    await hass.async_block_till_done()


async def test_config_flow_imports_legacy_polygons(hass: HomeAssistant, radar_device: str) -> None:
    hass.states.async_set(f"input_text.{SLUG}_zone_polygon_1", "[[0, 100], [40, 100], [40, 140], [0, 140]]")
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
    assert result["type"] is FlowResultType.FORM
    result = await hass.config_entries.flow.async_configure(result["flow_id"], {"device_id": radar_device})
    assert result["step_id"] == "import_legacy"
    result = await hass.config_entries.flow.async_configure(result["flow_id"], {"import": True})
    assert result["type"] is FlowResultType.CREATE_ENTRY
    (z,) = result["options"]["zones"]
    assert z["name"] == "Polygon 1"
    assert z["polygon"][2] == pytest.approx([1016.0, 3556.0])


async def test_config_flow_no_devices(hass: HomeAssistant) -> None:
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "no_devices"


async def test_zone_presence_and_exclusion(hass: HomeAssistant, radar_device: str) -> None:
    entry = await setup_entry(
        hass,
        radar_device,
        [
            zone("chair", "Reading chair", CHAIR_IN),
            zone("plant", "Plant", [[30, 120], [40, 120], [40, 140], [30, 140]], kind="exclude"),
        ],
    )
    ent_reg = er.async_get(hass)
    chair = ent_reg.async_get_entity_id("binary_sensor", DOMAIN, f"{entry.entry_id}_chair")
    presence = ent_reg.async_get_entity_id("binary_sensor", DOMAIN, f"{entry.entry_id}_presence")
    assert chair and presence
    # Entities live on the radar's own device.
    assert ent_reg.async_get(chair).device_id == radar_device

    await move(hass, 1, 20, 120)
    assert hass.states.get(chair).state == "on"
    assert hass.states.get(chair).attributes["target_count"] == 1
    assert hass.states.get(presence).state == "on"

    await move(hass, 1, 35, 130)  # inside the plant exclusion
    assert hass.states.get(chair).state == "off"
    assert hass.states.get(presence).state == "off"

    await move(hass, 1, 0, 0)
    assert hass.states.get(chair).state == "off"


async def test_x_then_y_does_not_flicker(hass: HomeAssistant, radar_device: str) -> None:
    entry = await setup_entry(hass, radar_device, [zone("chair", "Reading chair", CHAIR_IN)])
    chair = er.async_get(hass).async_get_entity_id("binary_sensor", DOMAIN, f"{entry.entry_id}_chair")
    await move(hass, 1, 20, 120)
    changes = []
    hass.bus.async_listen("state_changed", lambda e: e.data["entity_id"] == chair and changes.append(e))
    # New X alone would pair with the old Y outside the zone; Y follows 1 ms later.
    hass.states.async_set(f"sensor.{SLUG}_target_1_x", "21", {"unit_of_measurement": "in"})
    hass.states.async_set(f"sensor.{SLUG}_target_1_y", "121", {"unit_of_measurement": "in"})
    async_fire_time_changed(hass, dt_util.utcnow() + timedelta(seconds=0.06))
    await hass.async_block_till_done()
    assert all(e.data["new_state"].state == "on" for e in changes)


async def test_off_delay_timer(hass: HomeAssistant, radar_device: str) -> None:
    entry = await setup_entry(hass, radar_device, [zone("chair", "Reading chair", CHAIR_IN, off_delay_s=5)])
    chair = er.async_get(hass).async_get_entity_id("binary_sensor", DOMAIN, f"{entry.entry_id}_chair")
    await move(hass, 1, 20, 120)
    await move(hass, 1, 0, 0)
    assert hass.states.get(chair).state == "on"
    async_fire_time_changed(hass, dt_util.utcnow() + timedelta(seconds=6))
    await hass.async_block_till_done()
    assert hass.states.get(chair).state == "off"


async def test_ws_config_and_save(hass: HomeAssistant, radar_device: str, hass_ws_client) -> None:
    entry = await setup_entry(hass, radar_device, [zone("chair", "Reading chair", CHAIR_IN)])
    client = await hass_ws_client(hass)

    await client.send_json_auto_id({"type": f"{DOMAIN}/list"})
    res = await client.receive_json()
    assert res["result"]["radars"][0]["entry_id"] == entry.entry_id

    await client.send_json_auto_id({"type": f"{DOMAIN}/config", "entry_id": entry.entry_id})
    cfg = (await client.receive_json())["result"]
    assert cfg["target_unit"] == "in"
    assert cfg["fov"]["max_distance_mm"] == pytest.approx(6000)
    assert cfg["zones"][0]["entity_id"].startswith("binary_sensor.")

    # Self-intersecting polygon is rejected.
    await client.send_json_auto_id(
        {
            "type": f"{DOMAIN}/zones/save",
            "entry_id": entry.entry_id,
            "zones": [{"name": "Bad", "kind": "include", "polygon": [[0, 0], [1000, 1000], [1000, 0], [0, 1000]]}],
        }
    )
    assert (await client.receive_json())["error"]["code"] == "invalid_polygon"

    # Replace the chair with a couch; the chair entity disappears.
    await client.send_json_auto_id(
        {
            "type": f"{DOMAIN}/zones/save",
            "entry_id": entry.entry_id,
            "zones": [{"name": "Couch", "kind": "include", "polygon": mm([[-60, 50], [-20, 50], [-20, 90], [-60, 90]])}],
        }
    )
    saved = (await client.receive_json())["result"]["zones"]
    await hass.async_block_till_done()
    ent_reg = er.async_get(hass)
    assert ent_reg.async_get_entity_id("binary_sensor", DOMAIN, f"{entry.entry_id}_chair") is None
    couch = ent_reg.async_get_entity_id("binary_sensor", DOMAIN, f"{entry.entry_id}_{saved[0]['id']}")
    assert couch is not None
    await move(hass, 2, -40, 70)
    assert hass.states.get(couch).state == "on"


async def test_ws_live_frames(hass: HomeAssistant, radar_device: str, hass_ws_client) -> None:
    entry = await setup_entry(hass, radar_device, [zone("chair", "Reading chair", CHAIR_IN)])
    client = await hass_ws_client(hass)
    await client.send_json_auto_id({"type": f"{DOMAIN}/frames/subscribe", "entry_id": entry.entry_id})
    assert (await client.receive_json())["success"]
    await client.receive_json()  # initial frame
    await move(hass, 1, 20, 120)
    msg = await client.receive_json()
    ev = msg["event"]
    assert ev["targets"] == [[1, 508, 3048]]
    assert ev["zones"]["chair"] == [True, 1]


async def test_unavailable_radar_makes_zones_unavailable(hass: HomeAssistant, radar_device: str) -> None:
    entry = await setup_entry(hass, radar_device, [zone("chair", "Reading chair", CHAIR_IN)])
    chair = er.async_get(hass).async_get_entity_id("binary_sensor", DOMAIN, f"{entry.entry_id}_chair")
    for n in (1, 2, 3):
        for axis in "xy":
            hass.states.async_set(f"sensor.{SLUG}_target_{n}_{axis}", "unavailable")
    async_fire_time_changed(hass, dt_util.utcnow() + timedelta(seconds=0.06))
    await hass.async_block_till_done()
    assert hass.states.get(chair).state == "unavailable"
    await move(hass, 1, 20, 120)
    assert hass.states.get(chair).state == "on"


async def test_diagnostics(hass: HomeAssistant, radar_device: str) -> None:
    from custom_components.radar_zone_presence.diagnostics import async_get_config_entry_diagnostics

    entry = await setup_entry(hass, radar_device, [zone("chair", "Reading chair", CHAIR_IN)])
    await move(hass, 1, 20, 120)
    diag = await async_get_config_entry_diagnostics(hass, entry)
    assert diag["snapshot"]["zones"]["chair"]["occupied"] is True
    assert diag["last_frame"]["targets"][0]["slot"] == 1


async def test_zone_area_override_and_inherit(hass: HomeAssistant, radar_device: str, hass_ws_client) -> None:
    from homeassistant.helpers import area_registry as ar

    kitchen = ar.async_get(hass).async_create("Kitchen")
    entry = await setup_entry(hass, radar_device, [{**zone("chair", "Reading chair", CHAIR_IN), "area_id": kitchen.id}])
    ent_reg = er.async_get(hass)
    chair = ent_reg.async_get_entity_id("binary_sensor", DOMAIN, f"{entry.entry_id}_chair")
    assert ent_reg.async_get(chair).area_id == kitchen.id

    client = await hass_ws_client(hass)
    await client.send_json_auto_id(
        {"type": f"{DOMAIN}/zones/save", "entry_id": entry.entry_id,
         "zones": [{**zone("chair", "Reading chair", CHAIR_IN), "area_id": None}]}
    )
    assert (await client.receive_json())["success"]
    await hass.async_block_till_done()
    assert ent_reg.async_get(chair).area_id is None  # back to inheriting the device area


async def test_live_units_fall_back_to_siblings(hass: HomeAssistant, radar_device: str) -> None:
    """Target 2 seeded without a unit still converts with the radar's unit (inches)."""
    hass.states.async_set(f"sensor.{SLUG}_target_2_x", "20", {})
    hass.states.async_set(f"sensor.{SLUG}_target_2_y", "120", {})
    entry = await setup_entry(hass, radar_device, [zone("chair", "Reading chair", CHAIR_IN)])
    chair = er.async_get(hass).async_get_entity_id("binary_sensor", DOMAIN, f"{entry.entry_id}_chair")
    assert hass.states.get(chair).state == "on"  # (20 in, 120 in) is inside the chair; as mm it would not be
    assert entry.runtime_data.last_frame.targets[0].x == pytest.approx(508)


async def test_unit_remembered_in_entry(hass: HomeAssistant, radar_device: str) -> None:
    """With no unit anywhere (all states unit-less), the stored entry unit is used."""
    entry = await setup_entry(hass, radar_device, [zone("chair", "Reading chair", CHAIR_IN)])
    assert entry.data["unit"] == "in"
    await hass.config_entries.async_unload(entry.entry_id)
    for n in (1, 2, 3):
        for axis in "xy":
            hass.states.async_set(f"sensor.{SLUG}_target_{n}_{axis}", "0.0", {"restored": True})
    hass.states.async_set(f"sensor.{SLUG}_target_1_x", "20", {})
    hass.states.async_set(f"sensor.{SLUG}_target_1_y", "120", {})
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    assert entry.runtime_data.last_frame.targets[0].x == pytest.approx(508)
