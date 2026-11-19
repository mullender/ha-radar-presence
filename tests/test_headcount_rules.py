"""One test per head count rule that had none (docs/detection-logic.html §14, the EC-nn rows marked ✘).

Each test is a minimal scene for its rule; the docstring names the row. These guard behaviour that was otherwise
only checked by replaying real household data, so a simplification that breaks one of them breaks a real case.
"""

from __future__ import annotations

from custom_components.radar_zone_presence.engine.headcount import (
    CONFIRM_S,
    REESTABLISH_S,
    STATIC_S,
    UNEXPLAINED_EXPIRE_S,
    UNEXPLAINED_SEEN_S,
    HeadCount,
    Portal,
    Region,
)

from .test_headcount import (
    BIG_DOOR,
    DOORWAY_REGIONS,
    FRONT,
    LINKS,
    REGIONS,
    walk,
)


def bound(hc: HeadCount, region: str, tid: int) -> int | None:
    """The person a track is bound to while it is in view."""
    tok = hc.tokens.get(hc._binding.get((region, tid), -1))
    return tok.id if tok is not None and tok.visible == (region, tid) else None


def roam(hc: HeadCount, region: str, tid: int, t0: float, t1: float, x0: float = 1000.0, y0: float = 1000.0, others=None) -> None:
    """A track moving about (never static) from t0 to t1, one frame a second, other tracks alongside; still in view."""
    t = t0
    while t <= t1:
        k = int(t - t0)
        pos = (x0 + 600.0 * ((k // 5) % 2), y0 + 60.0 * (k % 5))
        hc.frame(region, {tid: pos, **(others(t) if others else {})}, t)
        t += 1.0


# --------------------------------------------------------- unexplained tracks


def test_ec42_unexplained_track_is_confirmed_by_walking_into_another_region() -> None:
    """EC-42 / HC-PR-1: a track no one explains becomes a provisional person after CONFIRM_S, not counted; it counts
    once it walks into another region."""
    hc = HeadCount(REGIONS, connections=LINKS)
    roam(hc, "living", 9, 100, 100 + CONFIRM_S + 5)
    assert [tok.provisional for tok in hc.tokens.values()] == [True]
    assert hc.count() == 0
    hc.frame("living", {}, 170)
    walk(hc, "entry", 3, 175, [(500.0 + 200 * k, 1500.0) for k in range(5)])  # down the stairs
    assert hc.count() == 1
    assert [c.kind for c in hc.changes] == ["unexplained", "moved", "confirmed"]


def test_ec42_unexplained_track_is_confirmed_by_staying_around() -> None:
    """EC-42: ... or once seen UNEXPLAINED_SEEN_S in its region."""
    hc = HeadCount(REGIONS, connections=LINKS)
    roam(hc, "living", 9, 100, 100 + CONFIRM_S + UNEXPLAINED_SEEN_S + 5)
    assert hc.count() == 1 and hc.changes[-1].kind == "confirmed"


def test_ec42_unexplained_track_that_goes_away_expires() -> None:
    """EC-42: a provisional person neither seen long enough nor elsewhere is dropped after UNEXPLAINED_EXPIRE_S."""
    hc = HeadCount(REGIONS, connections=LINKS)
    roam(hc, "living", 9, 100, 100 + CONFIRM_S + 5)
    hc.frame("living", {}, 170)
    hc.advance(100 + CONFIRM_S + UNEXPLAINED_EXPIRE_S + 10)
    assert not hc.tokens and hc.changes[-1].kind == "not a person"


def test_ec47_a_track_splitting_next_to_someone_waits() -> None:
    """EC-47: a new track within SEPARATE_MM of someone in view is their track splitting: it waits, however long,
    and does not take the other person, unseen on the couch."""
    hc = HeadCount(REGIONS, connections=LINKS)
    hc.seed("living", 2, 0.0)
    roam(hc, "living", 1, 100, 100 + CONFIRM_S + 20, others=lambda t: {2: (1000.0 + 600.0 * ((int(t - 100) // 5) % 2) + 700, 1100.0)})
    assert hc.count() == 2 and len(hc.tokens) == 2
    assert ("living", 2) in hc._pending and sum(tok.visible is not None for tok in hc.tokens.values()) == 1


def test_ec48_someone_in_view_next_door_explains_an_extra_track() -> None:
    """EC-48: no new person while someone is in view in a neighbouring region without a door between (two radars
    seeing one person at the boundary)."""
    hc = HeadCount(REGIONS, connections=LINKS)
    hc.seed("entry", 1, 0.0)
    t = 100.0
    while t <= 100 + CONFIRM_S + 30:  # both in view at once: the entry person is bound to the entry track
        hc.frame("entry", {1: (500.0 + (t % 7) * 200, 1500.0)}, t)
        hc.frame("living", {9: (3000.0 + (t % 5) * 120, 4000.0)}, t)
        t += 1.0
    assert hc.count() == 1 and len(hc.tokens) == 1
    assert ("living", 9) in hc._pending


# ----------------------------------------------------------- track identity


def _two_lost() -> tuple[HeadCount, int, int]:
    """A lost in the living room at about (1000, 1000); B lost in the entry a little later."""
    hc = HeadCount(REGIONS, connections=LINKS)
    hc.seed("living", 1, 0.0)
    hc.seed("entry", 1, 0.0)
    walk(hc, "living", 1, 1.0, [(1000.0 + 100 * k, 1000.0) for k in range(4)])
    a = hc._binding[("living", 1)]
    walk(hc, "entry", 2, 5.5, [(500.0 + 100 * k, 1500.0) for k in range(4)])  # (A cannot be down there yet)
    b = hc._binding[("entry", 2)]
    assert a != b
    return hc, a, b


def test_ec49_a_track_id_reused_far_away_is_not_the_same_person() -> None:
    """EC-49: the tracker reuses track ids. Track 1 back far from where A vanished is whoever was seen last (B)."""
    hc, a, b = _two_lost()
    hc.frame("living", {1: (4500.0, 4500.0)}, 20.0)
    assert bound(hc, "living", 1) == b and hc.tokens[a].region == "living"


def test_ec49_a_track_refound_where_it_vanished_keeps_its_person() -> None:
    """EC-49: ... while near where A vanished, within REFOUND_S, it is A (re-found), though B was seen later."""
    hc, a, _b = _two_lost()
    hc.frame("living", {1: (1400.0, 1100.0)}, 20.0)
    assert bound(hc, "living", 1) == a


def test_ec55_nobody_changes_floor_faster_than_the_stairs_allow() -> None:
    """EC-55: someone seen upstairs a second ago is not the new track downstairs (FLOOR_TRAVEL_S per floor)."""
    hc = HeadCount(REGIONS, connections=LINKS)
    hc.seed("living", 1, 0.0)
    t = walk(hc, "living", 1, 0.0, [(1000.0, 1000.0), (1300.0, 1000.0), (1600.0, 1000.0)])  # last seen at 2
    hc.frame("entry", {7: (500.0, 1500.0)}, t + 0.5)
    assert bound(hc, "entry", 7) is None and ("entry", 7) in hc._pending
    hc.frame("entry", {7: (700.0, 1500.0)}, t + 3.0)
    assert bound(hc, "entry", 7) is not None and hc.by_region()["entry"] == 1


# ------------------------------------------------------------------ doorways


def test_ec54_lost_at_a_stairwell_leading_up_and_down_stays_put() -> None:
    """EC-54: a doorway leading to two regions: someone lost there could have gone either way, so stays; the next
    track at either end is them."""
    hc = HeadCount(DOORWAY_REGIONS, connections=LINKS)
    hc.seed("living", 1, 0.0)
    walk(hc, "living", 1, 1.0, [(3000.0, 3000.0), (2000.0, 2000.0), (1000.0, 500.0)])  # into the stairwell
    assert hc.by_region()["living"] == 1
    hc.frame("entry", {4: (500.0, 400.0)}, 30.0)  # at the bottom of the stairs
    assert bound(hc, "entry", 4) is not None and hc.by_region() == {"bedroom": 0, "living": 0, "entry": 1, "garage": 0}


def test_ec56_someone_in_doubt_comes_back_through_a_doorway_not_out_of_thin_air() -> None:
    """EC-56: someone in doubt in another region does not explain a track in the middle of a region with doorways."""
    regions = [*DOORWAY_REGIONS[:3], Region("study", 1)]
    hc = HeadCount(regions, connections=[*LINKS[:2], ("entry", "study", None)])
    hc.seed("study", 1, 0.0)
    (study,) = hc.tokens
    hc.door(FRONT, True, 100.0)
    assert hc.tokens[study].unknown
    hc.frame("entry", {6: (1000.0, 2500.0)}, 105.0)  # in the middle of the entry, at no doorway
    assert hc.tokens[study].region == "study" and hc.tokens[study].visible is None
    assert hc.tokens[bound(hc, "entry", 6)].reason == "arrived"


def test_ec60_a_sleeper_does_not_explain_a_track_on_the_exit_floor() -> None:
    """EC-60: during an exit window, a new track on the exit floor is someone coming in unless someone seen within
    RECENT_S one hop away explains it."""
    hc = HeadCount(REGIONS, connections=LINKS)
    hc.seed("living", 1, 0.0)  # asleep one floor up (one hop) since long ago
    hc.door(FRONT, True, 1000.0)
    hc.frame("entry", {5: (500.0, 1500.0)}, 1005.0)
    sleeper = next(tok for tok in hc.tokens.values() if tok.reason == "restored")
    assert sleeper.region == "living"
    assert hc.tokens[bound(hc, "entry", 5)].reason == "arrived"


def test_ec60_someone_just_seen_one_hop_away_does_explain_it() -> None:
    hc = HeadCount(REGIONS, connections=LINKS)
    hc.seed("bedroom", 1, 0.0)
    hc.seed("living", 1, 0.0)
    walk(hc, "living", 1, 970.0, [(1000.0 + 100 * k, 1000.0) for k in range(5)])
    living = hc._binding[("living", 1)]
    hc.door(FRONT, True, 1000.0)
    hc.frame("entry", {5: (500.0, 1500.0)}, 1005.0)
    assert bound(hc, "entry", 5) == living and len(hc.tokens) == 2


def test_ec60_someone_just_seen_two_hops_away_does_not() -> None:
    hc = HeadCount(REGIONS, connections=LINKS)
    hc.seed("bedroom", 1, 0.0)
    walk(hc, "bedroom", 1, 970.0, [(1000.0 + 100 * k, 1000.0) for k in range(5)])
    bedroom = hc._binding[("bedroom", 1)]
    hc.door(FRONT, True, 1000.0)
    hc.frame("entry", {5: (500.0, 1500.0)}, 1005.0)
    assert bound(hc, "entry", 5) != bedroom and hc.tokens[bedroom].region == "bedroom"


def test_ec63_seen_through_the_door_before_it_opens_then_coming_in() -> None:
    """EC-63: a track at the front door before it opens waits; once the door opens it is someone arriving."""
    hc = HeadCount(DOORWAY_REGIONS, connections=LINKS)
    hc.frame("entry", {3: (-2000.0, 2500.0)}, 1000.0)  # in the doorway, the door still shut
    assert ("entry", 3) in hc._pending and not hc.tokens
    hc.door(FRONT, True, 1003.0)
    hc.frame("entry", {3: (-1500.0, 2400.0)}, 1004.0)
    tok = hc.tokens[bound(hc, "entry", 3)]
    assert tok.reason == "arrived" and tok.unknown
    hc.door(FRONT, False, 1008.0)
    roam(hc, "entry", 3, 1009.0, 1070.0, x0=-1000.0, y0=1500.0)  # still in the hallway after the door closed
    assert hc.count() == 1


def test_ec65_a_virtual_exit_during_a_window_extends_it() -> None:
    """EC-65: someone walking out through the doorway while the floor's window is settling keeps it open."""
    hc = HeadCount(DOORWAY_REGIONS, connections=LINKS)
    hc.seed("entry", 1, 0.0)
    hc.door(FRONT, True, 1000.0)
    hc.door(FRONT, False, 1005.0)
    assert hc._windows[1].closed == 1005.0
    t = walk(hc, "entry", 2, 1020.0, [(-1000.0, 1800.0), (-1600.0, 2300.0), (-2000.0, 2600.0)])  # out, gone
    assert hc._windows[1].closed == t


def test_ec70_two_exits_used_in_opposite_directions_make_the_direction_unknown() -> None:
    """EC-70: the big door first (coming in: nobody inside in doubt), then the front door on the same floor: no
    longer known which way, so whoever is on the floor is in doubt."""
    regions = [*DOORWAY_REGIONS[:3], Region("garage", 1, (BIG_DOOR,), observed=False)]
    hc = HeadCount(regions, connections=LINKS)
    hc.seed("entry", 1, 0.0)
    hc.door(BIG_DOOR, True, 1000.0)
    assert hc._windows[1].direction == "in" and not any(tok.unknown for tok in hc.tokens.values())
    hc.door(FRONT, True, 1010.0)
    assert hc._windows[1].direction is None and all(tok.unknown for tok in hc.tokens.values())


# ------------------------------------------------------------- still tracks


def test_ec81_a_track_that_never_moves_gives_its_person_back() -> None:
    """EC-81 / HC-ST-1: a track within STATIC_MM of where it appeared for STATIC_S is a machine; the person it was
    given to goes back to where they were (kept, not removed)."""
    hc = HeadCount(REGIONS, connections=LINKS)
    hc.seed("bedroom", 1, 0.0)
    (tok,) = hc.tokens
    for k in range(int(STATIC_S) + 10):
        hc.frame("living", {4: (1000.0 + (k % 3) * 30, 1000.0)}, 100.0 + k)
    assert hc.count() == 1 and hc.tokens[tok].visible is None and hc.tokens[tok].region == "bedroom"
    assert any(c.kind == "ghost" and "given back" in c.detail for c in hc.changes)


def test_ec82_a_still_track_that_starts_moving_is_a_new_appearance() -> None:
    """EC-82: once it moves STATIC_MM from where it appeared it is a track again, appearing from there."""
    hc = HeadCount(REGIONS, connections=LINKS)
    hc.seed("living", 1, 0.0)
    (tok,) = hc.tokens
    t = 100.0
    for k in range(int(STATIC_S) + 10):
        hc.frame("living", {4: (1000.0 + (k % 3) * 30, 1000.0)}, t)
        t += 1
    assert hc.tokens[tok].visible is None
    for k in range(1, 6):
        hc.frame("living", {4: (1000.0 + 150 * k, 1000.0)}, t)
        t += 1
    assert bound(hc, "living", 4) == tok


# --------------------------------------------------------------- reflections


def test_ec50_a_reflection_explains_nobody_until_another_radar_sees_it() -> None:
    """EC-50 / RT-REF-1: a track only one radar sees where another looks waits (it is not bound, nor a new person);
    once confirmed it is matched like any other."""
    hc = HeadCount(REGIONS, connections=LINKS)
    hc.seed("living", 1, 0.0)
    (tok,) = hc.tokens
    for k in range(int(CONFIRM_S) + 30):
        hc.frame("living", {8: (1000.0 + (k % 7) * 100, 2000.0)}, 100.0 + k, unconfirmed={8})
    assert bound(hc, "living", 8) is None and len(hc.tokens) == 1
    hc.frame("living", {8: (1500.0, 2100.0)}, 200.0)
    assert bound(hc, "living", 8) == tok


# ------------------------------------------------------- occupancy sensors

BED_DOOR = Portal("Bedroom door", ((0, 4000), (1000, 4000), (1000, 4500), (0, 4500)), ("bedroom",))
BED_REGIONS = [Region("bedroom", 1), Region("hall", 1, (FRONT,), portals=(BED_DOOR,))]
BED_LINKS = [("bedroom", "hall", None)]


def test_occupancy_keeps_the_person_in_bed_from_explaining_a_track_elsewhere() -> None:
    """A bed sensor on: the person in bed is anchored. A track in the hall is not them; once they get up it can be."""
    free = HeadCount(BED_REGIONS, connections=BED_LINKS)
    free.seed("bedroom", 1, 0.0)
    roam(free, "hall", 2, 100, 110, x0=2000.0, y0=1000.0)
    assert free.by_region() == {"bedroom": 0, "hall": 1}  # (without the sensor: the unseen sleeper)

    hc = HeadCount(BED_REGIONS, connections=BED_LINKS)
    hc.seed("bedroom", 1, 0.0)
    (tok,) = hc.tokens
    hc.hold("bedroom", True, 50.0, "binary_sensor.bed")
    assert hc.held() == {"bedroom": tok}
    roam(hc, "hall", 2, 100, 140, x0=2000.0, y0=1000.0)  # a ghost in the hall at night
    hc.frame("hall", {}, 141)
    assert hc.by_region() == {"bedroom": 1, "hall": 0} and len(hc.tokens) == 1
    hc.hold("bedroom", False, 200.0, "binary_sensor.bed")  # gets up
    assert hc.held() == {}
    roam(hc, "hall", 3, 210, 215, x0=2000.0, y0=1000.0)
    assert bound(hc, "hall", 3) == tok


def test_occupancy_person_in_bed_is_not_put_in_doubt_by_the_exit() -> None:
    """Someone in bed did not go out: the front door on their floor leaves them counted."""
    free = HeadCount(BED_REGIONS, connections=BED_LINKS)
    free.seed("bedroom", 1, 0.0)
    free.door(FRONT, True, 100.0)
    free.door(FRONT, False, 105.0)
    free.advance(105.0 + REESTABLISH_S + 10)
    assert free.count() == 0  # (without the sensor: unseen after the door, so gone)

    hc = HeadCount(BED_REGIONS, connections=BED_LINKS)
    hc.seed("bedroom", 1, 0.0)
    hc.hold("bedroom", True, 50.0)
    hc.door(FRONT, True, 100.0)
    assert not any(tok.unknown for tok in hc.tokens.values())
    hc.door(FRONT, False, 105.0)
    hc.advance(105.0 + REESTABLISH_S + 10)
    assert hc.count() == 1


def test_occupancy_in_doubt_already_is_back_at_once() -> None:
    hc = HeadCount(BED_REGIONS, connections=BED_LINKS)
    hc.seed("bedroom", 1, 0.0)
    hc.door(FRONT, True, 100.0)
    assert hc.unknown_floors() == {1} and hc.count() == 0
    hc.hold("bedroom", True, 102.0)  # lies down while the door is still open: inside
    assert hc.count() == 1


def test_occupancy_pulls_the_unseen_person_in_but_never_adds_one() -> None:
    hc = HeadCount(BED_REGIONS, connections=BED_LINKS)
    hc.hold("bedroom", True, 10.0)
    assert hc.count() == 0 and hc.held() == {"bedroom": None}
    hc.seed("hall", 1, 0.0)
    hc.hold("bedroom", True, 20.0)  # (again: whoever could have walked there)
    assert hc.by_region() == {"bedroom": 1, "hall": 0}


def test_occupancy_coming_out_through_the_bedroom_door_is_the_person_in_bed() -> None:
    """The sensor lags getting up: a track appearing at the bedroom's doorway can still be the anchored person."""
    hc = HeadCount(BED_REGIONS, connections=BED_LINKS)
    hc.seed("bedroom", 1, 0.0)
    (tok,) = hc.tokens
    hc.hold("bedroom", True, 50.0)
    walk(hc, "hall", 4, 300.0, [(500.0, 4200.0), (800.0, 3500.0), (1200.0, 2500.0)])
    assert hc.tokens[tok].region == "hall" and hc.held() == {"bedroom": None}


def test_occupancy_two_in_bed_one_gets_up() -> None:
    """Two in bed, either side on: one anchor. The other one is free to be a track elsewhere; the anchor stays."""
    hc = HeadCount(BED_REGIONS, connections=BED_LINKS)
    hc.seed("bedroom", 2, 0.0)
    hc.hold("bedroom", True, 50.0)
    anchor = hc.held()["bedroom"]
    roam(hc, "hall", 2, 100, 105, x0=2000.0, y0=1000.0)
    assert bound(hc, "hall", 2) not in (None, anchor) and hc.by_region() == {"bedroom": 1, "hall": 1}


def test_occupancy_a_correction_removes_the_anchored_person_last() -> None:
    hc = HeadCount(BED_REGIONS, connections=BED_LINKS)
    hc.seed("bedroom", 1, 0.0)
    hc.seed("hall", 1, 0.0)
    hc.hold("bedroom", True, 50.0)
    anchor = hc.held()["bedroom"]
    hc.correct_home(1, 60.0)
    assert list(hc.tokens) == [anchor]

