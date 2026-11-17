"""Constants for Radar Zone Presence."""

from __future__ import annotations

import json
from pathlib import Path

DOMAIN = "radar_zone_presence"
VERSION: str = json.loads((Path(__file__).parent / "manifest.json").read_text())["version"]

MANUFACTURER = "Radar Zone Presence"
ZONE_MODEL = "Presence zone"
RADAR_MODEL = "Radar exits"

CONF_DEVICE_ID = "device_id"
CONF_PROFILE = "profile"
CONF_TARGETS = "targets"
CONF_ZONES = "zones"
CONF_RECONNECT_GRACE = "reconnect_grace_s"
CONF_DISPLAY = "display"
CONF_UNIT = "unit"  # last known unit of the coordinate entities (fallback)
CONF_RADAR = "radar"  # zone subentry: the radar subentry whose frame the polygon is drawn in
CONF_IMPORT_ZONES = "import_zones"  # radar subentry: legacy polygons to turn into zones on setup
CONF_HEADCOUNT = "headcount"  # radar subentry: use this radar for the head count (default on)
CONF_OUTSIDE_DOORS = "outside_doors"  # home options: doors / locks to outside no radar sees (e.g. a garage door)
CONF_EVIDENCE = "evidence"  # home options: switches / door contacts that mean someone is in their area when used by hand
CONF_EVIDENCE_ON = "evidence_on"  # ... only when switched on by hand (off can be a timer)
CONF_VACUUMS = "vacuums"  # home options: robot vacuums; while one cleans, the radars in its room are ignored
OUTSIDE = "outside"  # exit zones: leads_to value for a door to outside

SUBENTRY_RADAR = "radar"
SUBENTRY_ZONE = "zone"

PROFILE_EVERYTHING_PRESENCE = "everything_presence"
PROFILE_SCREEK_2A = "screek_2a"
PROFILE_GENERIC = "generic"

PANEL_URL = "radar-zones"
PANEL_COMPONENT = "radar-zone-presence-panel"
STATIC_URL = "/radar_zone_presence_static"

PRESENCE_KEY = "presence"

# The LD2450 module reports targets up to 8 m (±60°). Firmwares with a max distance
# setting (Everything Presence: number.*_max_distance) cut shorter; that wins.
DEFAULT_MAX_DISTANCE_MM = 8000.0
FOV_HALF_ANGLE_DEG = 60.0
