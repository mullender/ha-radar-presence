"""Which room a fused track is in, when one tracker sees into several rooms.

Aligning radars merges their tracks into one picture; it does not merge the
rooms. Zones are in rooms (a zone's area, else its radar's), and a radar can
see zones in several rooms (through a doorway). A track inside a zone is in
that zone's room (the smallest zone, where they overlap). Elsewhere it belongs
to the room of the nearest radar that covers its spot: in the hall in front of the hall radar it is the hall, even where the
bedroom radar sees it through the door; in the bedroom behind the hall radar's
wall only the bedroom radar looks, so it is the bedroom. A track keeps its room
until another room's radar is clearly nearer, so a doorway does not flicker.
"""

from __future__ import annotations

import math
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass

from .align import Affine, apply, invert
from .geometry import Polygon, point_in_polygon, polygon_area
from .tracker import side_margin

HYSTERESIS_MM = 500.0


@dataclass(frozen=True, slots=True)
class RoomRadar:
    room: str
    radar_id: str
    to_anchor: Affine  # the radar's frame -> the group's (anchor) frame


class Rooms:
    """Splits a group's fused tracks (anchor frame) by room."""

    def __init__(
        self,
        radars: Sequence[RoomRadar],
        max_distance: Callable[[str], float],
        zones: Sequence[tuple[str, Polygon]] = (),  # (room, polygon in the anchor's frame)
    ) -> None:
        self.rooms = list(dict.fromkeys([*(r.room for r in radars), *(room for room, _ in zones)]))
        self._zones = sorted(zones, key=lambda z: abs(polygon_area(z[1])))  # smallest first
        self._radars = [(r.room, r.radar_id, invert(r.to_anchor)) for r in radars]
        self._max_distance = max_distance  # the radar's range setting can change at run time
        self._room_of: dict[int, str] = {}

    def room_at(self, x: float, y: float, previous: str | None = None) -> str:
        for room, polygon in self._zones:
            if point_in_polygon(x, y, polygon):
                return room
        best: dict[str, float] = {}  # room -> distance to its nearest radar that covers the spot
        near: dict[str, float] = {}  # same, ignoring coverage (the fallback)
        for room, radar_id, from_anchor in self._radars:
            rx, ry = apply(from_anchor, x, y)
            d = math.hypot(rx, ry)
            near[room] = min(near.get(room, math.inf), d)
            if side_margin(rx, ry) >= 0 and d <= self._max_distance(radar_id):
                best[room] = min(best.get(room, math.inf), d)
        dist = best or near
        room = min(dist, key=dist.__getitem__)
        if previous in dist and dist[previous] <= dist[room] + HYSTERESIS_MM:
            return previous
        return room

    def split(self, tracks: Mapping[int, tuple[float, float]]) -> dict[str, dict[int, tuple[float, float]]]:
        out: dict[str, dict[int, tuple[float, float]]] = {room: {} for room in self.rooms}
        room_of: dict[int, str] = {}
        for slot, (x, y) in tracks.items():
            room = self.room_at(x, y, self._room_of.get(slot))
            room_of[slot] = room
            out[room][slot] = (x, y)
        self._room_of = room_of
        return out
