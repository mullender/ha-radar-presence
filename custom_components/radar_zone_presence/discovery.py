"""Find radar devices and their per-target coordinate entities."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any

from homeassistant.const import ATTR_UNIT_OF_MEASUREMENT
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import device_registry as dr, entity_registry as er

from .const import DEFAULT_MAX_DISTANCE_MM, PROFILE_EVERYTHING_PRESENCE, PROFILE_GENERIC, PROFILE_SCREEK_2A
from .engine import TargetEntities, to_mm

TARGET_RE = re.compile(r"^sensor\.(?P<slug>.+?)_target(?P<sep>_?)(?P<slot>\d)_(?P<axis>x|y)$")
# Device-side rectangles, shown in the panel. EP: zone_1_begin_x / occupancy_mask_1_end_y; Screek: zone1_x_begin /
# zout1_y_end. Not applied: the firmware still reports targets inside its exclusions, so the panel offers to import
# them as our own exclusion zones (one source of truth).
DEVICE_RECT_RE = re.compile(
    r"^number\..+?_(?P<key>zone_?\d|occupancy_mask_\d|zout\d)_"
    r"(?P<field>begin_x|end_x|begin_y|end_y|x_begin|x_end|y_begin|y_end)$"
)
MAX_DISTANCE_RE = re.compile(r"^number\..+_max_distance$")
INSTALL_ANGLE_RE = re.compile(r"^number\..+_installation_angle$")  # EP Lite / Pro
UPSIDE_DOWN_RE = re.compile(r"^switch\..+_upside_down_mounting$")  # EP Lite / Pro
ZONE_ENABLE_RE = re.compile(r"^switch\..+?_(?P<key>zout\d)_enable$")  # Screek


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


def _distance_mm(value: float, unit: str | None) -> float:
    """A range setting in mm. Without a unit (a state restored without attributes), go by size: a radar's range is
    metres, so 6 is m, 600 is cm (Everything Presence: 0-600 cm), 6000 is mm."""
    if unit is None:
        unit = "m" if value <= 10 else "cm" if value <= 1000 else "mm"
    try:
        return to_mm(value, unit)
    except ValueError:
        return DEFAULT_MAX_DISTANCE_MM


@callback
def async_device_geometry(hass: HomeAssistant, device_id: str) -> dict[str, Any]:
    """Read-only info from the device: max distance, firmware zones (mm) and mounting settings."""
    ent_reg = er.async_get(hass)
    rects: dict[str, dict[str, float]] = {}
    max_distance = DEFAULT_MAX_DISTANCE_MM
    mounting: dict[str, Any] = {}
    enabled: dict[str, bool] = {}
    for entry in er.async_entries_for_device(ent_reg, device_id):
        if entry.disabled_by is not None:
            continue
        if MAX_DISTANCE_RE.match(entry.entity_id):
            if (v := _float_state(hass, entry.entity_id)) is not None and v[0] > 0:
                max_distance = _distance_mm(*v)
            continue
        if INSTALL_ANGLE_RE.match(entry.entity_id):
            if (v := _float_state(hass, entry.entity_id)) is not None:
                mounting["installation_angle_deg"] = v[0]
            continue
        if m := ZONE_ENABLE_RE.match(entry.entity_id):
            if (state := hass.states.get(entry.entity_id)) is not None and state.state in ("on", "off"):
                enabled[m["key"]] = state.state == "on"
            continue
        if UPSIDE_DOWN_RE.match(entry.entity_id):
            if (state := hass.states.get(entry.entity_id)) is not None and state.state in ("on", "off"):
                mounting["upside_down"] = state.state == "on"
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
                "enabled": enabled.get(key, True),
            }
        )
    # The firmware applies its mounting settings to the coordinates it reports;
    # they are shown for reference only.
    return {"max_distance_mm": max_distance, "device_zones": device_zones, "mounting": mounting}


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


@callback
def async_resolve_units(
    hass: HomeAssistant, entity_ids: list[str] | set[str], fallback: str | None = None
) -> dict[str, str | None]:
    """Unit of each coordinate entity, robust to states that carry no unit.

    Restored/unavailable states (e.g. right after a restart, or while the radar
    is offline) can lack ``unit_of_measurement``. Treating those as native mm
    would shrink inch readings 25.4x, so fall back to the entity registry and
    then to the radar's other coordinate entities, which always share a unit.
    """
    ent_reg = er.async_get(hass)
    units: dict[str, str | None] = {}
    for eid in entity_ids:
        unit = None
        if (st := hass.states.get(eid)) is not None:
            unit = st.attributes.get(ATTR_UNIT_OF_MEASUREMENT)
        if unit is None and (entry := ent_reg.async_get(eid)) is not None:
            opts = entry.options or {}
            unit = (
                opts.get("sensor", {}).get("unit_of_measurement")
                or opts.get("sensor.private", {}).get("suggested_unit_of_measurement")
                or entry.unit_of_measurement
            )
        units[eid] = unit
    known = [u for u in units.values() if u]
    common = max(set(known), key=known.count) if known else fallback
    if common:
        for eid, unit in units.items():
            if not unit:
                units[eid] = common
    return units


def common_unit(units: dict[str, str | None]) -> str | None:
    known = [u for u in units.values() if u]
    return max(set(known), key=known.count) if known else None


# Any radar that reports per-target coordinates, whatever its entities are called: "Target 1 X",
# "person2_y", "t3 x coordinate", "x1". Used to suggest entities; the user confirms or corrects them.
_SLOT_AXIS_RES = (
    re.compile(r"(?:target|person|people|human|tgt|t|p)\s*(?P<slot>\d)\s*(?P<axis>x|y)\b"),
    re.compile(r"(?:target|person|human|tgt)\s*(?P<axis>x|y)\s*(?P<slot>\d)\b"),
    re.compile(r"\b(?P<axis>x|y)\s*(?P<slot>\d)\b"),
    re.compile(r"\b(?P<slot>\d)\s*(?P<axis>x|y)\b"),
)
_SINGLE_AXIS_RE = re.compile(r"(?:^|\s)(?:target\s*|position\s*|coordinate\s*)?(?P<axis>x|y)(?:\s*(?:coordinate|position|distance))?(?:\s|$)")


def guess_targets(entities: list[tuple[str, str | None]]) -> dict[int, dict[str, str]]:
    """Per-target X/Y sensors among a device's entities ((entity_id, name)): {slot: {"x": id, "y": id}}.
    Reads the entity id and the name; a lone "x"/"y" pair is target 1. Speed, angle, distance and
    resolution sensors are skipped."""
    out: dict[int, dict[str, str]] = {}
    lone: dict[str, str] = {}
    for entity_id, name in entities:
        if not entity_id.startswith("sensor."):
            continue
        text = f"{entity_id.split('.', 1)[1]} {name or ''}".lower()
        if re.search(r"speed|angle|resolution|distance_resolution|count|energy|gate|still|move", text):
            continue
        text = re.sub(r"[^a-z0-9]+", " ", text)
        text = re.sub(r"([a-z])(\d)", r"\1 \2", text)  # target1x -> target 1x
        text = re.sub(r"(\d)([a-z])", r"\1 \2", text)  # 1x -> 1 x
        for rx in _SLOT_AXIS_RES:
            if m := rx.search(text):
                out.setdefault(int(m["slot"]), {}).setdefault(m["axis"], entity_id)
                break
        else:
            if m := _SINGLE_AXIS_RE.search(text):
                lone.setdefault(m["axis"], entity_id)
    if not out and len(lone) == 2:
        out[1] = lone
    return {slot: axes for slot, axes in sorted(out.items()) if "x" in axes and "y" in axes}


@callback
def async_device_sensors(hass: HomeAssistant, device_id: str) -> list[tuple[str, str | None]]:
    """A device's enabled sensor entities: (entity_id, name)."""
    ent_reg = er.async_get(hass)
    out = []
    for entry in er.async_entries_for_device(ent_reg, device_id):
        if entry.disabled_by is None and entry.domain == "sensor":
            out.append((entry.entity_id, entry.name or entry.original_name))
    return sorted(out)
