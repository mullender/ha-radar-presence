"""Engine tests against synthetic input and real production fixtures."""

from __future__ import annotations

import pytest

from custom_components.radar_zone_presence.engine import (
    Frame,
    FrameAssembler,
    Target,
    TargetEntities,
    Zone,
    ZoneEngine,
    ZoneFilters,
    assemble,
    fov_polygon,
    point_in_polygon,
    replay,
    signed_distance,
    validate_polygon,
)
from custom_components.radar_zone_presence.engine.geometry import polygon_area

from . import fixtures_util as fx

SQUARE = [(0, 1000), (1000, 1000), (1000, 2000), (0, 2000)]


def zone(zid="z1", kind="include", polygon=SQUARE, **filters) -> Zone:
    return Zone(zid, zid, kind, tuple(polygon), ZoneFilters(**filters))


# ------------------------------------------------------------------ geometry


def test_point_in_polygon_basic():
    assert point_in_polygon(500, 1500, SQUARE)
    assert not point_in_polygon(1500, 1500, SQUARE)
    assert not point_in_polygon(500, 500, SQUARE)


def test_signed_distance():
    assert signed_distance(500, 1500, SQUARE) == pytest.approx(500)
    assert signed_distance(1100, 1500, SQUARE) == pytest.approx(-100)


def test_validate_polygon():
    assert validate_polygon(SQUARE) is None
    assert validate_polygon(SQUARE[:2]) is not None
    bowtie = [(0, 0), (1000, 1000), (1000, 0), (0, 1000)]
    assert validate_polygon(bowtie) == "polygon edges cross each other"
    assert validate_polygon([(0, 0), (1, 1), (2, 2)]) == "polygon has no area"


def test_fov_polygon_covers_boresight():
    fov = fov_polygon(6000)
    assert point_in_polygon(0, 3000, fov)
    assert not point_in_polygon(0, 7000, fov)
    assert polygon_area(fov) != 0


# ------------------------------------------------------------ frame assembly


def make_assembler(unit="mm") -> FrameAssembler:
    tes = [TargetEntities(n, f"sensor.t{n}_x", f"sensor.t{n}_y") for n in (1, 2, 3)]
    return FrameAssembler(tes, units={e: unit for t in tes for e in (t.x, t.y)})


def test_x_then_y_forms_one_frame():
    a = make_assembler()
    frames = list(assemble(a, [(10.000, "sensor.t1_x", "500"), (10.001, "sensor.t1_y", "1500")]))
    assert frames == [Frame(10.001, (Target(1, 500.0, 1500.0),))]


def test_y_zero_is_absent_but_x_zero_is_present():
    a = make_assembler()
    frames = list(
        assemble(
            a,
            [
                (1.0, "sensor.t1_x", "120"),  # detection start: y still 0
                (1.5, "sensor.t1_x", "0"),
                (1.5005, "sensor.t1_y", "900"),  # boresight crossing
            ],
        )
    )
    assert frames[0].targets == ()
    assert frames[1].targets == (Target(1, 0.0, 900.0),)


def test_x_only_update_still_produces_frame():
    """HA drops unchanged Y updates; the frame must still be evaluated."""
    a = make_assembler()
    evs = [(1.0, "sensor.t1_x", "100"), (1.001, "sensor.t1_y", "1500"), (1.3, "sensor.t1_x", "1200")]
    frames = list(assemble(a, evs))
    assert [f.targets for f in frames] == [(Target(1, 100.0, 1500.0),), (Target(1, 1200.0, 1500.0),)]


def test_units_are_converted():
    a = make_assembler("in")
    (f,) = assemble(a, [(1.0, "sensor.t1_x", "10"), (1.0, "sensor.t1_y", "100")])
    assert f.targets[0].x == pytest.approx(254.0)
    assert f.targets[0].y == pytest.approx(2540.0)


def test_unavailable_flags_frame():
    a = make_assembler()
    evs = [(1.0, f"sensor.t{n}_{ax}", "unavailable") for n in (1, 2, 3) for ax in "xy"]
    (f,) = assemble(a, evs)
    assert not f.available and f.targets == ()


# ------------------------------------------------------------- zone engine


def frame(t, *targets) -> Frame:
    return Frame(t, tuple(Target(i + 1, x, y) for i, (x, y) in enumerate(targets)))


def test_exclusion_applies_before_inclusion():
    eng = ZoneEngine([zone(), zone("ex", "exclude", [(400, 1400), (600, 1400), (600, 1600), (400, 1600)])])
    snap = eng.process(frame(1, (500, 1500)))
    assert not snap.zones["z1"].occupied
    assert snap.excluded_count == 1 and not snap.presence
    snap = eng.process(frame(2, (800, 1500)))
    assert snap.zones["z1"].occupied and snap.presence


def test_on_delay_suppresses_short_blip():
    eng = ZoneEngine([zone(on_delay_s=2.0)])
    frames = [frame(t, (500, 1500)) for t in (0.0, 0.5, 1.0, 1.4)] + [frame(1.7)]
    assert replay(eng, frames) == [(0.0, "presence", True), (1.7, "presence", False)]


def test_on_delay_turns_on_after_dwell():
    eng = ZoneEngine([zone(on_delay_s=1.0)])
    trans = replay(eng, [frame(t / 10, (500, 1500)) for t in range(0, 30, 3)])
    assert (pytest.approx(1.0), "z1", True) in [(pytest.approx(t), k, v) for t, k, v in trans]


def test_off_delay_fires_without_further_frames():
    eng = ZoneEngine([zone(off_delay_s=5.0)])
    eng.process(frame(0, (500, 1500)))
    eng.process(frame(1))
    assert eng.snapshot().zones["z1"].occupied
    assert eng.next_deadline() == pytest.approx(6.0)
    eng.advance(6.0)
    assert not eng.snapshot().zones["z1"].occupied


def test_edge_margin_hysteresis():
    eng = ZoneEngine([zone(edge_margin_mm=100)])
    assert not eng.process(frame(0, (50, 1500))).zones["z1"].occupied  # 50 inside: not enough to enter
    assert eng.process(frame(1, (150, 1500))).zones["z1"].occupied  # 150 inside: enter
    assert eng.process(frame(2, (-50, 1500))).zones["z1"].occupied  # 50 outside: stay
    assert not eng.process(frame(3, (-150, 1500))).zones["z1"].occupied  # 150 outside: leave


def test_reconnect_grace():
    eng = ZoneEngine([zone()], reconnect_grace_s=10)
    eng.process(Frame(0, (), available=False))
    assert not eng.process(frame(5, (500, 1500))).zones["z1"].occupied
    assert eng.process(frame(16, (500, 1500))).zones["z1"].occupied


# ----------------------------------------------------- production fixtures


def legacy_transitions(doc, polygon) -> list[tuple[float, bool]]:
    """Emulate the original template: evaluate on every update, drop x==0 or y==0."""
    tes = fx.target_entities(doc)
    unit = next(iter(doc["meta"]["units"].values()))
    cur: dict[str, float] = {}
    state, out = False, []
    for t, eid, s in fx.events(doc):
        try:
            cur[eid] = float(s)
        except ValueError:
            cur[eid] = 0.0
        hit = False
        for te in tes:
            x, y = cur.get(te.x, 0.0), cur.get(te.y, 0.0)
            if x != 0 and y != 0 and point_in_polygon(x * 25.4 if unit == "in" else x, y * 25.4 if unit == "in" else y, polygon):
                hit = True
        if hit != state:
            state = hit
            out.append((t, hit))
    return out


def test_kitchen_ghost_legacy_flickers_engine_does_not():
    doc = fx.load("epl_8519b4_kitchen_ghost.json")
    poly2 = fx.legacy_polygons_mm(doc)[2]
    legacy = legacy_transitions(doc, poly2)
    # The legacy evaluation flips polygon 2 off/on within milliseconds.
    flickers = sum(1 for (t1, v1), (t2, v2) in zip(legacy, legacy[1:]) if not v1 and v2 and t2 - t1 < 0.01)
    assert flickers >= 1

    eng = ZoneEngine([Zone("p2", "Polygon 2", "include", tuple(poly2))])
    trans = [(t, v) for t, k, v in replay(eng, assemble(fx.assembler(doc), fx.events(doc))) if k == "p2"]
    # One clean on/off pair for the 1.4 s ghost, no millisecond toggles.
    assert all(t2 - t1 > 0.2 for (t1, _), (t2, _) in zip(trans, trans[1:]))
    assert len(trans) <= len(legacy)


def test_kitchen_ghost_suppressed_by_on_delay():
    doc = fx.load("epl_8519b4_kitchen_ghost.json")
    poly2 = fx.legacy_polygons_mm(doc)[2]
    eng = ZoneEngine([Zone("p2", "Polygon 2", "include", tuple(poly2), ZoneFilters(on_delay_s=2.0))])
    trans = [x for x in replay(eng, assemble(fx.assembler(doc), fx.events(doc))) if x[1] == "p2"]
    assert trans == []


def test_screek_slot2_present_while_count_lags():
    doc = fx.load("screek_aef514_count_lags_slot2.json")
    frames = list(assemble(fx.assembler(doc), fx.events(doc)))
    assert any(any(tg.slot == 2 for tg in f.targets) for f in frames)


@pytest.mark.parametrize(
    "name", ["epl_252dd0_busy_10min.json", "screek_b3b6c4_busy_10min.json"]
)
def test_busy_fixtures_one_frame_per_firmware_cycle(name):
    doc = fx.load(name)
    evs = fx.events(doc)
    frames = list(assemble(fx.assembler(doc), evs))
    gaps = sorted(b.t - a.t for a, b in zip(frames, frames[1:]))
    # Frames come every ~0.3-0.55 s; nothing should be split into ms-apart pieces.
    assert gaps[len(gaps) // 100] > 0.1
    assert len(frames) < len(evs)
