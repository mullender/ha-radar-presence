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
