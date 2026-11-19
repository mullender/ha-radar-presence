"""History websocket commands against a real (in-memory) recorder."""

from __future__ import annotations

from datetime import timedelta

import pytest

from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

from custom_components.radar_zone_presence.const import DOMAIN

from .conftest import SLUG
from .test_integration import CHAIR_IN, RADAR, move, setup_entry, zone


@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(recorder_mock, enable_custom_integrations):
    """Override: the recorder must be set up before hass."""
    yield


async def test_ws_history_frames(hass: HomeAssistant, radar_device: str, hass_ws_client, freezer) -> None:
    entry = await setup_entry(hass, radar_device, [zone("chair", "Reading chair", CHAIR_IN)])
    start = dt_util.utcnow() - timedelta(minutes=1)
    for i in range(5):
        freezer.tick(0.3)
        await move(hass, 1, 10 + i, 120)
    await hass.async_add_executor_job(__import__('homeassistant.components.recorder', fromlist=['get_instance']).get_instance(hass).block_till_done)
    freezer.tick(1)
    client = await hass_ws_client(hass)
    await client.send_json_auto_id(
        {"type": f"{DOMAIN}/frames/history", "radar_id": RADAR, "start": start.isoformat()}
    )
    res = (await client.receive_json())["result"]
    assert len(res["x"]) >= 5
    assert res["x"][-1] == round(14 * 25.4)
    await client.send_json_auto_id(
        {"type": f"{DOMAIN}/zone_events", "radar_id": RADAR, "start": start.isoformat()}
    )
    ev = (await client.receive_json())["result"]["zones"]
    assert any(s == "on" for _, s in ev["chair"])


async def test_history_units_survive_unitless_state(hass: HomeAssistant, radar_device: str, hass_ws_client, freezer) -> None:
    """Regression: a restored/unavailable state without a unit made history treat inches as mm."""
    entry = await setup_entry(hass, radar_device, [zone("chair", "Reading chair", CHAIR_IN)])
    start = dt_util.utcnow() - timedelta(minutes=1)
    for i in range(3):
        freezer.tick(0.3)
        await move(hass, 2, 100 + i, 130)
    freezer.tick(0.3)
    # Target 2 goes "unavailable" with no unit attribute (like a restored state after restart).
    hass.states.async_set(f"sensor.{SLUG}_target_2_x", "unavailable", {"restored": True})
    hass.states.async_set(f"sensor.{SLUG}_target_2_y", "unavailable", {"restored": True})
    await hass.async_block_till_done()
    await hass.async_add_executor_job(
        __import__("homeassistant.components.recorder", fromlist=["get_instance"]).get_instance(hass).block_till_done
    )
    freezer.tick(1)
    client = await hass_ws_client(hass)
    await client.send_json_auto_id(
        {"type": f"{DOMAIN}/frames/history", "radar_id": RADAR, "start": start.isoformat()}
    )
    res = (await client.receive_json())["result"]
    xs = [x for s, x in zip(res["slot"], res["x"]) if s == 2]
    assert xs and min(xs) == round(100 * 25.4)  # inches converted, not read as mm


async def test_report_a_problem_is_anonymized(hass: HomeAssistant, radar_device: str, hass_ws_client, freezer) -> None:
    """A problem report carries the readings, config and Activity of one window, with no names, entity ids or dates."""
    import json

    from homeassistant.helpers import area_registry as ar, device_registry as dr, floor_registry as fr

    floor = fr.async_get(hass).async_create("Ground floor", level=0)
    area = ar.async_get(hass).async_create("Mullender study", floor_id=floor.floor_id)
    dr.async_get(hass).async_update_device(radar_device, area_id=area.id)
    door = {**zone("door", "Back door to the garden", [[20, 10], [60, 10], [60, 50], [20, 50]], kind="exit"),
            "door_entity_id": "binary_sensor.back_door_contact", "leads_to": ["outside"]}
    hass.states.async_set("binary_sensor.back_door_contact", "off", {"device_class": "door"})
    await setup_entry(hass, radar_device, [zone("chair", "Reading chair", CHAIR_IN), door])
    start = dt_util.utcnow()
    for i in range(5):
        freezer.tick(0.5)
        await move(hass, 1, 10 + i, 120)
    hass.states.async_set("binary_sensor.back_door_contact", "on", {"device_class": "door"})
    await hass.async_block_till_done()
    await hass.async_add_executor_job(__import__("homeassistant.components.recorder", fromlist=["get_instance"]).get_instance(hass).block_till_done)
    freezer.tick(1)
    end = dt_util.utcnow()
    client = await hass_ws_client(hass)
    await client.send_json_auto_id({"type": f"{DOMAIN}/report/build", "start": start.timestamp() - 5, "end": end.timestamp(), "symptom": "count_wrong", "expected": "two of us"})
    rep = (await client.receive_json())["result"]
    text = json.dumps(rep)
    for secret in ("Mullender", "study", "Reading chair", "Back door", "garden", SLUG, "back_door_contact", area.id, f"{start.year}-", str(int(start.timestamp()))[:5]):
        assert secret not in text, secret
    assert rep["format"] == "radar-presence-report/1" and rep["meta"]["expected"] == "two of us"
    radar = rep["radars"][0]
    assert radar["config"]["title"] == "Radar 1"
    hist = radar["export"]["history"]
    assert "sensor.radar_1_target_1_x" in hist and len(hist["sensor.radar_1_target_1_x"]) >= 5
    assert rep["meta"]["window"]["start"] == 946684800.0  # 2000-01-01, time of day not kept
    assert any(rows for rows in rep["doors"].values())
