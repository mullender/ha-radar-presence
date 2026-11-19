"""End-to-end tests inside a Home Assistant test instance."""

from __future__ import annotations

from datetime import timedelta

import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry, async_fire_time_changed

from homeassistant import config_entries
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResultType
from homeassistant.helpers import device_registry as dr, entity_registry as er
from homeassistant.util import dt as dt_util

from custom_components.radar_zone_presence.const import DOMAIN

from .conftest import SLUG, SLUG2

# Inches, like the production polygons. 1 in = 25.4 mm.
CHAIR_IN = [[0, 100], [40, 100], [40, 140], [0, 140]]


def mm(poly):
    return [[x * 25.4, y * 25.4] for x, y in poly]


RADAR = "radar1"


def radar_subentry(device_id: str, radar_zones=None, subentry_id: str = RADAR, slug: str = SLUG, display=None) -> dict:
    return {
        "subentry_id": subentry_id,
        "subentry_type": "radar",
        "title": "Everything Presence Lite abc123",
        "unique_id": device_id,
        "data": {
            "device_id": device_id,
            "profile": "everything_presence",
            "targets": [
                {"slot": n, "x": f"sensor.{slug}_target_{n}_x", "y": f"sensor.{slug}_target_{n}_y"} for n in (1, 2, 3)
            ],
            "zones": radar_zones or [],
            **({"display": display} if display else {}),
        },
    }


def zone_subentry(z: dict, radar: str = RADAR) -> dict:
    data = {k: v for k, v in z.items() if k != "kind"} | {"radar": radar}
    return {"subentry_id": f"sub_{z['id']}", "subentry_type": "zone", "title": z["name"], "unique_id": z["id"], "data": data}


async def setup_entry(hass: HomeAssistant, device_id: str, zones=None, extra_subentries=()) -> MockConfigEntry:
    zones = zones or []
    entry = MockConfigEntry(
        domain=DOMAIN,
        title="Home",
        version=2,
        data={},
        options={"reconnect_grace_s": 0},
        subentries_data=[
            radar_subentry(device_id, [z for z in zones if z["kind"] != "include"]),
            *[zone_subentry(z) for z in zones if z["kind"] == "include"],
            *extra_subentries,
        ],
    )
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    return entry


def eid(hass: HomeAssistant, zid: str, domain: str = "binary_sensor") -> str | None:
    return er.async_get(hass).async_get_entity_id(domain, DOMAIN, zid)


def zone(zid, name, poly, kind="include", **filters):
    return {"id": zid, "name": name, "kind": kind, "polygon": mm(poly), "filters": filters, "area_id": None}


async def move(hass: HomeAssistant, slot: int, x: float, y: float, slug: str = SLUG) -> None:
    hass.states.async_set(f"sensor.{slug}_target_{slot}_x", str(x), {"unit_of_measurement": "in"})
    hass.states.async_set(f"sensor.{slug}_target_{slot}_y", str(y), {"unit_of_measurement": "in"})
    async_fire_time_changed(hass, dt_util.utcnow() + timedelta(seconds=0.06))
    await hass.async_block_till_done()


async def start_radar_flow(hass: HomeAssistant):
    """Set up the home (if needed) and open the add-radar subentry flow."""
    entries = hass.config_entries.async_entries(DOMAIN)
    if not entries:
        result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
        assert result["type"] is FlowResultType.CREATE_ENTRY
        await hass.async_block_till_done()
        # Creating the home goes straight on to adding a radar.
        if "next_flow" in result:
            flow_type, flow_id = result["next_flow"]
            assert flow_type == config_entries.FlowType.CONFIG_SUBENTRIES_FLOW
            hass.config_entries.subentries.async_abort(flow_id)
        entries = hass.config_entries.async_entries(DOMAIN)
    return await hass.config_entries.subentries.async_init(
        (entries[0].entry_id, "radar"), context={"source": config_entries.SOURCE_USER}
    )


async def test_config_flow_imports_legacy_polygons(hass: HomeAssistant, radar_device: str) -> None:
    hass.states.async_set(f"input_text.{SLUG}_zone_polygon_1", "[[0, 100], [40, 100], [40, 140], [0, 140]]")
    result = await start_radar_flow(hass)
    assert result["type"] is FlowResultType.FORM
    result = await hass.config_entries.subentries.async_configure(result["flow_id"], {"device_id": radar_device})
    assert result["step_id"] == "import_legacy"
    result = await hass.config_entries.subentries.async_configure(result["flow_id"], {"import": True})
    assert result["type"] is FlowResultType.CREATE_ENTRY
    await hass.async_block_till_done()
    (entry,) = hass.config_entries.async_entries(DOMAIN)
    # The imported polygon became a zone subentry with its own presence device.
    zones = [s for s in entry.subentries.values() if s.subentry_type == "zone"]
    (z,) = zones
    assert z.title == "Polygon 1"
    assert z.data["polygon"][2] == pytest.approx([1016.0, 3556.0])
    radar = next(s for s in entry.subentries.values() if s.subentry_type == "radar")
    assert z.data["radar"] == radar.subentry_id and "import_zones" not in radar.data
    assert hass.states.get(eid(hass, z.data["id"])).attributes["friendly_name"] == "Polygon 1 Occupancy"
    # The radar cannot be added twice.
    result = await start_radar_flow(hass)
    assert result["type"] is FlowResultType.ABORT and result["reason"] == "no_devices"


async def test_a_new_radar_has_presence_in_its_room_right_away(hass: HomeAssistant, radar_device: str) -> None:
    """No drawing needed: a radar in an area starts with a room shape covering its whole view, named after the area."""
    from homeassistant.helpers import area_registry as ar

    area = ar.async_get(hass).async_create("Study")
    dr.async_get(hass).async_update_device(radar_device, area_id=area.id)
    result = await start_radar_flow(hass)
    result = await hass.config_entries.subentries.async_configure(result["flow_id"], {"device_id": radar_device})
    assert result["type"] is FlowResultType.CREATE_ENTRY
    await hass.async_block_till_done()
    (entry,) = hass.config_entries.async_entries(DOMAIN)
    (room,) = [s for s in entry.subentries.values() if s.subentry_type == "zone"]
    assert room.title == "Study" and len(room.data["polygon"]) == 14  # the radar and 13 points along its range
    state = hass.states.get(eid(hass, room.data["id"]))
    assert state.attributes["friendly_name"] == "Study Occupancy"


async def test_single_home_entry(hass: HomeAssistant, radar_device: str) -> None:
    await start_radar_flow(hass)
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
    assert result["type"] is FlowResultType.ABORT and result["reason"] == "single_instance_allowed"


async def test_zone_subentry_flow(hass: HomeAssistant, radar_device: str) -> None:
    entry = await setup_entry(hass, radar_device)
    result = await hass.config_entries.subentries.async_init((entry.entry_id, "zone"), context={"source": config_entries.SOURCE_USER})
    result = await hass.config_entries.subentries.async_configure(result["flow_id"], {"name": "Desk", "radar": RADAR})
    assert result["type"] is FlowResultType.CREATE_ENTRY
    await hass.async_block_till_done()
    (sub,) = [s for s in entry.subentries.values() if s.subentry_type == "zone"]
    desk = eid(hass, sub.data["id"])
    assert hass.states.get(desk).attributes["friendly_name"] == "Desk Occupancy"
    # Rename from the integration page.
    result = await hass.config_entries.subentries.async_init(
        (entry.entry_id, "zone"), context={"source": config_entries.SOURCE_RECONFIGURE, "subentry_id": sub.subentry_id}
    )
    result = await hass.config_entries.subentries.async_configure(result["flow_id"], {"name": "Standing desk"})
    assert result["type"] is FlowResultType.ABORT
    await hass.async_block_till_done()
    assert entry.subentries[sub.subentry_id].title == "Standing desk"
    assert dr.async_get(hass).async_get(er.async_get(hass).async_get(desk).device_id).name == "Standing desk"


async def test_config_flow_labels_show_area_floor_and_live_targets(hass: HomeAssistant, radar_device: str) -> None:
    from homeassistant.helpers import area_registry as ar, device_registry as dr, floor_registry as fr

    floor = fr.async_get(hass).async_create("Upstairs")
    area = ar.async_get(hass).async_create("Office", floor_id=floor.floor_id)
    dr.async_get(hass).async_update_device(radar_device, area_id=area.id)

    def label():
        schema = result["data_schema"].schema
        (sel,) = schema.values()
        (opt,) = sel.config["options"]
        return opt["label"]

    async def labelled():
        nonlocal result
        result = await start_radar_flow(hass)
        text = label()
        hass.config_entries.subentries.async_abort(result["flow_id"])
        return text

    result = None
    assert (await labelled()).endswith("— Office (Upstairs) · 0 targets now")
    for slot in (1, 2, 3):
        hass.states.async_set(f"sensor.{SLUG}_target_{slot}_y", "unavailable")
    assert (await labelled()).endswith("— Office (Upstairs) · offline")
    for slot in (1, 2, 3):
        hass.states.async_set(f"sensor.{SLUG}_target_{slot}_y", "0", {"unit_of_measurement": "in"})
    await move(hass, 2, 10, 80)
    assert (await labelled()).endswith("— Office (Upstairs) · 1 target now")


async def test_config_flow_no_devices(hass: HomeAssistant) -> None:
    result = await start_radar_flow(hass)
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
    chair = eid(hass, "chair")
    assert chair
    assert len(er.async_entries_for_config_entry(ent_reg, entry.entry_id)) == 2  # occupancy + target count; nothing radar-level
    # The zone is its own presence device, connected via the radar, named "<zone> Presence".
    device = dr.async_get(hass).async_get(ent_reg.async_get(chair).device_id)
    assert device.id != radar_device and device.via_device_id == radar_device
    assert device.name == "Reading chair" and device.manufacturer == "Radar Presence"
    assert device.configuration_url == "homeassistant://radar-zones#radar=radar1&zone=chair"
    assert hass.states.get(chair).attributes["friendly_name"] == "Reading chair Occupancy"

    await move(hass, 1, 20, 120)
    assert hass.states.get(chair).state == "on"
    assert hass.states.get(chair).attributes["target_count"] == 1

    await move(hass, 1, 35, 130)  # inside the plant exclusion
    assert hass.states.get(chair).state == "off"
    assert entry.runtime_data.feeds[RADAR].excluded_count == 1  # dropped before any zone
    # Zone entities belong to the zone's subentry, so they are listed (and removed) with it.
    assert ent_reg.async_get(chair).config_subentry_id == "sub_chair"
    assert device.config_entry_id == entry.entry_id and device.config_subentry_id == "sub_chair"

    await move(hass, 1, 0, 0)
    assert hass.states.get(chair).state == "off"


async def test_x_then_y_does_not_flicker(hass: HomeAssistant, radar_device: str) -> None:
    entry = await setup_entry(hass, radar_device, [zone("chair", "Reading chair", CHAIR_IN)])
    chair = eid(hass, "chair")
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
    chair = eid(hass, "chair")
    await move(hass, 1, 20, 120)
    await move(hass, 1, 0, 0)
    assert hass.states.get(chair).state == "on"
    async_fire_time_changed(hass, dt_util.utcnow() + timedelta(seconds=6))
    await hass.async_block_till_done()
    assert hass.states.get(chair).state == "off"


async def test_renumbered_slots_do_not_walk_the_held_person_out(hass: HomeAssistant, radar_device: str) -> None:
    """The radar drops a still person and moves someone else into their slot (or reuses it later)."""
    await setup_entry(hass, radar_device, [zone("chair", "Reading chair", CHAIR_IN, hold_until_exit=True, hold_max_s=600)])
    chair = eid(hass, "chair")
    await move(hass, 1, 20, 120)  # sitting in the chair
    await move(hass, 2, -60, 80)  # someone else across the room
    # Chair person dropped; the other one is now reported as target 1.
    await move(hass, 2, 0, 0)
    await move(hass, 1, -60, 81)
    state = hass.states.get(chair)
    assert state.state == "on" and state.attributes["held"] == 1
    # The other person leaves view, then appears again as target 1 near where they were.
    await move(hass, 1, 0, 0)
    await move(hass, 1, -58, 84)
    assert hass.states.get(chair).state == "on"
    # The chair person gets up: seen again next to the chair, then walks off.
    await move(hass, 2, 25, 118)
    assert hass.states.get(chair).attributes["held"] == 0
    for k in range(1, 7):
        await move(hass, 2, 25 + 10 * k, 118 - 10 * k)
    assert hass.states.get(chair).state == "off"


async def test_hold_until_exit_with_max_hold(hass: HomeAssistant, radar_device: str) -> None:
    entry = await setup_entry(
        hass, radar_device, [zone("chair", "Reading chair", CHAIR_IN, hold_until_exit=True, hold_max_s=60)]
    )
    chair = eid(hass, "chair")
    await move(hass, 1, 20, 120)
    await move(hass, 1, 0, 0)  # goes still: radar reports no target
    state = hass.states.get(chair)
    assert state.state == "on" and state.attributes["held"] == 1
    async_fire_time_changed(hass, dt_util.utcnow() + timedelta(seconds=30))
    await hass.async_block_till_done()
    assert hass.states.get(chair).state == "on"
    async_fire_time_changed(hass, dt_util.utcnow() + timedelta(seconds=61))
    await hass.async_block_till_done()
    state = hass.states.get(chair)
    assert state.state == "off" and state.attributes["held"] == 0


async def test_ws_read_only_for_people_who_arent_admins(
    hass: HomeAssistant, radar_device: str, hass_ws_client, hass_read_only_access_token: str
) -> None:
    """The panel is read-only for people who aren't admins: they can read and correct the count, not save shapes."""
    await setup_entry(hass, radar_device, [zone("chair", "Reading chair", CHAIR_IN)])
    client = await hass_ws_client(hass, hass_read_only_access_token)
    for msg in (
        {"type": f"{DOMAIN}/list"},
        {"type": f"{DOMAIN}/config", "radar_id": RADAR},
        {"type": f"{DOMAIN}/headcount/history", "start": 0},
        {"type": f"{DOMAIN}/frames/history", "radar_id": RADAR, "start": "2026-01-01T00:00:00+00:00", "end": "2026-01-01T00:10:00+00:00"},
        {"type": f"{DOMAIN}/headcount/correct", "count": 0},
    ):
        await client.send_json_auto_id(msg)
        res = await client.receive_json()
        assert res["success"] or res["error"]["code"] != "unauthorized", (msg["type"], res)  # (no recorder in tests)
    await client.send_json_auto_id({"type": f"{DOMAIN}/zones/save", "radar_id": RADAR, "zones": []})
    assert (await client.receive_json())["error"]["code"] == "unauthorized"


async def test_a_spot_with_its_occupancy_sensor_on_and_off(hass: HomeAssistant, radar_device: str, hass_ws_client) -> None:
    """A spot's occupancy sensor is optional: on, it is a zone with a Spot device that also keeps people who go still;
    off, it is a linger spot on the radar (no device). The id stays, so switching it back on gets the same entity."""
    entry = await setup_entry(hass, radar_device, [])
    client = await hass_ws_client(hass)
    desk = {"id": "zdesk", "name": "Desk", "kind": "include", "spot": True, "polygon": mm(CHAIR_IN), "filters": {"hold_until_exit": True}}
    await client.send_json_auto_id({"type": f"{DOMAIN}/zones/save", "radar_id": RADAR, "zones": [desk]})
    assert (await client.receive_json())["success"]
    await hass.async_block_till_done()
    entity = eid(hass, "zdesk")
    assert hass.states.get(entity).attributes["friendly_name"] == "Desk Occupancy"
    device = dr.async_get(hass).async_get(er.async_get(hass).async_get(entity).device_id)
    assert device.model == "Spot"
    runtime = hass.config_entries.async_get_entry(entry.entry_id).runtime_data
    assert len(runtime.group_of[RADAR].tracker._linger) == 1  # also a linger spot for the tracker
    await client.send_json_auto_id({"type": f"{DOMAIN}/config", "radar_id": RADAR})
    assert (await client.receive_json())["result"]["zones"][0]["spot"] is True

    await client.send_json_auto_id({"type": f"{DOMAIN}/zones/save", "radar_id": RADAR, "zones": [{**desk, "kind": "linger"}]})
    assert (await client.receive_json())["success"]
    await hass.async_block_till_done()
    assert eid(hass, "zdesk") is None
    saved = hass.config_entries.async_get_entry(entry.entry_id).subentries[RADAR].data["zones"]
    assert saved[0]["id"] == "zdesk" and saved[0]["kind"] == "linger" and "spot" not in saved[0]
    runtime = hass.config_entries.async_get_entry(entry.entry_id).runtime_data
    assert len(runtime.group_of[RADAR].tracker._linger) == 1


async def test_ws_config_and_save(hass: HomeAssistant, radar_device: str, hass_ws_client) -> None:
    entry = await setup_entry(hass, radar_device, [zone("chair", "Reading chair", CHAIR_IN)])
    client = await hass_ws_client(hass)

    await client.send_json_auto_id({"type": f"{DOMAIN}/list"})
    res = await client.receive_json()
    assert res["result"]["home"]["entry_id"] == entry.entry_id
    assert res["result"]["radars"][0]["radar_id"] == RADAR

    await client.send_json_auto_id({"type": f"{DOMAIN}/config", "radar_id": RADAR})
    cfg = (await client.receive_json())["result"]
    assert cfg["target_unit"] == "in"
    assert cfg["fov"]["max_distance_mm"] == pytest.approx(6000)  # the EPL max_distance number
    assert cfg["zones"][0]["entity_id"].startswith("binary_sensor.")

    # Self-intersecting polygon is rejected.
    await client.send_json_auto_id(
        {
            "type": f"{DOMAIN}/zones/save",
            "radar_id": RADAR,
            "zones": [{"name": "Bad", "kind": "include", "polygon": [[0, 0], [1000, 1000], [1000, 0], [0, 1000]]}],
        }
    )
    assert (await client.receive_json())["error"]["code"] == "invalid_polygon"

    # Replace the chair with a couch; the chair entity disappears.
    await client.send_json_auto_id(
        {
            "type": f"{DOMAIN}/zones/save",
            "radar_id": RADAR,
            "zones": [{"name": "Couch", "kind": "include", "polygon": mm([[-60, 50], [-20, 50], [-20, 90], [-60, 90]])}],
        }
    )
    saved = (await client.receive_json())["result"]["zones"]
    await hass.async_block_till_done()
    assert eid(hass, "chair") is None
    assert "sub_chair" not in entry.subentries  # the chair's subentry (and device) is gone
    couch = eid(hass, saved[0]["id"])
    assert couch is not None
    await move(hass, 2, -40, 70)
    assert hass.states.get(couch).state == "on"


async def test_exit_zone_keeps_door_and_creates_no_zone_device(hass: HomeAssistant, radar_device: str, hass_ws_client) -> None:
    entry = await setup_entry(hass, radar_device)
    client = await hass_ws_client(hass)
    await client.send_json_auto_id(
        {
            "type": f"{DOMAIN}/zones/save",
            "radar_id": RADAR,
            "zones": [
                {"id": "zdoor", "name": "Front door", "kind": "exit", "door_entity_id": "binary_sensor.front_door",
                 "door": {"swing": "in"},
                 "polygon": mm([[-60, 50], [-20, 50], [-20, 90], [-60, 90]])},
            ],
        }
    )
    (saved,) = (await client.receive_json())["result"]["zones"]
    assert saved["kind"] == "exit" and saved["door_entity_id"] == "binary_sensor.front_door"
    assert saved["door"] == {"swing": "in", "hinge_end": 0}
    await hass.async_block_till_done()
    ent_reg = er.async_get(hass)
    assert eid(hass, "zdoor") is None
    assert entry.subentries[RADAR].data["zones"][0]["id"] == "zdoor"  # exits live on the radar
    # No presence device for an exit, only a passage event on the radar's (linked) device.
    (device,) = dr.async_entries_for_config_entry(dr.async_get(hass), entry.entry_id)
    assert device.model == "Radar doorways"
    assert [e.domain for e in er.async_entries_for_config_entry(ent_reg, entry.entry_id)] == ["event"]
    await client.send_json_auto_id({"type": f"{DOMAIN}/config", "radar_id": RADAR})
    cfg = (await client.receive_json())["result"]
    assert cfg["zones"][0]["door_entity_id"] == "binary_sensor.front_door"


async def test_ws_live_frames(hass: HomeAssistant, radar_device: str, hass_ws_client) -> None:
    entry = await setup_entry(hass, radar_device, [zone("chair", "Reading chair", CHAIR_IN)])
    client = await hass_ws_client(hass)
    await client.send_json_auto_id({"type": f"{DOMAIN}/frames/subscribe", "radar_id": RADAR})
    assert (await client.receive_json())["success"]
    await client.receive_json()  # initial frame
    await move(hass, 1, 20, 120)
    msg = await client.receive_json()
    ev = msg["event"]
    assert ev["targets"] == [[1, 508, 3048]]
    assert ev["zones"]["chair"] == [True, 1, 0]


async def test_unavailable_radar_makes_zones_unavailable(hass: HomeAssistant, radar_device: str) -> None:
    entry = await setup_entry(hass, radar_device, [zone("chair", "Reading chair", CHAIR_IN)])
    chair = eid(hass, "chair")
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
    assert diag["zones"]["chair"]["snapshot"]["occupied"] is True
    assert diag["radars"][RADAR]["last_frame"]["targets"][0]["slot"] == 1


async def test_zone_area_override_and_inherit(hass: HomeAssistant, radar_device: str, hass_ws_client) -> None:
    from homeassistant.helpers import area_registry as ar

    kitchen = ar.async_get(hass).async_create("Kitchen")
    living = ar.async_get(hass).async_create("Living room")
    dr.async_get(hass).async_update_device(radar_device, area_id=living.id)
    entry = await setup_entry(hass, radar_device, [{**zone("chair", "Reading chair", CHAIR_IN), "area_id": kitchen.id}])
    ent_reg = er.async_get(hass)
    chair = eid(hass, "chair")
    dev_reg = dr.async_get(hass)
    device_id = ent_reg.async_get(chair).device_id
    assert dev_reg.async_get(device_id).area_id == kitchen.id  # the presence device is in the zone's area
    assert ent_reg.async_get(chair).area_id is None  # the entity follows its device

    client = await hass_ws_client(hass)
    await client.send_json_auto_id(
        {"type": f"{DOMAIN}/zones/save", "radar_id": RADAR,
         "zones": [{**zone("chair", "Reading chair", CHAIR_IN), "area_id": None}]}
    )
    assert (await client.receive_json())["success"]
    await hass.async_block_till_done()
    assert dev_reg.async_get(device_id).area_id == living.id  # back to the radar's area


async def test_live_units_fall_back_to_siblings(hass: HomeAssistant, radar_device: str) -> None:
    """Target 2 seeded without a unit still converts with the radar's unit (inches)."""
    hass.states.async_set(f"sensor.{SLUG}_target_2_x", "20", {})
    hass.states.async_set(f"sensor.{SLUG}_target_2_y", "120", {})
    entry = await setup_entry(hass, radar_device, [zone("chair", "Reading chair", CHAIR_IN)])
    chair = eid(hass, "chair")
    assert hass.states.get(chair).state == "on"  # (20 in, 120 in) is inside the chair; as mm it would not be
    assert entry.runtime_data.feeds[RADAR].last_frame.targets[0].x == pytest.approx(508)


async def test_unit_remembered_in_entry(hass: HomeAssistant, radar_device: str) -> None:
    """With no unit anywhere (all states unit-less), the stored entry unit is used."""
    entry = await setup_entry(hass, radar_device, [zone("chair", "Reading chair", CHAIR_IN)])
    assert entry.subentries[RADAR].data["unit"] == "in"
    await hass.config_entries.async_unload(entry.entry_id)
    for n in (1, 2, 3):
        for axis in "xy":
            hass.states.async_set(f"sensor.{SLUG}_target_{n}_{axis}", "0.0", {"restored": True})
    hass.states.async_set(f"sensor.{SLUG}_target_1_x", "20", {})
    hass.states.async_set(f"sensor.{SLUG}_target_1_y", "120", {})
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    assert entry.runtime_data.feeds[RADAR].last_frame.targets[0].x == pytest.approx(508)


async def test_aligned_radars_share_zones(hass: HomeAssistant, radar_device: str, second_radar: str, hass_ws_client) -> None:
    """A second radar 100 in to the right of the first, facing the same way, also covers the chair."""
    aligned = {"aligned_to": {"radar_id": RADAR, "angle_deg": 0, "reflect": False, "offset_mm": [2540, 0]}}
    radar2 = {**radar_subentry(second_radar, subentry_id="radar2", slug=SLUG2, display=aligned), "title": "Kitchen radar"}
    entry = await setup_entry(hass, radar_device, [zone("chair", "Reading chair", CHAIR_IN, hold_until_exit=True)], [radar2])
    runtime = entry.runtime_data
    assert runtime.coverage("chair") == [RADAR, "radar2"]
    chair = eid(hass, "chair")
    seen1, seen2 = eid(hass, f"chair_seen_{RADAR}"), eid(hass, "chair_seen_radar2")
    assert seen1 and seen2
    assert er.async_get(hass).async_get(seen2).entity_category == "diagnostic"
    assert hass.states.get(seen2).attributes["friendly_name"] == "Reading chair Seen by Kitchen radar"

    # Only radar 2 sees them: (20, 120) in radar 1's frame is (-80, 120) in radar 2's.
    await move(hass, 1, -80, 120, slug=SLUG2)
    assert hass.states.get(chair).state == "on"
    assert hass.states.get(seen2).state == "on" and hass.states.get(seen1).state == "off"
    # Radar 1 picks them up too: still one person.
    await move(hass, 1, 21, 121)
    assert hass.states.get(chair).attributes["target_count"] == 1
    assert hass.states.get(seen1).state == "on"
    # Radar 2 loses them while radar 1 keeps seeing them: no phantom hold.
    await move(hass, 1, 0, 0, slug=SLUG2)
    assert hass.states.get(chair).attributes == {**hass.states.get(chair).attributes, "target_count": 1, "held": 0}
    # They walk out of the zone in radar 1's view: off, nothing held.
    for k in range(1, 9):
        await move(hass, 1, 21 + 59 * k / 8, 121 - 61 * k / 8)
    assert hass.states.get(chair).state == "off"

    client = await hass_ws_client(hass)
    await client.send_json_auto_id({"type": f"{DOMAIN}/list"})
    radars = (await client.receive_json())["result"]["radars"]
    assert {r["radar_id"]: r["group"] for r in radars} == {RADAR: RADAR, "radar2": RADAR}
    await client.send_json_auto_id({"type": f"{DOMAIN}/config", "radar_id": RADAR})
    cfg = (await client.receive_json())["result"]
    assert cfg["zones"][0]["seen_by"] == ["Everything Presence Lite abc123", "Kitchen radar"]
    assert cfg["group"] == {"anchor": RADAR, "members": [RADAR, "radar2"]}


async def test_exit_passages_fire_events(hass: HomeAssistant, radar_device: str, freezer) -> None:
    stairs = {**zone("stairs", "Stairs", [[-60, 10], [-20, 10], [-20, 50], [-60, 50]], kind="exit")}
    door = {**zone("door", "Front door", [[20, 10], [60, 10], [60, 50], [20, 50]], kind="exit"), "door_entity_id": "binary_sensor.front_door"}
    hass.states.async_set("binary_sensor.front_door", "off")
    freezer.tick(120)  # the door last moved long ago
    entry = await setup_entry(hass, radar_device, [zone("chair", "Reading chair", CHAIR_IN), stairs, door])
    ent_reg = er.async_get(hass)
    stairs_eid = ent_reg.async_get_entity_id("event", DOMAIN, f"{RADAR}_stairs_passage")
    door_eid = ent_reg.async_get_entity_id("event", DOMAIN, f"{RADAR}_door_passage")
    assert hass.states.get(stairs_eid).attributes["friendly_name"] == "Everything Presence Lite abc123 Stairs"
    # The exits sit on our own device for the radar, linked to the radar's device by its MAC.
    device = dr.async_get(hass).async_get(ent_reg.async_get(stairs_eid).device_id)
    assert device.id != radar_device and device.config_subentry_id == RADAR
    assert device.connections == dr.async_get(hass).async_get(radar_device).connections

    await move(hass, 1, -40, 30)  # appears at the top of the stairs
    assert hass.states.get(stairs_eid).attributes["event_type"] == "arrived"
    await move(hass, 1, -40, 80)  # walks in
    await move(hass, 1, -40, 30)  # back to the stairs
    await move(hass, 1, 0, 0)  # gone down
    assert hass.states.get(stairs_eid).attributes["event_type"] == "left"

    # A door exit needs the door: appearing there without it moving is not an arrival...
    await move(hass, 2, 40, 30)
    assert hass.states.get(door_eid).state == "unknown"
    # ...until the door closes behind them, within the window.
    hass.states.async_set("binary_sensor.front_door", "on")
    await hass.async_block_till_done()
    state = hass.states.get(door_eid)
    assert state.attributes["event_type"] == "arrived" and state.attributes["door_entity_id"] == "binary_sensor.front_door"
    assert entry.runtime_data.feeds[RADAR].exits


async def test_frontend_served_under_versioned_path(hass: HomeAssistant, radar_device: str, hass_client) -> None:
    """Relative module imports must resolve under the version, so updates never mix old and new modules."""
    await setup_entry(hass, radar_device, [])
    panel = hass.data["frontend_panels"]["radar-zones"]
    url = panel.config["_panel_custom"]["module_url"]
    assert "?" not in url and url.endswith("/panel.js")
    client = await hass_client()
    resp = await client.get(url.replace("panel.js", "util.js"))
    assert resp.status == 200
    assert "affineApply" in await resp.text()


async def test_linger_and_transient_spots_reach_the_tracker(hass: HomeAssistant, radar_device: str, hass_ws_client) -> None:
    entry = await setup_entry(hass, radar_device, [zone("chair", "Reading chair", CHAIR_IN, hold_until_exit=True)])
    client = await hass_ws_client(hass)
    spots = [
        {"name": "Bed", "kind": "linger", "polygon": mm([[-60, 50], [-20, 50], [-20, 90], [-60, 90]])},
        {"name": "Hall", "kind": "transient", "polygon": mm([[20, 20], [60, 20], [60, 40], [20, 40]])},
    ]
    await client.send_json_auto_id({"type": f"{DOMAIN}/zones/save", "radar_id": RADAR, "zones": [zone("chair", "Reading chair", CHAIR_IN, hold_until_exit=True), *spots]})
    assert (await client.receive_json())["success"]
    await hass.async_block_till_done()
    await client.send_json_auto_id({"type": f"{DOMAIN}/config", "radar_id": RADAR})
    cfg = (await client.receive_json())["result"]
    assert sorted(z["kind"] for z in cfg["zones"]) == ["include", "linger", "transient"]
    tracker = entry.runtime_data.groups[0].tracker
    assert len(tracker._linger) == 1 and len(tracker._transient) == 1
    # Spots have no entities of their own.
    ours = [e.entity_id for e in er.async_entries_for_config_entry(er.async_get(hass), entry.entry_id)]
    assert not [e for e in ours if "bed" in e or "hall" in e]


async def _tick(hass: HomeAssistant, freezer, seconds: float) -> None:
    freezer.tick(seconds)
    async_fire_time_changed(hass, dt_util.utcnow())
    await hass.async_block_till_done()


async def test_a_correction_keeps_the_answer_to_what_happened(hass: HomeAssistant, radar_device: str, freezer, hass_ws_client) -> None:
    """The optional follow-up to a correction (a pet, a visitor, ...) is stored with the corrected log entries."""
    from homeassistant.helpers import area_registry as ar, floor_registry as fr

    floor = fr.async_get(hass).async_create("Ground floor", level=0)
    area = ar.async_get(hass).async_create("Entry", floor_id=floor.floor_id)
    dr.async_get(hass).async_update_device(radar_device, area_id=area.id)
    freezer.tick(120)
    await setup_entry(hass, radar_device, [])
    client = await hass_ws_client(hass)
    await client.send_json_auto_id({"type": f"{DOMAIN}/headcount"})
    space = (await client.receive_json())["result"]["spaces"][0]["id"]
    await client.send_json_auto_id({"type": f"{DOMAIN}/headcount/correct", "space": space, "count": 2})
    t = (await client.receive_json())["result"]["t"]
    await client.send_json_auto_id({"type": f"{DOMAIN}/headcount/answer", "t": t, "answer": "visitor", "where": "Entry"})
    assert (await client.receive_json())["result"]["updated"] >= 1
    await client.send_json_auto_id({"type": f"{DOMAIN}/headcount/history", "start": t - 10})
    log = (await client.receive_json())["result"]["log"]
    corrected = [e for e in log if e["kind"] == "corrected"]
    assert corrected and all(e["answer"] == "visitor" and e["where"] == "Entry" for e in corrected)
    await client.send_json_auto_id({"type": f"{DOMAIN}/headcount/answer", "t": t, "answer": "a ghost"})
    assert (await client.receive_json())["error"]["code"] == "invalid_format"


async def test_head_count_sensors_follow_the_front_door(hass: HomeAssistant, radar_device: str, freezer) -> None:
    """People home / per floor / per space: someone seen inside counts; leaving through the front door does not."""
    from homeassistant.helpers import area_registry as ar, floor_registry as fr

    floor = fr.async_get(hass).async_create("Ground floor", level=0)
    area = ar.async_get(hass).async_create("Entry", floor_id=floor.floor_id)
    dr.async_get(hass).async_update_device(radar_device, area_id=area.id)
    hass.states.async_set("binary_sensor.front_door", "off")
    freezer.tick(120)
    door = {
        **zone("door", "Front door", [[20, 10], [60, 10], [60, 50], [20, 50]], kind="exit"),
        "door_entity_id": "binary_sensor.front_door",
        "leads_to": ["outside"],
    }
    entry = await setup_entry(hass, radar_device, [door])
    ent_reg = er.async_get(hass)
    home_eid = ent_reg.async_get_entity_id("sensor", DOMAIN, f"{entry.entry_id}_people")
    floor_eid = ent_reg.async_get_entity_id("sensor", DOMAIN, f"{entry.entry_id}_people_floor_0")
    space_eid = ent_reg.async_get_entity_id("sensor", DOMAIN, f"{entry.entry_id}_people_{area.id}")
    assert hass.states.get(home_eid).state == "0"
    assert hass.states.get(home_eid).attributes["friendly_name"] == "Home Occupants"
    assert hass.states.get(floor_eid).attributes["friendly_name"] == "Home Ground floor occupants"
    assert hass.states.get(space_eid).attributes["friendly_name"] == "Entry Occupants"  # on the room's own device

    # The entry has no room shape: its own device (model Room) holds its occupancy and its occupants.
    occ_eid = ent_reg.async_get_entity_id("binary_sensor", DOMAIN, f"{entry.entry_id}_occupied_{area.id}")
    room_dev = dr.async_get(hass).async_get(ent_reg.async_get(space_eid).device_id)
    assert room_dev.model == "Room" and room_dev.name == "Entry" and ent_reg.async_get(occ_eid).device_id == room_dev.id
    assert hass.states.get(occ_eid).state == "off"
    for k in range(8):  # someone in the room for a while (no door: counted while the home starts up)
        await move(hass, 1, -40 + k, 120)
        await _tick(hass, freezer, 4)
    assert hass.states.get(home_eid).state == "1"
    assert hass.states.get(occ_eid).state == "on"
    assert hass.states.get(floor_eid).state == "1" and hass.states.get(space_eid).state == "1"

    hass.states.async_set("binary_sensor.front_door", "on")
    await hass.async_block_till_done()
    state = hass.states.get(home_eid)
    assert state.state == "unknown" and state.attributes["at_least"] == 0  # the door is in use
    await move(hass, 1, 40, 30)  # to the door...
    await _tick(hass, freezer, 2)
    await move(hass, 1, 0, 0)  # ...and gone
    await _tick(hass, freezer, 2)
    hass.states.async_set("binary_sensor.front_door", "off")
    await hass.async_block_till_done()
    await _tick(hass, freezer, 30)
    assert hass.states.get(home_eid).state == "unknown"  # just closed
    for _ in range(14):
        await _tick(hass, freezer, 60)
    assert hass.states.get(home_eid).state == "0"
    assert hass.states.get(floor_eid).state == "0"


async def test_head_count_leaves_out_radars_switched_off(hass: HomeAssistant, radar_device: str) -> None:
    from homeassistant.helpers import area_registry as ar

    area = ar.async_get(hass).async_create("Garage")
    dr.async_get(hass).async_update_device(radar_device, area_id=area.id)
    entry = MockConfigEntry(
        domain=DOMAIN, title="Home", version=2, data={}, options={"reconnect_grace_s": 0},
        subentries_data=[{**radar_subentry(radar_device), "data": {**radar_subentry(radar_device)["data"], "headcount": False}}],
    )
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    assert entry.runtime_data.headcount.hc is None  # no space left: no head count sensors
    assert er.async_get(hass).async_get_entity_id("sensor", DOMAIN, f"{entry.entry_id}_people") is None


async def test_exit_leads_to_and_head_count_switch_round_trip(hass: HomeAssistant, radar_device: str, hass_ws_client) -> None:
    from homeassistant.helpers import area_registry as ar

    areas = ar.async_get(hass)
    entry_area = areas.async_create("Entry")
    garage = areas.async_create("Garage")
    dr.async_get(hass).async_update_device(radar_device, area_id=entry_area.id)
    await setup_entry(hass, radar_device)
    client = await hass_ws_client(hass)
    await client.send_json_auto_id(
        {
            "type": f"{DOMAIN}/zones/save",
            "radar_id": RADAR,
            "zones": [
                {"id": "zfront", "name": "Front door", "kind": "exit", "door_entity_id": "binary_sensor.front_door",
                 "leads_to": ["outside"], "polygon": mm([[-60, 50], [-20, 50], [-20, 90], [-60, 90]])},
                {"id": "zgarage", "name": "Garage door", "kind": "exit", "door_entity_id": "binary_sensor.garage_entry",
                 "leads_to": [garage.id], "polygon": mm([[20, 50], [60, 50], [60, 90], [20, 90]])},
            ],
            "settings": {"headcount": True},
        }
    )
    saved = (await client.receive_json())["result"]["zones"]
    assert [z["leads_to"] for z in saved] == [["outside"], [garage.id]]
    await hass.async_block_till_done()
    await client.send_json_auto_id({"type": f"{DOMAIN}/config", "radar_id": RADAR})
    cfg = (await client.receive_json())["result"]
    assert cfg["settings"]["headcount"] is True
    assert [z.get("leads_to") for z in cfg["zones"]] == [["outside"], [garage.id]]

    await client.send_json_auto_id({"type": f"{DOMAIN}/headcount"})
    hc = (await client.receive_json())["result"]
    spaces = {s["id"]: s for s in hc["spaces"]}
    assert spaces[entry_area.id]["observed"] and not spaces[garage.id]["observed"]  # the garage has no radar
    assert spaces[entry_area.id]["exits"] == ["binary_sensor.front_door"]
    assert {p["name"]: p["to"] for p in spaces[entry_area.id]["portals"]} == {"Front door": [], "Garage door": [garage.id]}
    assert hc["connections"] == [sorted([entry_area.id, garage.id]) + ["binary_sensor.garage_entry"]]


async def test_switches_used_by_hand_are_evidence(hass: HomeAssistant, radar_device: str) -> None:
    """A light switched by hand puts the unseen person in its room; switched by an automation it says nothing."""
    from homeassistant.core import Context
    from homeassistant.helpers import area_registry as ar, floor_registry as fr

    floor = fr.async_get(hass).async_create("Upstairs", level=1)
    hall = ar.async_get(hass).async_create("Hall", floor_id=floor.floor_id)
    den = ar.async_get(hass).async_create("Den", floor_id=floor.floor_id)
    dr.async_get(hass).async_update_device(radar_device, area_id=hall.id)
    ent_reg = er.async_get(hass)
    for name in ("den", "den_fan"):
        ent = ent_reg.async_get_or_create("light", "test", name, suggested_object_id=name)
        ent_reg.async_update_entity(ent.entity_id, area_id=den.id)
        hass.states.async_set(ent.entity_id, "off")
    door = {**zone("door", "Den door", [[20, 10], [60, 10], [60, 50], [20, 50]], kind="exit"), "leads_to": [den.id]}
    entry = await setup_entry(hass, radar_device, [door])
    hass.config_entries.async_update_entry(entry, options={**entry.options, "evidence": ["light.den"], "evidence_on": ["light.den_fan"]})
    await hass.async_block_till_done()
    rt = entry.runtime_data.headcount
    assert rt._evidence == {"light.den": (den.id, False), "light.den_fan": (den.id, True)}
    hc = rt.hc
    hc.seed(hall.id, 1, 0.0)  # someone upstairs, unseen in the hall

    def evidence() -> list[str]:
        return [c.region for c in hc.changes if c.kind == "evidence"]

    hass.states.async_set("light.den", "on", context=Context(parent_id="automation-run"))
    hass.states.async_set("light.den", "off", context=Context(user_id="someone-in-the-app"))
    await hass.async_block_till_done()
    assert evidence() == [] and hc.by_region()[hall.id] == 1
    hass.states.async_set("light.den_fan", "on", context=Context(parent_id="automation-run"))
    hass.states.async_set("light.den_fan", "off")  # its timer ran out: says nothing
    await hass.async_block_till_done()
    assert evidence() == []
    hass.states.async_set("light.den", "on")  # the wall switch
    await hass.async_block_till_done()
    assert evidence() == [den.id] and hc.by_region() == {hall.id: 0, den.id: 1} and hc.count() == 1
    hass.states.async_set("light.den_fan", "on")
    await hass.async_block_till_done()
    assert evidence() == [den.id, den.id] and hc.count() == 1  # never adds anyone
    # A button (event entity) restoring its last press at start-up is not a press.
    btn = ent_reg.async_get_or_create("event", "test", "den_button", suggested_object_id="den_button")
    ent_reg.async_update_entity(btn.entity_id, area_id=den.id)
    rt._evidence[btn.entity_id] = (den.id, False)
    await rt.async_start()  # resubscribe with the button included
    hass.states.async_set(btn.entity_id, "2026-01-01T00:00:00+00:00")
    await hass.async_block_till_done()
    assert len(evidence()) == 2
    # "Nobody home": the button on the Home device clears the head count.
    button = ent_reg.async_get_entity_id("button", DOMAIN, f"{entry.entry_id}_nobody_home")
    await hass.services.async_call("button", "press", {"entity_id": button}, blocking=True)
    assert hc.count() == 0
    # The decision log the panel replays: ignored signals with why, used ones, and what they did.
    log = rt.history(0, float("inf"))["log"]
    kinds = [(e["kind"], e.get("entity")) for e in log if e["kind"] in ("signal", "ignored", "evidence")]
    assert ("ignored", "light.den") in kinds and ("signal", "light.den") in kinds and ("evidence", None) in kinds
    assert any("only switching on counts" in e["detail"] for e in log if e["kind"] == "ignored")
    moved = next(e for e in log if e["kind"] == "evidence")
    assert [t[1] for t in moved["tokens"]] == [den.id]  # who is where after it


async def test_a_flickering_door_contact_is_not_evidence(hass: HomeAssistant, radar_device: str, freezer) -> None:
    """A closet contact at the edge of its magnet's range flickers open for a fraction of a second: ignored."""
    from homeassistant.helpers import area_registry as ar, floor_registry as fr

    floor = fr.async_get(hass).async_create("Upstairs", level=1)
    hall = ar.async_get(hass).async_create("Hall", floor_id=floor.floor_id)
    den = ar.async_get(hass).async_create("Den", floor_id=floor.floor_id)
    dr.async_get(hass).async_update_device(radar_device, area_id=hall.id)
    ent_reg = er.async_get(hass)
    ent = ent_reg.async_get_or_create("binary_sensor", "test", "closet", suggested_object_id="closet")
    ent_reg.async_update_entity(ent.entity_id, area_id=den.id)
    hass.states.async_set(ent.entity_id, "off")
    door = {**zone("door", "Den door", [[20, 10], [60, 10], [60, 50], [20, 50]], kind="exit"), "leads_to": [den.id]}
    entry = await setup_entry(hass, radar_device, [door])
    hass.config_entries.async_update_entry(entry, options={**entry.options, "evidence": [ent.entity_id]})
    await hass.async_block_till_done()
    rt = entry.runtime_data.headcount
    rt.hc.seed(hall.id, 1, 0.0)

    hass.states.async_set(ent.entity_id, "on")
    await _tick(hass, freezer, 0.4)
    hass.states.async_set(ent.entity_id, "off")
    await _tick(hass, freezer, 5)
    assert rt.hc.by_region()[den.id] == 0
    assert any("flickering" in e["detail"] for e in rt.log if e["kind"] == "ignored")

    hass.states.async_set(ent.entity_id, "on")  # opened for real
    await _tick(hass, freezer, 3)
    assert rt.hc.by_region()[den.id] == 1
    hass.states.async_set(ent.entity_id, "off")
    await _tick(hass, freezer, 1)
    assert rt.hc.count() == 1


def _device_with(hass: HomeAssistant, name: str, entities: list[tuple[str, str]]) -> list[str]:
    """A device (a smart lock, a robot vacuum) with these (domain, key) entities; their entity ids."""
    source = MockConfigEntry(domain="demo", title=name)
    source.add_to_hass(hass)
    dev = dr.async_get(hass).async_get_or_create(config_entry_id=source.entry_id, identifiers={("demo", name)}, name=name)
    ent_reg = er.async_get(hass)
    return [
        ent_reg.async_get_or_create(domain, "demo", f"{name}_{key}", suggested_object_id=f"{name}_{key}", device_id=dev.id).entity_id
        for domain, key in entities
    ]


async def test_a_locked_door_is_closed_whatever_its_contact_says(hass: HomeAssistant, radar_device: str, freezer) -> None:
    """A smart lock's door sensor stayed "open" all night after the door was locked: locked means closed."""
    from homeassistant.helpers import area_registry as ar, floor_registry as fr

    floor = fr.async_get(hass).async_create("Ground floor", level=0)
    area = ar.async_get(hass).async_create("Entry", floor_id=floor.floor_id)
    dr.async_get(hass).async_update_device(radar_device, area_id=area.id)
    contact, lock = _device_with(hass, "front_lock", [("binary_sensor", "door"), ("lock", "lock")])
    hass.states.async_set(contact, "off")
    hass.states.async_set(lock, "locked")
    door = {
        **zone("door", "Front door", [[20, 10], [60, 10], [60, 50], [20, 50]], kind="exit"),
        "door_entity_id": contact,
        "leads_to": ["outside"],
    }
    entry = await setup_entry(hass, radar_device, [door])
    rt = entry.runtime_data.headcount
    assert rt._lock_of == {contact: lock}
    is_open = lambda: rt.hc._door_seen.get(contact, (False,))[0]  # noqa: E731

    hass.states.async_set(lock, "unlocked")
    hass.states.async_set(contact, "on")
    await _tick(hass, freezer, 3)
    assert is_open()
    hass.states.async_set(lock, "locked")  # the contact still says open
    await _tick(hass, freezer, 1)
    assert not is_open()
    assert any(e["detail"] == "off (locked)" for e in rt.log if e["kind"] == "door")

    hass.states.async_set(contact, "off")
    hass.states.async_set(contact, "on")  # while locked: the sensor is wrong
    await _tick(hass, freezer, 1)
    assert not is_open()
    assert any("locked, so it is closed" in e["detail"] for e in rt.log if e["kind"] == "ignored")

    hass.states.async_set(lock, "unlocked")  # the contact says open already: now it counts
    await _tick(hass, freezer, 1)
    assert is_open()


async def test_a_robot_vacuum_is_not_a_person(hass: HomeAssistant, radar_device: str, freezer) -> None:
    """While the vacuum cleans a room, that room's radar is ignored; it says which room only after a while, so
    the head count replays those minutes once it does."""
    from homeassistant.helpers import area_registry as ar, floor_registry as fr

    floor = fr.async_get(hass).async_create("Ground floor", level=0)
    area = ar.async_get(hass).async_create("Entry", floor_id=floor.floor_id)
    dr.async_get(hass).async_update_device(radar_device, area_id=area.id)
    vac, room = _device_with(hass, "robo", [("vacuum", "vacuum"), ("sensor", "current_room")])
    hass.states.async_set(vac, "docked")
    hass.states.async_set(room, "Pantry")
    entry = await setup_entry(hass, radar_device, [])
    hass.config_entries.async_update_entry(entry, options={**entry.options, "vacuums": [vac]})
    await hass.async_block_till_done()
    rt = entry.runtime_data.headcount
    assert rt._vacuums == {vac: room}
    rt.hc._bootstrap_until = float("-inf")

    hass.states.async_set(vac, "cleaning")
    hass.states.async_set(room, "unknown")
    await hass.async_block_till_done()
    assert rt._hold is not None
    for k in range(20):  # it roams the entry: 80 s, more than an unexplained person needs
        await move(hass, 1, -40 + 3 * k, 60 + (k % 5) * 10)
        await _tick(hass, freezer, 4)
    assert rt.hc.count() == 0
    hass.states.async_set(room, "ENTRY’")  # its own spelling
    await hass.async_block_till_done()
    assert rt._hold is None and area.id in rt._vacuumed
    for k in range(20):
        await move(hass, 1, 20 - 3 * k, 60 + (k % 5) * 10)
        await _tick(hass, freezer, 4)
    assert rt.hc.count() == 0
    assert any("replayed" in e["detail"] for e in rt.log if e["kind"] == "signal")

    hass.states.async_set(vac, "docked")  # done: someone seen there now is someone
    await hass.async_block_till_done()
    assert not rt._vacuumed and not rt.hc.changes
    await move(hass, 1, 0, 0)
    await _tick(hass, freezer, 4)
    for k in range(25):
        await move(hass, 1, -40 + 4 * (k % 20), 100 + 2 * (k % 7))
        await _tick(hass, freezer, 4)
    assert [c.kind for c in rt.hc.changes] == ["unexplained"]  # (a person once seen for a while)


async def _entry_with_front_door(
    hass: HomeAssistant, radar_device: str, contact: str, extra_options: dict | None = None, in_area: tuple[str, ...] = ()
):
    """An entry room with a front door exit zone (door: `contact`); `in_area`: entities put in the room too."""
    from homeassistant.helpers import area_registry as ar, floor_registry as fr

    floor = fr.async_get(hass).async_create("Ground floor", level=0)
    area = ar.async_get(hass).async_create("Entry", floor_id=floor.floor_id)
    dr.async_get(hass).async_update_device(radar_device, area_id=area.id)
    for entity_id in in_area:  # (a device's entities take its area)
        dr.async_get(hass).async_update_device(er.async_get(hass).async_get(entity_id).device_id, area_id=area.id)
    door = {
        **zone("door", "Front door", [[20, 10], [60, 10], [60, 50], [20, 50]], kind="exit"),
        "door_entity_id": contact,
        "leads_to": ["outside"],
    }
    entry = await setup_entry(hass, radar_device, [door])
    if extra_options:
        hass.config_entries.async_update_entry(entry, options={**entry.options, **extra_options})
        await hass.async_block_till_done()
    rt = entry.runtime_data.headcount
    rt.hc._bootstrap_until = float("-inf")
    return entry, rt, area


async def test_ec74_a_lock_alone_as_an_outside_door_pulses(hass: HomeAssistant, radar_device: str, freezer) -> None:
    """EC-74: a lock without a door contact of its own, listed as an outside door: locking or unlocking is the door
    being used (opened and closed at once), so whoever is on its floor is in doubt for a while."""
    hass.states.async_set("binary_sensor.front_door", "off")
    entry, rt, area = await _entry_with_front_door(hass, radar_device, "binary_sensor.front_door")
    ent = er.async_get(hass).async_get_or_create("lock", "test", "back_door", suggested_object_id="back_door")
    er.async_get(hass).async_update_entity(ent.entity_id, area_id=area.id)
    hass.states.async_set("lock.back_door", "locked")
    hass.config_entries.async_update_entry(entry, options={**entry.options, "outside_doors": ["lock.back_door"]})
    await hass.async_block_till_done()
    rt = entry.runtime_data.headcount
    assert rt._door_kind["lock.back_door"] == "lock"
    rt.hc.seed(area.id, 1, 0.0)
    hass.states.async_set("lock.back_door", "unlocked")
    await hass.async_block_till_done()
    assert rt.hc.unknown_floors() == {0} and rt.hc.count() == 0


async def test_a_lock_on_the_door_contacts_device_never_pulses(hass: HomeAssistant, radar_device: str, freezer) -> None:
    """A smart lock with its own door sensor, the sensor on the exit zone and the lock also listed as an outside
    door: the contact says when the door is used, the lock only that it is closed. Locking it is not the door used."""
    contact, lock = _device_with(hass, "front_lock", [("binary_sensor", "door"), ("lock", "lock")])
    hass.states.async_set(contact, "off")
    hass.states.async_set(lock, "unlocked")
    entry, rt, area = await _entry_with_front_door(hass, radar_device, contact, {"outside_doors": [lock]}, in_area=(lock,))
    assert lock in rt.hc.regions[area.id].exits  # (taken as an outside door)
    assert rt._door_kind[lock] == "door_lock" and rt._lock_of == {contact: lock}
    rt.hc.seed(area.id, 1, 0.0)
    hass.states.async_set(lock, "locked")
    await _tick(hass, freezer, 1)
    hass.states.async_set(lock, "unlocked")
    await _tick(hass, freezer, 1)
    assert not rt.hc.unknown_floors() and rt.hc.count() == 1
    hass.states.async_set(contact, "on")  # the door itself: used
    await _tick(hass, freezer, 1)
    assert rt.hc.unknown_floors() == {0}


async def test_ec75_an_exit_door_open_at_start_is_open(hass: HomeAssistant, radar_device: str) -> None:
    """EC-75: an exit door already open when the head count starts is fed as open (the floor is in doubt)..."""
    hass.states.async_set("binary_sensor.front_door", "on")
    _entry, rt, _area = await _entry_with_front_door(hass, radar_device, "binary_sensor.front_door")
    assert rt.hc._door_seen["binary_sensor.front_door"][0]
    assert rt.hc.unknown_floors() == {0}


async def test_ec75_unless_it_is_locked(hass: HomeAssistant, radar_device: str) -> None:
    """EC-75: ... unless its lock says locked (the contact is wrong)."""
    contact, lock = _device_with(hass, "front_lock", [("binary_sensor", "door"), ("lock", "lock")])
    hass.states.async_set(contact, "on")
    hass.states.async_set(lock, "locked")
    _entry, rt, _area = await _entry_with_front_door(hass, radar_device, contact)
    assert contact not in rt.hc._door_seen and not rt.hc.unknown_floors()


async def test_ec87_a_vacuum_that_never_says_its_room_is_replayed_after_a_while(hass: HomeAssistant, radar_device: str, freezer) -> None:
    """EC-87 / RT-VAC-2: the hold for a vacuum that has not said where it cleans ends after HOLD_MAX_S: what came
    since is replayed without knowing its room."""
    from custom_components.radar_zone_presence.headcount_runtime import HOLD_MAX_S, TICK_S
    from homeassistant.helpers import area_registry as ar, floor_registry as fr

    floor = fr.async_get(hass).async_create("Ground floor", level=0)
    area = ar.async_get(hass).async_create("Entry", floor_id=floor.floor_id)
    dr.async_get(hass).async_update_device(radar_device, area_id=area.id)
    vac, room = _device_with(hass, "robo", [("vacuum", "vacuum"), ("sensor", "current_room")])
    hass.states.async_set(vac, "docked")
    hass.states.async_set(room, "unknown")
    entry = await setup_entry(hass, radar_device, [])
    hass.config_entries.async_update_entry(entry, options={**entry.options, "vacuums": [vac]})
    await hass.async_block_till_done()
    rt = entry.runtime_data.headcount
    hass.states.async_set(vac, "cleaning")
    await hass.async_block_till_done()
    assert rt._hold is not None
    await _tick(hass, freezer, HOLD_MAX_S - TICK_S)
    assert rt._hold is not None
    await _tick(hass, freezer, 2 * TICK_S)
    assert rt._hold is None
    assert any("replayed" in e["detail"] for e in rt.log if e["kind"] == "signal")


async def test_a_bed_sensor_holds_someone_in_the_bedroom(hass: HomeAssistant, radar_device: str, freezer) -> None:
    """Occupancy sensors (a bed's two sides): while either is on, at least one person is in its room, anchored there;
    both sides on is still one person. A bounce shorter than OCCUPANCY_STEADY_S changes nothing."""
    from custom_components.radar_zone_presence.headcount_runtime import OCCUPANCY_STEADY_S
    from homeassistant.helpers import area_registry as ar, floor_registry as fr

    floor = fr.async_get(hass).async_create("Upstairs", level=1)
    hall = ar.async_get(hass).async_create("Hall", floor_id=floor.floor_id)
    bedroom = ar.async_get(hass).async_create("Bedroom", floor_id=floor.floor_id)
    dr.async_get(hass).async_update_device(radar_device, area_id=hall.id)
    ent_reg = er.async_get(hass)
    sides = []
    for name in ("bed_left", "bed_right"):
        ent = ent_reg.async_get_or_create("binary_sensor", "test", name, suggested_object_id=name)
        ent_reg.async_update_entity(ent.entity_id, area_id=bedroom.id)
        hass.states.async_set(ent.entity_id, "off")
        sides.append(ent.entity_id)
    left, right = sides
    door = {**zone("door", "Bedroom door", [[20, 10], [60, 10], [60, 50], [20, 50]], kind="exit"), "leads_to": [bedroom.id]}
    entry = await setup_entry(hass, radar_device, [door])
    hass.config_entries.async_update_entry(entry, options={**entry.options, "occupancy": sides})
    await hass.async_block_till_done()
    rt = entry.runtime_data.headcount
    assert rt._occupancy == {left: bedroom.id, right: bedroom.id}
    rt.hc.seed(hall.id, 1, 0.0)  # upstairs, unseen in the hall

    hass.states.async_set(left, "on")  # sat on the bed for a moment
    await _tick(hass, freezer, 3)
    hass.states.async_set(left, "off")
    await _tick(hass, freezer, OCCUPANCY_STEADY_S + 1)
    assert rt.hc.held() == {} and rt.hc.by_region()[bedroom.id] == 0

    hass.states.async_set(left, "on")  # in bed
    await _tick(hass, freezer, OCCUPANCY_STEADY_S + 1)
    (tok,) = rt.hc.tokens
    assert rt.hc.held() == {bedroom.id: tok} and rt.hc.by_region() == {hall.id: 0, bedroom.id: 1}
    hass.states.async_set(right, "on")  # rolls over to the middle: both sides
    await _tick(hass, freezer, OCCUPANCY_STEADY_S + 1)
    hass.states.async_set(left, "off")
    await _tick(hass, freezer, OCCUPANCY_STEADY_S + 1)
    assert rt.hc.count() == 1 and rt.hc.held() == {bedroom.id: tok}
    hass.states.async_set(right, "off")  # up
    await _tick(hass, freezer, OCCUPANCY_STEADY_S + 1)
    assert rt.hc.held() == {} and rt.hc.count() == 1
    details = [e["detail"] for e in rt.log if e["kind"] == "signal"]
    assert details.count("on: someone is there while it stays on") == 1 and details.count("off: released") == 1


@pytest.mark.parametrize("excluded", [False, True])
async def test_rt_ref_1_one_radar_track_where_another_looks_is_a_reflection_unless_it_excludes_there(
    hass: HomeAssistant, radar_device: str, second_radar: str, excluded: bool
) -> None:
    """RT-REF-1: a track only radar 1 sees, at a spot well inside radar 2's view, is flagged (a reflection until
    radar 2 confirms it), unless radar 2 excludes that spot: it does not look there (another room through a door)."""
    aligned = {"aligned_to": {"radar_id": RADAR, "angle_deg": 0, "reflect": False, "offset_mm": [2540, 0]}}
    hide = [zone("thru", "Hall through the door", [[-100, 100], [-60, 100], [-60, 140], [-100, 140]], kind="exclude")]
    radar2 = {**radar_subentry(second_radar, hide if excluded else None, subentry_id="radar2", slug=SLUG2, display=aligned),
              "title": "Kitchen radar"}
    entry = await setup_entry(hass, radar_device, [], [radar2])
    group = entry.runtime_data.groups[0]
    await move(hass, 1, 20, 120)  # (-80, 120) in radar 2's frame: inside its cone and range
    (tg,) = group.last_targets
    assert group.track_radars[tg.slot] == frozenset({0})
    assert entry.runtime_data.headcount._unconfirmed(group) == (set() if excluded else {tg.slot})


async def test_a_room_no_radar_sees_follows_its_occupants(hass: HomeAssistant, radar_device: str) -> None:
    """A room drawn where no radar looks (behind the sensor) takes its occupancy from the occupant count."""
    from homeassistant.helpers import area_registry as ar, floor_registry as fr

    floor = fr.async_get(hass).async_create("Ground floor", level=0)
    hall = ar.async_get(hass).async_create("Hall", floor_id=floor.floor_id)
    pantry = ar.async_get(hass).async_create("Pantry", floor_id=floor.floor_id)
    dr.async_get(hass).async_update_device(radar_device, area_id=hall.id)
    behind = {**zone("pantry", "Pantry", [[-40, -100], [40, -100], [40, -60], [-40, -60]]), "area_id": pantry.id}
    door = {**zone("door", "Pantry door", [[-10, 5], [10, 5], [10, 15], [-10, 15]], kind="exit"), "leads_to": [pantry.id]}
    await setup_entry(hass, radar_device, [behind, door])
    state = hass.states.get(eid(hass, "pantry"))
    assert state.attributes.get("from_occupants") is True and state.state == "off"


async def test_todo_answers_are_kept_on_the_server(hass: HomeAssistant, radar_device: str, hass_ws_client) -> None:
    """Another browser does not ask again: answers live in a store, and can be forgotten."""
    await setup_entry(hass, radar_device, [])
    client = await hass_ws_client(hass)
    await client.send_json_auto_id({"type": f"{DOMAIN}/todo/answer", "key": "radar1:spot:3,4", "answer": "nothing"})
    assert (await client.receive_json())["success"]
    await client.send_json_auto_id({"type": f"{DOMAIN}/todo/answers"})
    assert (await client.receive_json())["result"]["answers"]["radar1:spot:3,4"]["answer"] == "nothing"
    await client.send_json_auto_id({"type": f"{DOMAIN}/todo/answer", "key": "radar1:spot:3,4", "answer": None})
    assert (await client.receive_json())["success"]
    await client.send_json_auto_id({"type": f"{DOMAIN}/todo/answers"})
    assert "radar1:spot:3,4" not in (await client.receive_json())["result"]["answers"]


async def test_learning_finished_tells_once_when_a_radar_has_suggestions(hass: HomeAssistant, radar_device: str) -> None:
    """After 3 days with 2 places where something stays (not covered by a spot or ignore area, not answered),
    one persistent notification links to To do; places that are answered do not count."""
    from types import SimpleNamespace
    from unittest.mock import patch

    from custom_components.radar_zone_presence import learning as lm

    entry = await setup_entry(hass, radar_device, [zone("fan", "Fan", [[100, 100], [120, 100], [120, 120], [100, 120]], kind="exclude")])
    lr = entry.runtime_data.learning
    await move(hass, 1, 10, 50)  # frames reach the tally
    await move(hass, 1, 10, 51)
    assert lr.state[RADAR]["grid"]
    st = lr.state[RADAR]
    st["grid"], st["since"] = {}, st["since"] - 3.5 * lm.DAY
    seat, bed, fan = (1000, 1000), (-1000, 2000), (110 * 25.4, 110 * 25.4)
    t = 0.0
    for _ in range(3 * 3600 // 20):  # 3 h each, one frame every 20 s
        lr.observe(RADAR, t, tuple(SimpleNamespace(x=x, y=y) for x, y in (seat, bed, fan)))
        t += 20
    assert {(p["x"] // 300, p["y"] // 300) for p in lr.places(RADAR)} == {(3, 3), (-4, 6)}  # the fan is ignored already
    lr.store.set(f"{RADAR}:spot:{round(lr.places(RADAR)[0]['x'] / 300)},{round(lr.places(RADAR)[0]['y'] / 300)}", "nothing")
    with patch.object(lm.persistent_notification, "async_create") as create:
        lr._check()
        assert not create.called  # one place left: not yet (a week)
        lr.store.answers.clear()
        lr._check()
        assert create.call_count == 1
        assert "2 suggestions" in create.call_args.args[1] and lm.PANEL_URL in create.call_args.args[1]
        lr._check()
        assert create.call_count == 1  # once


async def test_settings_are_read_and_saved_from_the_panel(hass: HomeAssistant, radar_device: str, hass_ws_client) -> None:
    """The panel's Settings page: the options form's fields, validated by domain; a save reloads the home."""
    entry = await setup_entry(hass, radar_device, [])
    client = await hass_ws_client(hass)
    await client.send_json_auto_id({"type": f"{DOMAIN}/settings/save", "vacuums": ["vacuum.robot"], "occupancy": ["binary_sensor.bed"]})
    assert (await client.receive_json())["success"]
    await hass.async_block_till_done()
    await client.send_json_auto_id({"type": f"{DOMAIN}/settings"})
    res = (await client.receive_json())["result"]
    assert res["vacuums"] == ["vacuum.robot"] and res["occupancy"] == ["binary_sensor.bed"] and res["outside_doors"] == []
    assert entry.options["reconnect_grace_s"] == 0  # kept
    await client.send_json_auto_id({"type": f"{DOMAIN}/settings/save", "vacuums": ["light.kitchen"]})
    assert not (await client.receive_json())["success"]
