"""Helpers to load production fixtures exported by tools/export_history.mjs."""

from __future__ import annotations

import json
import re
from pathlib import Path

from custom_components.radar_zone_presence.engine import FrameAssembler, TargetEntities, to_mm

FIXTURES = Path(__file__).parent / "fixtures"

_TARGET_RE = re.compile(r"^sensor\.(.+?)_target_?(\d)_(x|y)$")


def load(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text())


def target_entities(doc: dict) -> list[TargetEntities]:
    slots: dict[int, dict[str, str]] = {}
    for eid in doc["meta"]["entities"]:
        m = _TARGET_RE.match(eid)
        if m:
            slots.setdefault(int(m.group(2)), {})[m.group(3)] = eid
    return [TargetEntities(n, v["x"], v["y"]) for n, v in sorted(slots.items())]


def assembler(doc: dict) -> FrameAssembler:
    return FrameAssembler(target_entities(doc), units=doc["meta"]["units"])


def events(doc: dict, include_count: bool = False) -> list[tuple[float, str, str]]:
    out = []
    for eid, states in doc["history"].items():
        if not eid.startswith("sensor."):
            continue
        if not include_count and eid.endswith("_all_target_counts"):
            continue
        out.extend((t, eid, s) for t, s in states)
    out.sort(key=lambda e: e[0])
    return out


def legacy_polygons_mm(doc: dict) -> dict[int, list[tuple[float, float]]]:
    """input_text polygons (in the target sensors' unit) converted to mm."""
    unit = next(u for e, u in doc["meta"]["units"].items() if _TARGET_RE.match(e))
    out = {}
    for eid, state in doc["meta"]["polygons"].items():
        n = int(eid.rsplit("_", 1)[1])
        out[n] = [(to_mm(p[0], unit), to_mm(p[1], unit)) for p in json.loads(state)]
    return out
