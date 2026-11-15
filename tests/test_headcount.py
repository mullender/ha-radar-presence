"""Head count from conservation of people (engine/headcount.py), on a synthetic Saturday morning.

Two people asleep on the 3rd floor (one in a room without a radar). One gets
up, goes down to the kitchen, the hallway, through the garage-entry door into
the garage and out through the big door; an hour later comes back the same
way. Counts per floor must follow, and the home count must only change at the
true exit.
"""

from __future__ import annotations

import pytest

from custom_components.radar_zone_presence.engine.headcount import HeadCount, Region

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


def see(hc: HeadCount, region: str, t0: float, t1: float, tracks: dict[int, tuple[float, float]]) -> None:
    t = t0
    while t <= t1:
        hc.frame(region, tracks, t)
        t += 1.0
    hc.frame(region, {}, t1 + 1)


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
    hc.advance(4900)
    assert floors(hc) == (2, 1, 0, 1)


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


@pytest.mark.xfail(reason="open: the arrival is matched to the unseen sleeper upstairs instead of counted", strict=True)
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
    see(hc, "entry", 4852, 4860, {2: (500, 1500)})
    hc.advance(4900)
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
