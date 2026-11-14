"""Find radar devices and their per-target coordinate entities."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any

from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import device_registry as dr, entity_registry as er

from .const import DEFAULT_MAX_DISTANCE_MM, PROFILE_EVERYTHING_PRESENCE, PROFILE_GENERIC, PROFILE_SCREEK_2A
from .engine import TargetEntities, to_mm

TARGET_RE = re.compile(r"^sensor\.(?P<slug>.+?)_target(?P<sep>_?)(?P<slot>\d)_(?P<axis>x|y)$")
# Device-side rectangles, for display only. EP: zone_1_begin_x / occupancy_mask_1_end_y;
# Screek: zone1_x_begin / zout1_y_end.
DEVICE_RECT_RE = re.compile(
    r"^number\..+?_(?P<key>zone_?\d|occupancy_mask_\d|zout\d)_"
    r"(?P<field>begin_x|end_x|begin_y|end_y|x_begin|x_end|y_begin|y_end)$"
)
MAX_DISTANCE_RE = re.compile(r"^number\..+_max_distance$")


@dataclass
class RadarDevice:
    device_id: str
    name: str
    area_id: str | None
    profile: str
    slug: str
    targets: list[TargetEntities]
    extra: dict[str, str] = field(default_factory=dict)  # role -> entity_id

    def as_entry_data(self) -> list[dict[str, Any]]:
        return [{"slot": t.slot, "x": t.x, "y": t.y} for t in self.targets]


@callback
def async_find_radars(hass: HomeAssistant) -> list[RadarDevice]:
    """All devices exposing per-target X and Y sensors."""
    ent_reg = er.async_get(hass)
    dev_reg = dr.async_get(hass)
    by_device: dict[str, dict[int, dict[str, str]]] = {}
    meta: dict[str, tuple[str, str]] = {}
    for entry in ent_reg.entities.values():
        if entry.device_id is None or entry.disabled_by is not None:
            continue
        m = TARGET_RE.match(entry.entity_id)
        if not m:
            continue
        by_device.setdefault(entry.device_id, {}).setdefault(int(m["slot"]), {})[m["axis"]] = entry.entity_id
        profile = PROFILE_EVERYTHING_PRESENCE if m["sep"] else PROFILE_SCREEK_2A
        meta[entry.device_id] = (m["slug"], profile)

    radars = []
    for device_id, slots in by_device.items():
        targets = [TargetEntities(n, v["x"], v["y"]) for n, v in sorted(slots.items()) if "x" in v and "y" in v]
        device = dev_reg.async_get(device_id)
        if not targets or device is None:
            continue
        slug, profile = meta[device_id]
        if device.manufacturer and "screek" not in device.manufacturer.lower() and profile == PROFILE_SCREEK_2A:
            profile = PROFILE_GENERIC
        radars.append(
            RadarDevice(
                device_id=device_id,
                name=device.name_by_user or device.name or slug,
                area_id=device.area_id,
                profile=profile,
                slug=slug,
                targets=targets,
            )
        )
    radars.sort(key=lambda r: r.name.lower())
    return radars


def _float_state(hass: HomeAssistant, entity_id: str) -> tuple[float, str | None] | None:
    state = hass.states.get(entity_id)
    if state is None:
        return None
    try:
        return float(state.state), state.attributes.get("unit_of_measurement")
    except ValueError:
        return None


@callback
def async_device_geometry(hass: HomeAssistant, device_id: str) -> dict[str, Any]:
    """Read-only overlay info from the device: max distance and firmware zones (mm)."""
    ent_reg = er.async_get(hass)
    rects: dict[str, dict[str, float]] = {}
    max_distance = DEFAULT_MAX_DISTANCE_MM
    for entry in er.async_entries_for_device(ent_reg, device_id):
        if entry.disabled_by is not None:
            continue
        if MAX_DISTANCE_RE.match(entry.entity_id):
            if (v := _float_state(hass, entry.entity_id)) is not None:
                max_distance = to_mm(v[0], v[1])
            continue
        m = DEVICE_RECT_RE.match(entry.entity_id)
        if not m or (v := _float_state(hass, entry.entity_id)) is None:
            continue
        fieldname = m["field"]
        if "_" in fieldname and fieldname[0] in "xy":  # x_begin -> begin_x
            axis, edge = fieldname.split("_")
            fieldname = f"{edge}_{axis}"
        rects.setdefault(m["key"], {})[fieldname] = to_mm(v[0], v[1] or "mm")

    device_zones = []
    for key, r in sorted(rects.items()):
        if len(r) != 4:
            continue
        x0, x1, y0, y1 = r["begin_x"], r["end_x"], r["begin_y"], r["end_y"]
        if x0 == x1 or y0 == y1:
            continue  # unused
        exclude = "mask" in key or "zout" in key
        device_zones.append(
            {
                "key": key,
                "kind": "exclude" if exclude else "include",
                "polygon": [[x0, y0], [x1, y0], [x1, y1], [x0, y1]],
            }
        )
    return {"max_distance_mm": max_distance, "device_zones": device_zones}


@callback
def async_legacy_polygons(hass: HomeAssistant, slug: str, unit: str | None) -> list[dict[str, Any]]:
    """input_text.<slug>_zone_polygon_<n> helpers from the hand-rolled setup, in mm."""
    prefix = f"input_text.{slug}_zone_polygon_"
    out = []
    for state in hass.states.async_all("input_text"):
        if not state.entity_id.startswith(prefix):
            continue
        try:
            pts = json.loads(state.state)
            polygon = [[round(to_mm(float(p[0]), unit), 1), round(to_mm(float(p[1]), unit), 1)] for p in pts]
        except (ValueError, TypeError, IndexError):
            continue
        if len(polygon) >= 3:
            out.append({"entity_id": state.entity_id, "n": state.entity_id.removeprefix(prefix), "polygon": polygon})
    out.sort(key=lambda p: p["n"])
    return out
