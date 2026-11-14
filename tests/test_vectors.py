"""Shared test vectors keeping frontend/engine.js identical to the Python engine.

Each vector holds packed frames (the websocket history format), zones and the
transitions the Python engine produces. tests/js/engine.test.mjs replays the
same vectors through the JS port. Regenerate with:

    UPDATE_VECTORS=1 .venv/bin/pytest tests/test_vectors.py
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from custom_components.radar_zone_presence.engine import Zone, ZoneEngine, assemble, replay
from custom_components.radar_zone_presence.engine.frames import pack_frames, unpack_frames

from . import fixtures_util as fx

VECTORS = Path(__file__).parent / "vectors"


def _zones_for(doc: dict) -> dict[str, list[dict]]:
    legacy = fx.legacy_polygons_mm(doc)
    base = [
        {"id": f"p{n}", "name": f"Polygon {n}", "kind": "include", "polygon": [list(p) for p in poly]}
        for n, poly in sorted(legacy.items())
    ] or [
        {"id": "front", "name": "Front", "kind": "include",
         "polygon": [[-1500, 300], [1500, 300], [1500, 2500], [-1500, 2500]]}
    ]
    first = base[0]["polygon"]
    xs = [p[0] for p in first]
    ys = [p[1] for p in first]
    cx, cy = sum(xs) / len(xs), sum(ys) / len(ys)
    excl = {"id": "ex", "name": "Exclusion", "kind": "exclude",
            "polygon": [[cx - 400, cy - 400], [cx + 400, cy - 400], [cx + 400, cy + 400], [cx - 400, cy + 400]]}
    filt = {"on_delay_s": 1.0, "off_delay_s": 3.0, "edge_margin_mm": 150.0}
    return {
        "plain": base,
        "exclusion": [*base, excl],
        "filters": [{**z, "filters": filt} for z in base],
        "filters_exclusion": [*({**z, "filters": filt} for z in base), excl],
    }


CASES = [
    ("epl_8519b4_kitchen_ghost.json", 3.0),
    ("epl_252dd0_busy_10min.json", 0.0),
    ("screek_b3b6c4_busy_10min.json", 0.0),
    ("screek_aef514_count_lags_slot2.json", 0.0),
]


@pytest.mark.parametrize(("fixture", "grace"), CASES)
def test_vectors_up_to_date(fixture: str, grace: float) -> None:
    doc = fx.load(fixture)
    frames = list(assemble(fx.assembler(doc), fx.events(doc)))
    packed = pack_frames(frames, frames[0].t)
    cases = {}
    for name, zones in _zones_for(doc).items():
        engine = ZoneEngine([Zone.from_dict(z) for z in zones], grace)
        cases[name] = {
            "zones": zones,
            "transitions": [[round(t, 6), k, v] for t, k, v in replay(engine, unpack_frames(packed))],
        }
    vector = {"fixture": fixture, "reconnect_grace_s": grace, "frames": packed, "cases": cases}
    path = VECTORS / fixture
    if os.environ.get("UPDATE_VECTORS"):
        VECTORS.mkdir(exist_ok=True)
        path.write_text(json.dumps(vector, separators=(",", ":")))
    assert path.exists(), "run with UPDATE_VECTORS=1"
    assert json.loads(path.read_text()) == json.loads(json.dumps(vector)), "vectors stale: UPDATE_VECTORS=1"
    # Sanity: the cases exercise something.
    assert any(c["transitions"] for c in cases.values())
