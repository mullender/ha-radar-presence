"""Constants for Radar Zone Presence."""

from __future__ import annotations

import json
from pathlib import Path

DOMAIN = "radar_zone_presence"
VERSION: str = json.loads((Path(__file__).parent / "manifest.json").read_text())["version"]

MANUFACTURER = "Radar Zone Presence"
ZONE_MODEL = "Presence zone"

CONF_DEVICE_ID = "device_id"
CONF_PROFILE = "profile"
CONF_TARGETS = "targets"
CONF_ZONES = "zones"
CONF_RECONNECT_GRACE = "reconnect_grace_s"
CONF_DISPLAY = "display"
CONF_UNIT = "unit"  # last known unit of the coordinate entities (fallback)
CONF_RADAR = "radar"  # zone subentry: the radar subentry whose frame the polygon is drawn in
CONF_IMPORT_ZONES = "import_zones"  # radar subentry: legacy polygons to turn into zones on setup

SUBENTRY_RADAR = "radar"
SUBENTRY_ZONE = "zone"

PROFILE_EVERYTHING_PRESENCE = "everything_presence"
PROFILE_SCREEK_2A = "screek_2a"
PROFILE_GENERIC = "generic"

PANEL_URL = "radar-zones"
PANEL_COMPONENT = "radar-zone-presence-panel"
STATIC_URL = "/radar_zone_presence_static"

PRESENCE_KEY = "presence"

DEFAULT_MAX_DISTANCE_MM = 6000.0
FOV_HALF_ANGLE_DEG = 60.0
