"""Zones as virtual presence devices: one device per include zone, in its own area."""

from __future__ import annotations

from typing import TYPE_CHECKING

from homeassistant.helpers.device_registry import DeviceEntry, DeviceInfo

from .const import DOMAIN, MANUFACTURER, PANEL_URL, RADAR_MODEL, ROOM_MODEL, SPOT_MODEL, VERSION
from .engine import Zone

if TYPE_CHECKING:
    from .home import RadarFeed


def zone_device_identifier(zone_id: str) -> tuple[str, str]:
    """Zone ids are random and unique, so the device does not depend on the config entry."""
    return (DOMAIN, f"zone_{zone_id}")


def zone_device_name(name: str) -> str:
    """The room or spot's own name; its entity adds "Occupancy" ("Desk Occupancy")."""
    return name.strip()


def zone_device_info(zone: Zone, radar_id: str, radar_device_id: str | None, spot: bool = False) -> DeviceInfo:
    info = DeviceInfo(
        identifiers={zone_device_identifier(zone.id)},
        name=zone_device_name(zone.name),
        manufacturer=MANUFACTURER,
        model=SPOT_MODEL if spot else ROOM_MODEL,
        sw_version=VERSION,
        configuration_url=f"homeassistant://{PANEL_URL}#radar={radar_id}&zone={zone.id}",
    )
    if radar_device_id:
        info["via_device_id"] = radar_device_id  # "Connected via" the radar it is drawn on
    return info


def radar_device_info(feed: RadarFeed, radar: DeviceEntry | None) -> DeviceInfo:
    """Our side of a radar (its exits), linked to the radar's own device through its connections.

    Devices of different integrations that share a connection show up as
    linked devices of each other, so this sits next to the ESPHome device
    rather than duplicating it.
    """
    info = DeviceInfo(
        identifiers={(DOMAIN, f"radar_{feed.device_id}")},
        name=feed.title,
        manufacturer=MANUFACTURER,
        model=RADAR_MODEL,
        sw_version=VERSION,
        configuration_url=f"homeassistant://{PANEL_URL}#radar={feed.id}",
    )
    if radar is not None and radar.connections:
        info["connections"] = set(radar.connections)
    return info
