"""Constants for Radar Zone Presence."""

from __future__ import annotations

DOMAIN = "radar_zone_presence"

CONF_DEVICE_ID = "device_id"
CONF_PROFILE = "profile"
CONF_TARGETS = "targets"
CONF_ZONES = "zones"
CONF_RECONNECT_GRACE = "reconnect_grace_s"
CONF_DISPLAY = "display"

PROFILE_EVERYTHING_PRESENCE = "everything_presence"
PROFILE_SCREEK_2A = "screek_2a"
PROFILE_GENERIC = "generic"

PANEL_URL = "radar-zones"
PANEL_COMPONENT = "radar-zone-presence-panel"
STATIC_URL = "/radar_zone_presence_static"

PRESENCE_KEY = "presence"

DEFAULT_MAX_DISTANCE_MM = 6000.0
FOV_HALF_ANGLE_DEG = 60.0
