"""Zones as virtual presence devices: one device per include zone, in its own area."""

from __future__ import annotations

from homeassistant.helpers.device_registry import DeviceInfo

from .const import DOMAIN, MANUFACTURER, PANEL_URL, VERSION, ZONE_MODEL
from .engine import Zone


def zone_device_identifier(zone_id: str) -> tuple[str, str]:
    """Zone ids are random and unique, so the device does not depend on the config entry."""
    return (DOMAIN, f"zone_{zone_id}")


def zone_device_name(name: str) -> str:
    """'Desk' -> 'Desk Presence' (avoids ambiguity with the area / other devices)."""
    name = name.strip()
    return name if name.lower().endswith("presence") else f"{name} Presence"


def zone_device_info(zone: Zone, radar_id: str, radar_device_id: str | None) -> DeviceInfo:
    info = DeviceInfo(
        identifiers={zone_device_identifier(zone.id)},
        name=zone_device_name(zone.name),
        manufacturer=MANUFACTURER,
        model=ZONE_MODEL,
        sw_version=VERSION,
        configuration_url=f"homeassistant://{PANEL_URL}#radar={radar_id}&zone={zone.id}",
    )
    if radar_device_id:
        info["via_device_id"] = radar_device_id  # "Connected via" the radar it is drawn on
    return info
