"""Alignment groups and the people tracker (pure engine)."""

from __future__ import annotations

import itertools

import pytest

from custom_components.radar_zone_presence.engine import Frame, Zone, ZoneEngine, replay

from custom_components.radar_zone_presence.engine.align import (
    IDENTITY,
    alignment_affine,
    alignment_groups,
    apply,
    invert,
    mul,
)
from custom_components.radar_zone_presence.engine.frames import Target
from custom_components.radar_zone_presence.engine.tracker import MAX_LOST, TRANSIENT_TTL_S, Observation, Tracker, replay_group


_clock = itertools.count()


def T() -> float:
    """Frame times 0.3 s apart."""
    return next(_clock) * 0.3


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


def test_single_radar_keeps_slots_as_ids_when_consistent() -> None:
    f = Tracker()
    for t, frame in enumerate(([(1, 0, 1000), (3, 500, 2000)], [(3, 520, 2010)], [(1, 10, 900), (2, -800, 1500)])):
        out = f.fuse([Observation(0, s, x, y) for s, x, y in frame], t * 0.3)
        assert [(t.slot, t.x, t.y) for t in out.targets] == sorted(frame)
        assert out.gone == ()


def test_same_person_seen_by_two_radars_is_one_track_and_survives_handover() -> None:
    f = Tracker()
    out = f.fuse([Observation(0, 1, 0, 2000)], T())
    assert [t.slot for t in out.targets] == [1]
    # Radar 1 picks the same person up 300 mm away: they join track 1.
    out = f.fuse([Observation(0, 1, 50, 2000), Observation(1, 2, 250, 2100)], T())
    assert [t.slot for t in out.targets] == [1]
    assert out.radars[1] == {0, 1}
    assert out.targets[0].x == pytest.approx(150)
    # Radar 0 loses them; the track continues on radar 1 with the same id.
    out = f.fuse([Observation(1, 2, 400, 2200)], T())
    assert [t.slot for t in out.targets] == [1] and out.radars[1] == {1}


def test_converging_tracks_merge_and_report_gone() -> None:
    f = Tracker()
    out = f.fuse([Observation(0, 1, 0, 2000), Observation(1, 1, 1500, 2000)], T())
    assert sorted(t.slot for t in out.targets) == [1, 11]
    out = f.fuse([Observation(0, 1, 0, 2000), Observation(1, 1, 400, 2000)], T())
    assert [t.slot for t in out.targets] == [1]
    assert out.gone == (11,)


def test_two_people_close_together_on_one_radar_stay_apart() -> None:
    f = Tracker()
    out = f.fuse([Observation(0, 1, 0, 2000), Observation(0, 2, 300, 2000)], T())
    assert len(out.targets) == 2


def test_jump_splits_off() -> None:
    f = Tracker()
    f.fuse([Observation(0, 1, 0, 2000), Observation(1, 1, 100, 2000)], T())
    out = f.fuse([Observation(0, 1, 0, 2000), Observation(1, 1, 3000, 2000)], T())  # radar 1 slot reassigned
    assert len(out.targets) == 2


def test_merge_does_not_leave_a_phantom_hold() -> None:
    zone = Zone.from_dict({"id": "desk", "name": "Desk", "kind": "include",
                           "polygon": [[-1000, 1000], [2000, 1000], [2000, 3000], [-1000, 3000]],
                           "filters": {"hold_until_exit": True}})
    eng, f = ZoneEngine([zone]), Tracker()

    def step(t, obs):
        out = f.fuse(obs, t)
        return eng.process(Frame(t, out.targets, True, out.gone)).zones["desk"]

    step(0, [Observation(0, 1, 0, 2000), Observation(1, 1, 1500, 2000)])  # one person, two tracks (alignment error)
    step(1, [Observation(0, 1, 0, 2000), Observation(1, 1, 300, 2000)])  # they merge
    zs = step(2, [Observation(0, 1, 0, 1800)])
    assert zs.held == 0 and zs.count == 1


# --------------------------------------------------------------- tracking

DESK = {"id": "desk", "name": "Desk", "kind": "include",
        "polygon": [[-2900, 4100], [-1700, 4100], [-1700, 5300], [-2900, 5300]],
        "filters": {"hold_until_exit": True, "hold_max_s": 1500, "edge_margin_mm": 150}}
SIT = (-2300.0, 4700.0)  # someone sitting at the desk


def _frames(spec: list[tuple[float, list[tuple[int, float, float]]]]) -> list[Frame]:
    return [Frame(t, tuple(Target(s, x, y) for s, x, y in tgs)) for t, tgs in spec]


def _walk(t0: float, t1: float, a: tuple[float, float], b: tuple[float, float], slot: int, extra=()):
    """Frames every 0.3 s of one person walking a -> b in slot `slot`, plus fixed extra targets."""
    out, n = [], max(1, int((t1 - t0) / 0.3))
    for i in range(n + 1):
        k = i / n
        out.append((t0 + i * 0.3, [*extra, (slot, a[0] + k * (b[0] - a[0]), a[1] + k * (b[1] - a[1]))]))
    return out


def test_renumbered_slot_keeps_both_people_apart() -> None:
    f = Tracker()
    out = f.fuse([Observation(0, 1, *SIT), Observation(0, 2, 2500, 3600)], 0.0)
    assert [t.slot for t in out.targets] == [1, 2]
    # The radar drops the still person; the walking one moves into slot 1.
    out = f.fuse([Observation(0, 1, 2450, 3620)], 0.3)
    assert [t.slot for t in out.targets] == [2]
    assert out.born == () and out.gone == ()
    assert [(i, settled) for i, _, _, settled in f.lost] == [(1, True)]


def test_lost_person_is_refound_near_where_they_vanished() -> None:
    f = Tracker()
    f.fuse([Observation(0, 1, *SIT)], 0.0)
    f.fuse([], 0.3)
    # Someone appears on the other side of the room: a new person, not the one at the desk.
    out = f.fuse([Observation(0, 1, 2500, 3600)], 10.0)
    assert out.born == (out.targets[0].slot,) and out.targets[0].slot != 1
    # The desk person stands up: re-found, same id, not new.
    out = f.fuse([Observation(0, 1, 2500, 3600), Observation(0, 2, SIT[0] + 300, SIT[1] - 500)], 20.0)
    assert 1 in [t.slot for t in out.targets] and 1 not in out.born


def test_desk_stays_held_while_the_radar_renumbers_and_reuses_slots() -> None:
    """The production case: a person still at the desk, another walking around the kitchen."""
    kitchen = (2500.0, 3600.0)
    spec = [
        *[(t * 0.3, [(1, *SIT)]) for t in range(10)],  # sits down, seen
        *_walk(3.0, 6.0, (2300, 2300), kitchen, 2, extra=[(1, *SIT)]),  # second person walks into the kitchen
        *_walk(6.3, 9.0, kitchen, (2800, 3700), 1),  # desk person dropped: kitchen person renumbered to slot 1
        (9.3, []),  # kitchen person not detected either
        *_walk(15.0, 18.0, (2900, 3700), (2600, 3500), 1),  # kitchen person reappears as slot 1
        (18.3, []),
        *[(60.0 + t * 0.3, [(1, SIT[0] + 50, SIT[1] - 30)]) for t in range(5)],  # desk person seen again
        *_walk(62.0, 66.0, (SIT[0] + 50, SIT[1] - 30), (-300, 2000), 1),  # and walks away
    ]
    frames = _frames(spec)
    desk = Zone.from_dict(DESK)
    by_slot = [v for _, k, v in replay(ZoneEngine([desk]), frames) if k == "desk"]
    assert by_slot[:2] == [True, False] and len(by_slot) > 2  # slots: the renumbering "walks" the desk person out
    tracked = [(round(t, 1), v) for t, k, v in replay_group(frames, [desk]) if k == "desk"]
    assert [v for _, v in tracked] == [True, False]
    assert 62.0 < tracked[1][0] < 66.0  # off only when the desk person walks out


@pytest.mark.parametrize(
    ("where", "spots", "forgotten"),
    [
        ((0.0, 3000.0), [], False),  # middle of the room: still there
        ((3700.0, 2300.0), [], True),  # at the side of the field of view: left it
        ((3700.0, 2300.0), [("linger", [[3000, 1800], [4400, 1800], [4400, 2800], [3000, 2800]])], False),
        ((0.0, 3000.0), [("transient", [[-500, 2500], [500, 2500], [500, 3500], [-500, 3500]])], True),
    ],
)
def test_where_someone_vanishes_decides_how_long_they_are_held(where, spots, forgotten) -> None:
    zone = Zone.from_dict({"id": "z", "name": "Z", "kind": "include",
                           "polygon": [[where[0] - 500, where[1] - 500], [where[0] + 500, where[1] - 500],
                                       [where[0] + 500, where[1] + 500], [where[0] - 500, where[1] + 500]],
                           "filters": {"hold_until_exit": True, "hold_max_s": 600}})
    zones = [zone, *(Zone.from_dict({"id": k, "name": k, "kind": k, "polygon": p}) for k, p in spots)]
    frames = _frames([*[(t * 0.3, [(1, *where)]) for t in range(10)], (3.0, []), (200.0, [])])
    offs = [round(t, 1) for t, k, v in replay_group(frames, zones) if k == "z" and not v]
    # Forgotten 20 s after last seen; held from the frame that misses them until the max hold.
    assert offs == ([round(2.7 + TRANSIENT_TTL_S, 1)] if forgotten else [603.0])


def test_lost_memory_is_bounded() -> None:
    f = Tracker()
    dropped: list[int] = []
    for i in range(MAX_LOST + 3):
        f.fuse([Observation(0, 1, i * 3000.0, 3000.0)], i * 1.0)
        dropped += f.fuse([], i * 1.0 + 0.5).dropped
    out = f.fuse([], 100.0)
    assert len(f.lost) == MAX_LOST
    assert len(dropped + list(out.dropped)) >= 2
