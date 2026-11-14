"""Alignment groups and multi-radar target fusion (pure engine)."""

from __future__ import annotations

import pytest

from custom_components.radar_zone_presence.engine import Frame, Zone, ZoneEngine
from custom_components.radar_zone_presence.engine.align import (
    IDENTITY,
    alignment_affine,
    alignment_groups,
    apply,
    invert,
    mul,
)
from custom_components.radar_zone_presence.engine.fusion import Fuser, Observation


def test_alignment_affine_round_trip() -> None:
    a = alignment_affine({"angle_deg": 90, "reflect": True, "offset_mm": [1000, 0]})
    # Mirror X, rotate 90 degrees counter-clockwise, then shift.
    assert apply(a, 100, 0) == pytest.approx((1000, -100))
    assert apply(mul(invert(a), a), 123, 456) == pytest.approx((123, 456))


def test_groups_follow_alignment_chains() -> None:
    al = lambda ref, dx: {"radar_id": ref, "angle_deg": 0, "reflect": False, "offset_mm": [dx, 0]}  # noqa: E731
    groups = alignment_groups({"living": None, "kitchen": al("living", 1000), "island": al("kitchen", 500), "entry": None})
    assert [(g.anchor, sorted(g.members)) for g in groups] == [
        ("living", ["island", "kitchen", "living"]),
        ("entry", ["entry"]),
    ]
    living = groups[0]
    assert living.to_anchor["living"] == IDENTITY
    assert apply(living.to_anchor["island"], 0, 0) == pytest.approx((1500, 0))
    # An alignment to a radar that is gone is ignored.
    (g,) = alignment_groups({"kitchen": al("removed", 1000)})
    assert g.anchor == "kitchen"


def test_single_radar_is_identity() -> None:
    f = Fuser()
    for frame in ([(1, 0, 1000), (3, 500, 2000)], [(3, 520, 2010)], [(1, 10, 900), (2, -800, 1500)]):
        out = f.fuse([Observation(0, s, x, y) for s, x, y in frame])
        assert [(t.slot, t.x, t.y) for t in out.targets] == sorted(frame)
        assert out.gone == ()


def test_same_person_seen_by_two_radars_is_one_track_and_survives_handover() -> None:
    f = Fuser()
    out = f.fuse([Observation(0, 1, 0, 2000)])
    assert [t.slot for t in out.targets] == [1]
    # Radar 1 picks the same person up 300 mm away: they join track 1.
    out = f.fuse([Observation(0, 1, 50, 2000), Observation(1, 2, 250, 2100)])
    assert [t.slot for t in out.targets] == [1]
    assert out.radars[1] == {0, 1}
    assert out.targets[0].x == pytest.approx(150)
    # Radar 0 loses them; the track continues on radar 1 with the same id.
    out = f.fuse([Observation(1, 2, 400, 2200)])
    assert [t.slot for t in out.targets] == [1] and out.radars[1] == {1}


def test_converging_tracks_merge_and_report_gone() -> None:
    f = Fuser()
    out = f.fuse([Observation(0, 1, 0, 2000), Observation(1, 1, 1500, 2000)])
    assert sorted(t.slot for t in out.targets) == [1, 11]
    out = f.fuse([Observation(0, 1, 0, 2000), Observation(1, 1, 400, 2000)])
    assert [t.slot for t in out.targets] == [1]
    assert out.gone == (11,)


def test_two_people_close_together_on_one_radar_stay_apart() -> None:
    f = Fuser()
    out = f.fuse([Observation(0, 1, 0, 2000), Observation(0, 2, 300, 2000)])
    assert len(out.targets) == 2


def test_jump_splits_off() -> None:
    f = Fuser()
    f.fuse([Observation(0, 1, 0, 2000), Observation(1, 1, 100, 2000)])
    out = f.fuse([Observation(0, 1, 0, 2000), Observation(1, 1, 3000, 2000)])  # radar 1 slot reassigned
    assert len(out.targets) == 2


def test_merge_does_not_leave_a_phantom_hold() -> None:
    zone = Zone.from_dict({"id": "desk", "name": "Desk", "kind": "include",
                           "polygon": [[-1000, 1000], [2000, 1000], [2000, 3000], [-1000, 3000]],
                           "filters": {"hold_until_exit": True}})
    eng, f = ZoneEngine([zone]), Fuser()

    def step(t, obs):
        out = f.fuse(obs)
        return eng.process(Frame(t, out.targets, True, out.gone)).zones["desk"]

    step(0, [Observation(0, 1, 0, 2000), Observation(1, 1, 1500, 2000)])  # one person, two tracks (alignment error)
    step(1, [Observation(0, 1, 0, 2000), Observation(1, 1, 300, 2000)])  # they merge
    zs = step(2, [Observation(0, 1, 0, 1800)])
    assert zs.held == 0 and zs.count == 1
