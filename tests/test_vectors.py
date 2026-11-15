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
from custom_components.radar_zone_presence.engine.tracker import replay_group

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
        "hold_until_exit": [{**z, "filters": {"hold_until_exit": True}} for z in base],
        "hold_filters_exclusion": [*({**z, "filters": {**filt, "hold_until_exit": True}} for z in base), excl],
        "hold_max": [{**z, "filters": {"hold_until_exit": True, "hold_max_s": 20.0, "off_delay_s": 2.0}} for z in base],
        "hold_exits": [
            *({**z, "filters": {"hold_until_exit": True, "hold_max_s": 600.0}} for z in base),
            {**excl, "id": "door", "name": "Door", "kind": "exit"},
        ],
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


GROUP_VECTOR = "group_252dd0_b3b6c4.json"


def test_group_vector_up_to_date() -> None:
    """Two radars tracked together (frontend/tracker.js replayGroup must match engine.tracker.replay_group)."""
    from dataclasses import replace

    from custom_components.radar_zone_presence.engine.align import alignment_affine

    own_doc, peer_doc = fx.load("epl_252dd0_busy_10min.json"), fx.load("screek_b3b6c4_busy_10min.json")
    own = list(assemble(fx.assembler(own_doc), fx.events(own_doc)))
    peer = list(assemble(fx.assembler(peer_doc), fx.events(peer_doc)))
    shift = own[0].t - peer[0].t + 0.013  # overlap the two recordings, interleaved
    peer = [replace(f, t=f.t + shift) for f in peer]
    own_packed, peer_packed = pack_frames(own, own[0].t), pack_frames(peer, peer[0].t)
    # The island Screek aligned to the living-room EPL (as measured in dev).
    alignment = {"angle_deg": -104.3, "reflect": True, "offset_mm": [1646, 2758]}
    a = alignment_affine(alignment)
    hold = {"hold_until_exit": True, "hold_max_s": 300.0, "edge_margin_mm": 150.0, "off_delay_s": 2.0}
    own_zones = [
        # Seen by both radars (the peer's targets land around x 2200-3400, y 2400-4000 here).
        {"id": "shared", "name": "Shared", "kind": "include", "polygon": [[1500, 2000], [3500, 2000], [3500, 4200], [1500, 4200]], "filters": hold},
        {"id": "desk", "name": "Desk", "kind": "include", "polygon": [[0, 4000], [700, 4000], [700, 5000], [0, 5000]], "filters": {}},
        {"id": "stairs", "name": "Stairs", "kind": "exit", "polygon": [[600, 0], [1700, 0], [1700, 1150], [600, 1150]]},
        {"id": "couch", "name": "Couch", "kind": "linger", "polygon": [[2500, 3000], [3500, 3000], [3500, 4200], [2500, 4200]]},
        {"id": "hall", "name": "Hall", "kind": "transient", "polygon": [[1500, 2000], [2500, 2000], [2500, 2600], [1500, 2600]]},
    ]
    peer_zones = [
        {"id": "pex", "name": "Fridge", "kind": "exclude", "polygon": [[-500, 3000], [500, 3000], [500, 4000], [-500, 4000]]},
        {"id": "pexit", "name": "Hall", "kind": "exit", "polygon": [[-2000, 500], [-1000, 500], [-1000, 1500], [-2000, 1500]]},
    ]
    transitions = replay_group(
        unpack_frames(own_packed),
        [Zone.from_dict(z) for z in own_zones],
        [(unpack_frames(peer_packed), [Zone.from_dict(z) for z in peer_zones], a)],
        2.0,
    )
    vector = {
        "own": {"frames": own_packed, "zones": own_zones},
        "peers": [{"frames": peer_packed, "zones": peer_zones, "aligned_to": alignment}],
        "reconnect_grace_s": 2.0,
        "transitions": [[round(t, 6), k, v] for t, k, v in transitions],
    }
    path = VECTORS / GROUP_VECTOR
    if os.environ.get("UPDATE_VECTORS"):
        path.write_text(json.dumps(vector, separators=(",", ":")))
    assert path.exists(), "run with UPDATE_VECTORS=1"
    assert json.loads(path.read_text()) == json.loads(json.dumps(vector)), "vectors stale: UPDATE_VECTORS=1"
    assert sum(k == "shared" for _, k, _ in transitions) >= 2
    assert sum(k == "desk" for _, k, _ in transitions) >= 2


TRACKED_CASES = ("hold_until_exit", "hold_max", "hold_exits", "filters_exclusion")


@pytest.mark.parametrize(("fixture", "grace"), CASES)
def test_tracked_vectors_up_to_date(fixture: str, grace: float) -> None:
    """One radar through the tracker, as the home runs it (frontend/tracker.js replayGroup without peers)."""
    doc = fx.load(fixture)
    frames = list(assemble(fx.assembler(doc), fx.events(doc)))
    packed = pack_frames(frames, frames[0].t)
    all_zones = _zones_for(doc)
    cases = {}
    for name in TRACKED_CASES:
        zones = all_zones[name]
        transitions = replay_group(unpack_frames(packed), [Zone.from_dict(z) for z in zones], (), grace)
        cases[name] = {"zones": zones, "transitions": [[round(t, 6), k, v] for t, k, v in transitions]}
    vector = {"fixture": fixture, "reconnect_grace_s": grace, "frames": packed, "cases": cases}
    path = VECTORS / f"tracked_{fixture}"
    if os.environ.get("UPDATE_VECTORS"):
        path.write_text(json.dumps(vector, separators=(",", ":")))
    assert path.exists(), "run with UPDATE_VECTORS=1"
    assert json.loads(path.read_text()) == json.loads(json.dumps(vector)), "vectors stale: UPDATE_VECTORS=1"
    assert any(c["transitions"] for c in cases.values())


def test_desk_stays_on_while_the_radar_renumbers_targets() -> None:
    """Real frames (shifted in time): someone still at the desk, a second person in the kitchen.

    The radar drops the still person and renumbers the kitchen person from
    slot 2 to slot 1 (twice); later the kitchen person reappears as slot 1
    while the desk person is not detected. Following slots, Desk went off
    three times; tracked, it stays on until the max hold runs out.
    """
    vec = json.loads((VECTORS / "tracked_desk_two_people.json").read_text())
    frames = unpack_frames(vec["frames"])
    zones = [Zone.from_dict(z) for z in vec["zones"]]
    by_slot = [v for _, k, v in replay(ZoneEngine(zones), frames) if k == "desk"]
    assert by_slot.count(False) >= 3
    tracked = replay_group(frames, zones)
    desk = [(t - frames[0].t, v) for t, k, v in tracked if k == "desk"]
    assert [v for _, v in desk] == [True, False]
    assert desk[1][0] > 1500  # off only when the max hold runs out after the last sighting
    assert vec["transitions"] == [[round(t, 6), k, v] for t, k, v in tracked]
