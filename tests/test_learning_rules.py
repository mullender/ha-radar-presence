"""learning.spot_like: room shapes that are spots in all but name (as the panel's plan.js spotLike)."""

from custom_components.radar_zone_presence.learning import spot_like

ROOM = ((-3000, 0), (3000, 0), (3000, 5000), (-3000, 5000))
DESK = ((0, 1000), (1000, 1000), (1000, 2000), (0, 2000))  # inside the room
STRIP = ((2500, -1000), (3500, -1000), (3500, 1000), (2500, 1000))  # extends the room: overlaps it
APART = ((-1000, 6000), (0, 6000), (0, 7000), (-1000, 7000))  # a desk drawn on its own
KITCHEN = ((4000, 0), (8000, 0), (8000, 4000), (4000, 4000))


def test_a_shape_inside_a_room_is_a_spot() -> None:
    assert spot_like([(ROOM, None), (DESK, None), (KITCHEN, "kitchen")]) == [DESK]


def test_a_strip_that_extends_a_room_is_not_but_a_desk_on_its_own_is() -> None:
    assert spot_like([(ROOM, None), (STRIP, None), (APART, None)]) == [APART]


def test_a_small_shape_in_another_area_is_a_room() -> None:
    assert spot_like([(ROOM, None), (APART, "closet")]) == []


def test_a_strip_sharing_an_edge_exactly_is_not_a_spot() -> None:
    edge = ((-1000, -1000), (1000, -1000), (1000, 0), (-1000, 0))
    assert spot_like([(ROOM, None), (edge, None)]) == []
