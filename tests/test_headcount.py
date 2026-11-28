"""Head count from conservation of people (engine/headcount.py), on a synthetic Saturday morning.

Two people asleep on the 3rd floor (one in a room without a radar). One gets
up, goes down to the kitchen, the hallway, through the garage-entry door into
the garage and out through the big door; an hour later comes back the same
way. Counts per floor must follow, and the home count must only change at the
true exit.
"""

from __future__ import annotations

import pytest

from custom_components.radar_zone_presence.engine.headcount import HeadCount, Portal, Region

BIG_DOOR = "cover.garage_door"
GARAGE_ENTRY = "binary_sensor.garage_entry_door"
FRONT = "binary_sensor.front_door"

REGIONS = [
    Region("bedroom", 3),
    Region("living", 2),
    Region("entry", 1, (FRONT,)),
    Region("garage", 1, (BIG_DOOR,)),
]
LINKS = [("bedroom", "living", None), ("living", "entry", None), ("entry", "garage", GARAGE_ENTRY)]


def floors(hc: HeadCount) -> tuple[int, int, int, int]:
    f = hc.by_floor()
    return hc.count(), f[3], f[2], f[1]


def see(hc: HeadCount, region: str, t0: float, t1: float, tracks: dict[int, tuple[float, float]], drift: float = 8.0) -> None:
    """Tracks seen from t0 to t1, drifting `drift` mm/s (a person's track never stands perfectly still), then gone."""
    t = t0
    while t <= t1:
        hc.frame(region, {k: (x + drift * (t - t0), y) for k, (x, y) in tracks.items()}, t)
        t += 1.0
    hc.frame(region, {}, t1 + 1)


def walk(hc: HeadCount, region: str, tid: int, t0: float, path: list[tuple[float, float]], dt: float = 1.0) -> float:
    """One track moving continuously along ``path`` (one point per frame), then gone. Returns the time it vanished."""
    t = t0
    for pt in path:
        hc.frame(region, {tid: pt}, t)
        t += dt
    hc.frame(region, {}, t)
    return t


def test_saturday_morning() -> None:
    hc = HeadCount(REGIONS, bootstrap_until=100, connections=LINKS)
    see(hc, "bedroom", 0, 25, {1: (0, 2000), 2: (2500, 3000)})  # both seen once, then asleep (lost)
    assert floors(hc) == (2, 2, 0, 0)

    see(hc, "bedroom", 1000, 1100, {3: (0, 2100)})  # one gets up
    assert floors(hc) == (2, 2, 0, 0)
    see(hc, "living", 1105, 1200, {1: (1000, 1000)})  # kitchen
    assert floors(hc) == (2, 1, 1, 0)
    see(hc, "entry", 1205, 1214, {1: (500, 1500)})  # down to the hallway
    assert floors(hc) == (2, 1, 0, 1)
    hc.door(GARAGE_ENTRY, True, 1213)
    hc.door(GARAGE_ENTRY, False, 1216)
    see(hc, "garage", 1216, 1240, {1: (-2000, 3000)})
    hc.door(BIG_DOOR, True, 1225)
    hc.door(BIG_DOOR, False, 1240)
    hc.advance(1300)
    assert floors(hc) == (1, 1, 0, 0)  # left; the sleeper still counted upstairs

    # Back an hour later: a track in the garage as the big door opens is someone coming in...
    hc.door(BIG_DOOR, True, 4800)
    see(hc, "garage", 4802, 4830, {5: (2500, 4500)})
    assert hc.count() == 1  # (not yet: could be the car)
    hc.door(BIG_DOOR, False, 4815)
    hc.door(GARAGE_ENTRY, True, 4829)
    hc.door(GARAGE_ENTRY, False, 4831)
    see(hc, "entry", 4832, 4840, {2: (500, 1500)})  # ...who walks on into the hallway
    assert hc.unknown()  # the doors were just used: the hallway's count is not firm yet
    see(hc, "living", 4845, 4870, {4: (1000, 1000)})  # ...and up the stairs: in
    hc.advance(4900)
    assert not hc.unknown()
    assert floors(hc) == (2, 1, 1, 0)


def test_car_in_the_garage_is_not_a_person() -> None:
    hc = HeadCount(REGIONS, bootstrap_until=100, connections=LINKS)
    see(hc, "bedroom", 0, 25, {1: (0, 2000)})
    hc.door(BIG_DOOR, True, 1000)
    see(hc, "garage", 1002, 1060, {7: (2000, 2000)})  # the car pulls in; nobody opens the door to the house
    hc.door(BIG_DOOR, False, 1020)
    see(hc, "bedroom", 1070, 1080, {4: (0, 2100)})  # the sleeper turns over upstairs
    hc.advance(2000)
    assert floors(hc) == (1, 1, 0, 0)


def test_going_to_the_door_and_back_changes_nothing() -> None:
    hc = HeadCount(REGIONS, bootstrap_until=100, connections=LINKS)
    see(hc, "bedroom", 0, 25, {1: (0, 2000), 2: (2500, 3000)})
    see(hc, "entry", 500, 530, {1: (500, 1500)})  # someone at the front door...
    hc.door(FRONT, True, 510)
    hc.door(FRONT, False, 516)
    see(hc, "living", 535, 560, {3: (0, 1500)})  # ...and back up the stairs
    hc.advance(700)
    assert hc.count() == 2


def test_nobody_appears_without_a_door() -> None:
    """A track no one can explain (a washer, a reflection) does not add a person unless it walks or stays."""
    hc = HeadCount(REGIONS, bootstrap_until=100, connections=LINKS)
    see(hc, "bedroom", 0, 25, {1: (0, 2000)})
    see(hc, "bedroom", 200, 210, {1: (0, 2000)})  # still visible...
    see(hc, "living", 200, 400, {9: (3000, 4000)})  # ...while something moves downstairs for minutes
    assert hc.count() == 1


def test_saturday_morning_with_an_unobserved_garage() -> None:
    """The garage radar only sees ghosts through the glass door: the garage is inferred from its two doors."""
    regions = [*REGIONS[:3], Region("garage", 1, (BIG_DOOR,), observed=False)]
    hc = HeadCount(regions, bootstrap_until=100, connections=LINKS)
    see(hc, "bedroom", 0, 25, {1: (0, 2000), 2: (2500, 3000)})
    see(hc, "bedroom", 1000, 1100, {3: (0, 2100)})
    see(hc, "living", 1105, 1200, {1: (1000, 1000)})
    see(hc, "entry", 1205, 1213, {1: (500, 1500)})  # lost at the garage-entry door...
    hc.door(GARAGE_ENTRY, True, 1215)  # ...which opens
    hc.door(GARAGE_ENTRY, False, 1218)
    assert floors(hc) == (2, 1, 0, 1)  # in the garage now
    hc.door(BIG_DOOR, True, 1290)  # a minute later the big door opens and closes
    hc.door(BIG_DOOR, False, 1305)
    hc.advance(1400)
    assert floors(hc) == (1, 1, 0, 0)

    hc.door(BIG_DOOR, True, 4800)  # back: big door, then the garage-entry door, then someone new in the hallway
    hc.door(BIG_DOOR, False, 4815)
    hc.door(GARAGE_ENTRY, True, 4850)
    hc.door(GARAGE_ENTRY, False, 4853)
    see(hc, "entry", 4852, 4900, {2: (500, 1500)})  # (still in the hallway well after the doors closed)
    hc.advance(4920)
    assert floors(hc) == (2, 1, 0, 1)


def test_fetching_something_from_the_garage_is_not_leaving() -> None:
    regions = [*REGIONS[:3], Region("garage", 1, (BIG_DOOR,), observed=False)]
    hc = HeadCount(regions, bootstrap_until=100, connections=LINKS)
    see(hc, "entry", 0, 25, {1: (500, 1500)})
    hc.door(GARAGE_ENTRY, True, 27)
    hc.door(GARAGE_ENTRY, False, 30)
    hc.door(GARAGE_ENTRY, True, 60)
    hc.door(GARAGE_ENTRY, False, 63)
    see(hc, "entry", 62, 80, {1: (500, 1500)})  # back in the hallway; the big door never moved
    hc.advance(400)
    assert floors(hc) == (1, 0, 0, 1)


STAIRS_DOWN = Portal("Stairs", ((0, 0), (1000, 0), (1000, 800), (0, 800)), ("living",))
FRONT_PORTAL = Portal("Front door", ((-2100, 2000), (-1900, 2000), (-1900, 3000), (-2100, 3000)), ())
GARAGE_PORTAL = Portal("Garage entry door", ((-1900, 3200), (-800, 3200), (-800, 3400), (-1900, 3400)), ("garage",))
STAIRS_UP = Portal("Stairs to entry", ((500, 0), (1500, 0), (1500, 1000), (500, 1000)), ("entry", "bedroom"))
DOORWAY_REGIONS = [
    Region("bedroom", 3),
    Region("living", 2, portals=(STAIRS_UP,)),
    Region("entry", 1, (FRONT,), portals=(STAIRS_DOWN, FRONT_PORTAL, GARAGE_PORTAL)),
    Region("garage", 1, (BIG_DOOR,), observed=False),
]


def test_someone_who_sat_still_for_hours_and_then_leaves_is_gone() -> None:
    """A track at the bottom of the stairs is someone from upstairs, however long they sat still."""
    hc = HeadCount(DOORWAY_REGIONS, bootstrap_until=100, connections=LINKS)
    see(hc, "living", 0, 25, {1: (-3000, 4000), 2: (-1000, 3000)})  # two on the couch, then still (lost)
    see(hc, "living", 7200, 7210, {1: (-3000, 4000)})  # one gets up and walks around up there...
    walk(hc, "entry", 5, 7230, [(500, 400)] * 3 + [(500 - 230 * k, 400 + 210 * k) for k in range(1, 11)])  # down the stairs, to the door
    hc.door(FRONT, True, 7250)
    hc.door(FRONT, False, 7256)
    assert hc.unknown()
    hc.advance(7256 + 700)
    assert not hc.unknown()
    assert floors(hc) == (1, 0, 1, 0)


def test_coming_down_to_greet_someone_arriving_through_the_garage() -> None:
    """Big door first (the remote in the car): someone coming in. Nobody inside is put in doubt."""
    hc = HeadCount(DOORWAY_REGIONS, bootstrap_until=100, connections=LINKS)
    see(hc, "living", 0, 25, {1: (-3000, 4000)})
    hc.door(BIG_DOOR, True, 1000)
    hc.door(GARAGE_ENTRY, True, 1030)
    hc.door(BIG_DOOR, False, 1031)
    see(hc, "entry", 1020, 1031, {3: (600, 400)})  # comes down the stairs to say hello...
    see(hc, "entry", 1032, 1045, {3: (300, 1500), 4: (-1300, 2900)})  # ...as someone comes in the garage-entry door
    hc.door(GARAGE_ENTRY, False, 1034)
    see(hc, "entry", 1046, 1050, {3: (700, 500), 4: (1200, 400)})  # both to the stairs
    see(hc, "living", 1052, 1090, {6: (900, 500), 7: (1400, 300)})  # both up the stairs (appearing at the top)
    hc.advance(1200)
    assert floors(hc) == (2, 0, 2, 0)


def test_leaving_through_the_garage_does_not_count_the_door_as_someone_new() -> None:
    """Garage-entry door, then the big door: going out. A track at the garage-entry door is the leaver."""
    hc = HeadCount(DOORWAY_REGIONS, bootstrap_until=100, connections=LINKS)
    see(hc, "living", 0, 25, {1: (-3000, 4000), 2: (-1000, 3000)})
    walk(hc, "entry", 5, 500, [(500, 400)] * 3 + [(500 - 180 * k, 400 + 270 * k) for k in range(1, 11)])  # stairs to the garage door
    hc.door(GARAGE_ENTRY, True, 521)
    hc.door(GARAGE_ENTRY, False, 524)
    hc.door(BIG_DOOR, True, 530)
    see(hc, "entry", 531, 535, {8: (-1300, 3150)})  # a blip at the door as it swings
    hc.door(BIG_DOOR, False, 560)
    hc.advance(560 + 700)
    assert hc.count() == 1


def test_a_ghost_downstairs_does_not_wake_the_sleeper_in_a_room_without_a_radar() -> None:
    """Someone who went into a bedroom without a radar comes out through its door, not as a blip downstairs."""
    door = Portal("Bedroom door", ((200, 4800), (1200, 4800), (1200, 5800), (200, 5800)), ("kids_room",))
    regions = [
        Region("hall", 3, portals=(door,)),
        Region("kids_room", 3, observed=False),
        Region("living", 2),
        Region("entry", 1, (FRONT,)),
    ]
    links = [("hall", "kids_room", None), ("hall", "living", None), ("living", "entry", None)]
    hc = HeadCount(regions, bootstrap_until=100, connections=links)
    see(hc, "hall", 0, 25, {1: (700, 4500)})  # goes to bed: vanishes in the doorway
    see(hc, "living", 0, 25, {2: (-2000, 3000)})
    assert hc.by_region()["kids_room"] == 1
    see(hc, "living", 5000, 5020, {7: (4800, 3200)})  # a short ghost in the living room hours later
    see(hc, "living", 5100, 5110, {2: (-2000, 3000)})  # the other person is seen again
    hc.advance(5200)
    assert hc.by_region()["kids_room"] == 1
    assert hc.count() == 2


def test_walking_out_of_the_front_door_counts_even_if_its_sensor_misses_it() -> None:
    hc = HeadCount(DOORWAY_REGIONS, bootstrap_until=100, connections=LINKS)
    see(hc, "living", 0, 25, {1: (-3000, 4000), 2: (-1000, 3000)})
    path = [(500, 400)] * 3 + [(500 - 180 * k, 400 + 90 * k) for k in range(1, 11)]  # down the stairs to the bench
    path += [(-1300, 1300)] * 10  # shoes on
    path += [(-1500, 1700), (-1800, 2100), (-2050, 2600), (-2600, 2800), (-3200, 3100)]  # through the front door, outside
    walk(hc, "entry", 5, 500, path)  # (its contact logs nothing)
    hc.advance(527 + 700)
    assert hc.count() == 1


# ------------------------------------------------- aligned radars in two rooms

HALL_TO_ANCHOR = ((1.0, 0.0, 0.0), (0.0, 1.0, 0.0))
BED_TO_ANCHOR = ((1.0, 0.0, 2300.0), (0.0, 1.0, -3100.0))  # 3 m behind the hall radar's wall, facing the same way


def test_rooms_follow_the_nearest_radar_that_sees_the_spot() -> None:
    from custom_components.radar_zone_presence.engine.rooms import RoomRadar, Rooms

    rooms = Rooms([RoomRadar("hall", "h", HALL_TO_ANCHOR), RoomRadar("bedroom", "b", BED_TO_ANCHOR)], lambda _rid: 6000.0)
    assert rooms.room_at(1000, 2500) == "hall"  # the bedroom radar sees it too, through the door, from further away
    assert rooms.room_at(2300, -1500) == "bedroom"  # behind the hall radar
    # A zone is in its room, whichever radar sees it.
    zoned = Rooms(
        [RoomRadar("hall", "h", HALL_TO_ANCHOR), RoomRadar("bedroom", "b", BED_TO_ANCHOR)],
        lambda _rid: 6000.0,
        [("closet", ((0, 2000), (2000, 2000), (2000, 3000), (0, 3000)))],
    )
    assert zoned.room_at(1000, 2500) == "closet"
    # Near the line, a track keeps its room.
    split = rooms.split({1: (2300, -1500)})
    assert 1 in split["bedroom"]


def test_walking_out_of_the_bedroom_in_one_track_is_a_handover() -> None:
    hc = HeadCount([Region("hall", 3), Region("bedroom", 3)], connections=[("hall", "bedroom", None)])
    hc.seed("bedroom", 1, 0.0)
    for t in range(1, 5):
        hc.frame_group({"bedroom": {7: (2300.0, -1500.0 + 300 * t)}, "hall": {}}, float(t))
    for t in range(5, 10):
        hc.frame_group({"bedroom": {}, "hall": {7: (1500.0, 300.0 * (t - 4))}}, float(t))
    assert hc.count() == 1 and hc.by_region() == {"hall": 1, "bedroom": 0}
    assert [c.kind for c in hc.changes if c.kind != "restored"] == ["moved"]


# ------------------------------------------------------------------ evidence

DEN_REGIONS = [Region("hall", 3, portals=(Portal("Den door", ((0, 0), (1000, 0), (1000, 500), (0, 500)), ("den",)),)), Region("den", 3, observed=False)]


def test_a_switch_puts_the_unseen_person_in_its_room_but_never_adds_one() -> None:
    hc = HeadCount(DEN_REGIONS, connections=[("hall", "den", None)])
    hc.seed("hall", 1, 0.0)
    hc.evidence("den", 10.0, "light.den")
    assert hc.by_region() == {"hall": 0, "den": 1}
    hc.evidence("den", 20.0, "light.den")  # again: the same person
    hc.evidence("hall", 30.0, "light.hall", move=False)  # switched off: nobody in the hall to confirm, nobody moved
    assert hc.by_region() == {"hall": 0, "den": 1} and hc.count() == 1


def test_a_switch_does_not_pull_someone_out_of_a_room_without_a_radar() -> None:
    hc = HeadCount(DEN_REGIONS, connections=[("hall", "den", None)])
    hc.seed("den", 1, 0.0)  # asleep in the den
    hc.evidence("hall", 10.0, "binary_sensor.hall_closet")  # someone else (not counted) at the hall closet
    assert hc.by_region() == {"hall": 0, "den": 1}


def test_someone_in_the_doorway_explains_the_switch() -> None:
    hc = HeadCount(DEN_REGIONS, connections=[("hall", "den", None)])
    hc.seed("hall", 2, 0.0)
    walk(hc, "hall", 1, 1.0, [(3000.0, 3000.0), (2000.0, 1500.0), (500.0, 700.0)])  # one walks to the den door
    hc.frame("hall", {1: (500.0, 700.0)}, 5.0)
    hc.evidence("den", 5.5, "light.den")  # reaching in for the switch
    assert hc.by_region() == {"hall": 2, "den": 0}  # the other (unseen) one is not moved in


def test_a_switch_in_a_room_a_radar_watches_needs_the_radar_to_see_someone() -> None:
    """A remote carried elsewhere toggles the bedroom light: the bedroom radar sees nobody, so nobody moves in."""
    regions = [Region("living", 3), Region("bedroom", 3)]
    hc = HeadCount(regions, connections=[("living", "bedroom", None)])
    hc.seed("living", 1, 0.0)  # sitting still downstairs, unseen
    hc.frame("bedroom", {}, 90.0)
    assert hc.evidence("bedroom", 100.0, "light.bedroom") == "its radar saw nobody there (a remote used elsewhere?)"
    assert hc.by_region() == {"living": 1, "bedroom": 0}
    # The radar had someone there a moment ago (lost again by the time of the switch): that is them.
    hc.frame("bedroom", {7: (1500.0, 2000.0)}, 200.0)
    hc.frame("bedroom", {}, 201.0)
    assert hc.evidence("bedroom", 205.0, "light.bedroom") is None
    assert hc.by_region() == {"living": 0, "bedroom": 1}


def test_a_correction_removes_the_phantom_first() -> None:
    hc = HeadCount([Region("living", 2)])
    hc.seed("living", 2, 0.0)  # restored after a restart: one real, one left over
    walk(hc, "living", 1, 10.0, [(1000.0, 1000.0), (1200.0, 1100.0)])  # the real one moves (now unseen again)
    seen = next(tok.id for tok in hc.tokens.values() if tok.last_seen > 1.0)
    hc.correct("living", 1, 20.0)
    assert hc.count() == 1 and list(hc.tokens) == [seen]
    hc.correct("living", 2, 30.0)
    assert hc.count() == 2 and [c.kind for c in hc.changes[-2:]] == ["corrected", "corrected"]


def test_nobody_home_clears_everyone() -> None:
    hc = HeadCount([Region("living", 2), Region("bedroom", 3, observed=False)], connections=[("living", "bedroom", None)])
    hc.seed("bedroom", 1, 0.0)
    hc.seed("living", 1, 0.0)
    walk(hc, "living", 1, 10.0, [(1000.0, 1000.0), (1200.0, 1100.0)])  # the one in the living room is seen
    hc.correct_home(1, 30.0)  # one fewer: the one unseen longest (the restored sleeper) goes
    assert hc.by_region() == {"living": 1, "bedroom": 0}
    hc.correct_home(0, 40.0)
    assert hc.count() == 0 and not hc.tokens


def test_a_fan_behind_the_wall_does_not_keep_someone_home() -> None:
    """The last one leaves by the front door; a heater fan behind the entry wall then shows as a still track."""
    hc = HeadCount(REGIONS, connections=LINKS)
    hc.seed("living", 1, 0.0)
    walk(hc, "living", 1, 100.0, [(1000.0 + 200 * k, 1000.0) for k in range(5)])
    t = walk(hc, "entry", 2, 110.0, [(2000.0 - 300 * k, 1500.0) for k in range(5)])  # to the front door, gone
    hc.door(FRONT, True, t)
    hc.door(FRONT, False, t + 5)
    hc.advance(t + 120)
    for k in range(400):  # the fan: one spot, a few cm of jitter, for minutes
        hc.frame("entry", {9: (-270.0 + (k % 3) * 20, 3190.0 + (k % 5) * 10)}, t + 600 + k)
    hc.advance(t + 1200)
    assert hc.count() == 0 and not hc.unknown()
    assert any(c.kind in ("ghost", "not a person") for c in hc.changes)


def test_a_still_track_never_becomes_a_new_person() -> None:
    hc = HeadCount(REGIONS, connections=LINKS)
    for k in range(4000):  # over an hour of a fan at night
        hc.frame("entry", {9: (-270.0 + (k % 3) * 20, 3190.0)}, 1000.0 + k)
    assert hc.count() == 0
