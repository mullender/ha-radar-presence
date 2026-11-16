"""The home's head count (engine/headcount.py) fed live from the radar groups and door sensors.

Spaces are Home Assistant areas: every radar group used for the head count
is the space of its anchor radar's area; areas an exit zone leads to (or the
area of an outside door) that no radar watches are spaces without a radar.
Floors are the areas' HA floor levels. Exit zones say where they lead
(``leads_to``: areas, or "outside"); that gives the doorways and the
connections between spaces, gated by the zone's door sensor if it has one.
Doors to outside that no radar sees (a garage door) are configured on the
home; locks count as door activity.
"""

from __future__ import annotations

import logging
import math
import time
from dataclasses import dataclass
from datetime import timedelta
from typing import TYPE_CHECKING, Any

from homeassistant.core import CALLBACK_TYPE, Event, EventStateChangedData, HomeAssistant, callback
from homeassistant.helpers import area_registry as ar, device_registry as dr, entity_registry as er, floor_registry as fr
from homeassistant.helpers.event import async_track_state_change_event, async_track_time_interval
from homeassistant.helpers.storage import Store

from .const import CONF_OUTSIDE_DOORS, DOMAIN, OUTSIDE
from .engine.align import apply, invert, transform_polygon
from .engine.headcount import HeadCount, Portal, Region
from .engine.rooms import RoomRadar, Rooms
from .engine.tracker import side_margin

if TYPE_CHECKING:
    from .home import GroupRuntime, HomeRuntime

_LOGGER = logging.getLogger(__name__)

STORE_VERSION = 1
SAVE_DELAY_S = 10
TICK_S = 5
BOOTSTRAP_S = 3600.0  # without saved counts, people seen in the first hour count without a door
COVER_MARGIN_MM = 500.0  # another radar "looks" at a spot this far inside its view
OPEN_STATES = {"on", "open", "opening", "closing"}


@dataclass(frozen=True, slots=True)
class SpaceInfo:
    id: str  # region id: the area id (plus the anchor radar if an area is in several groups)
    name: str
    area_id: str
    floor_id: str | None
    floor_name: str | None
    level: int
    observed: bool


class HeadCountRuntime:
    """Builds the head count's spaces from the home's radars and areas, and keeps it fed."""

    def __init__(self, hass: HomeAssistant, home: HomeRuntime) -> None:
        self.hass = hass
        self.home = home
        self.spaces: dict[str, SpaceInfo] = {}
        # id(group) -> (rooms splitter when its radars sit in several areas, area -> region id)
        self.region_of_group: dict[int, tuple[Rooms | None, dict[str, str]]] = {}
        self.floors: dict[int, tuple[str | None, str]] = {}  # level -> (floor id, name)
        self._listeners: list[CALLBACK_TYPE] = []
        self._unsubs: list[CALLBACK_TYPE] = []
        self._store: Store[dict[str, Any]] = Store(hass, STORE_VERSION, f"{DOMAIN}.headcount.{home.entry.entry_id}")
        self._last: tuple | None = None
        self.hc: HeadCount | None = None
        self._door_kind: dict[str, str] = {}  # entity -> "door" | "lock"
        self._build()

    # ---------------------------------------------------------------- build

    def _area(self, area_id: str | None) -> tuple[str, str | None, str | None, int] | None:
        if not area_id:
            return None
        area = ar.async_get(self.hass).async_get_area(area_id)
        if area is None:
            return None
        floor = fr.async_get(self.hass).async_get_floor(area.floor_id) if area.floor_id else None
        level = floor.level if floor is not None and floor.level is not None else 0
        return area.name, floor.floor_id if floor else None, floor.name if floor else None, level

    def _entity_area(self, entity_id: str) -> str | None:
        ent = er.async_get(self.hass).async_get(entity_id)
        if ent is None:
            return None
        if ent.area_id:
            return ent.area_id
        if ent.device_id and (dev := dr.async_get(self.hass).async_get(ent.device_id)):
            return dev.area_id
        return None

    def _add_space(self, region_id: str, area_id: str, observed: bool) -> None:
        info = self._area(area_id)
        if info is None:
            return
        name, floor_id, floor_name, level = info
        self.spaces[region_id] = SpaceInfo(region_id, name, area_id, floor_id, floor_name, level, observed)
        self.floors.setdefault(level, (floor_id, floor_name or f"Floor {level}"))

    def _build(self) -> None:
        home = self.home
        dev_reg = dr.async_get(self.hass)
        area_region: dict[str, str] = {}
        groups: list[tuple[GroupRuntime, dict[str, str]]] = []  # (group, radar id -> region id)
        group_links: list[tuple[str, str]] = []

        def device_area(device_id: str) -> str | None:
            device = dev_reg.async_get(device_id)
            return device.area_id if device else None

        for group in home.groups:
            used = [f for f in group.feeds if f.headcount]
            if not used:
                continue
            # Aligned radars share their tracks, not their room: each radar's area is a space.
            anchor_area = device_area(home.feeds[group.anchor].device_id)
            feed_area: dict[str, str] = {}
            for feed in used:
                area_id = device_area(feed.device_id) or anchor_area
                if area_id and self._area(area_id) is not None:
                    feed_area[feed.id] = area_id
            if not feed_area:
                _LOGGER.debug("Head count: %s has no area, left out", home.feeds[group.anchor].title)
                continue
            # Zones are in rooms too: a radar can see into the next room, and a zone there is in that room.
            zone_rooms = [
                (area_id, transform_polygon(group.to_anchor[zd.radar_id], zd.zone.polygon))
                for zd in group.zone_defs.values()
                if zd.radar_id in feed_area
                and (area_id := zd.zone.area_id or feed_area[zd.radar_id])
                and self._area(area_id) is not None
            ]
            region_of_area: dict[str, str] = {}
            for area_id in dict.fromkeys([*feed_area.values(), *(a for a, _ in zone_rooms)]):
                region_id = area_id if area_id not in area_region else f"{area_id}_{group.anchor[-6:]}"
                area_region.setdefault(area_id, region_id)
                self._add_space(region_id, area_id, True)
                region_of_area[area_id] = region_id
            rooms = None
            if len(region_of_area) > 1:
                rooms = Rooms(
                    [RoomRadar(area_id, rid, group.to_anchor[rid]) for rid, area_id in feed_area.items()],
                    home.max_distance,
                    zone_rooms,
                )
            self.region_of_group[id(group)] = (rooms, region_of_area)
            ids = list(region_of_area.values())
            group_links += [(a, b) for i, a in enumerate(ids) for b in ids[i + 1 :]]  # one tracker sees both: open
            groups.append((group, {rid: region_of_area[a] for rid, a in feed_area.items()}))

        def region_for(area_id: str) -> str | None:
            if area_id not in area_region:
                if self._area(area_id) is None:
                    return None
                area_region[area_id] = area_id
                self._add_space(area_id, area_id, False)
            return area_region[area_id]

        exits: dict[str, list[str]] = {}
        links: set[tuple[str, str, str | None]] = set()
        portals: dict[str, list[Portal]] = {}
        for group, region_of_feed in groups:
            for feed in group.feeds:
                if (region_id := region_of_feed.get(feed.id)) is None:
                    continue
                a = group.to_anchor[feed.id]
                for z in feed.exits:
                    if not z.leads_to:
                        continue
                    dests: list[str] = []
                    outside = False
                    for dest in z.leads_to:
                        if dest == OUTSIDE:
                            outside = True
                            if z.door_entity_id:
                                exits.setdefault(region_id, []).append(z.door_entity_id)
                            continue
                        if (other := region_for(dest)) is not None and other != region_id:
                            dests.append(other)
                            links.add((region_id, other, z.door_entity_id))
                    if dests or outside:
                        portals.setdefault(region_id, []).append(
                            Portal(z.name, transform_polygon(a, z.polygon), () if outside and not dests else tuple(dests))
                        )
        links.update((a, b, None) for a, b in group_links)
        for entity_id in home.entry.options.get(CONF_OUTSIDE_DOORS, []) or []:
            area_id = self._entity_area(entity_id)
            if area_id is None or (region_id := region_for(area_id)) is None:
                _LOGGER.warning("Head count: outside door %s has no area, ignored", entity_id)
                continue
            exits.setdefault(region_id, []).append(entity_id)
            self._door_kind[entity_id] = "lock" if entity_id.startswith("lock.") else "door"
        for region_id, doors in exits.items():
            for d in doors:
                self._door_kind.setdefault(d, "lock" if d.startswith("lock.") else "door")
        for _a, _b, door in links:
            if door:
                self._door_kind.setdefault(door, "door")

        if not self.spaces:
            return
        regions = [
            Region(sid, sp.level, tuple(dict.fromkeys(exits.get(sid, []))), sp.name, sp.observed, tuple(portals.get(sid, [])))
            for sid, sp in self.spaces.items()
        ]
        # Collapse links that appear in both directions; prefer one with a door.
        seen: dict[frozenset[str], str | None] = {}
        for a, b, door in sorted(links, key=lambda x: x[2] is None):
            seen.setdefault(frozenset((a, b)), door)
        connections = [(*sorted(k), door) for k, door in seen.items()]
        self.hc = HeadCount(regions, bootstrap_until=time.time() + BOOTSTRAP_S, connections=connections)

    # ------------------------------------------------------------ lifecycle

    async def async_start(self) -> None:
        if self.hc is None:
            return
        saved = await self._store.async_load()
        if saved and isinstance(saved.get("regions"), dict):
            now = time.time()
            self.hc._bootstrap_until = float("-inf")
            for rid, n in saved["regions"].items():
                if rid in self.spaces and isinstance(n, int) and n > 0:
                    self.hc.seed(rid, n, now)
        if self._door_kind:
            self._unsubs.append(async_track_state_change_event(self.hass, list(self._door_kind), self._on_door))
            now = time.time()
            for entity_id, kind in self._door_kind.items():
                state = self.hass.states.get(entity_id)
                if kind == "door" and state is not None and state.state in OPEN_STATES:
                    self.hc.door(entity_id, True, now)
        self._unsubs.append(async_track_time_interval(self.hass, self._tick, timedelta(seconds=TICK_S)))
        self._changed()

    @callback
    def async_stop(self) -> None:
        for unsub in self._unsubs:
            unsub()
        self._unsubs.clear()
        if self.hc is not None:
            self._store.async_delay_save(self._data, 0)

    @callback
    def async_add_listener(self, cb: CALLBACK_TYPE) -> CALLBACK_TYPE:
        self._listeners.append(cb)
        return lambda: self._listeners.remove(cb)

    # --------------------------------------------------------------- inputs

    @callback
    def frame(self, group: GroupRuntime, t: float) -> None:
        """After a group evaluated: its tracks (in the anchor's frame) go to the head count."""
        if self.hc is None or (found := self.region_of_group.get(id(group))) is None:
            return
        rooms, region_of_area = found
        tracks = {tg.slot: (tg.x, tg.y) for tg in group.last_targets}
        unconfirmed = self._unconfirmed(group)
        if rooms is None:
            self.hc.frame(next(iter(region_of_area.values())), tracks, t, unconfirmed)
        else:
            parts = rooms.split(tracks)
            self.hc.frame_group({region_of_area[a]: part for a, part in parts.items()}, t, unconfirmed)
        self._changed()

    def _unconfirmed(self, group: GroupRuntime) -> set[int]:
        """Tracks seen by one radar only, where another radar of the group looks: a reflection until confirmed."""
        if len(group.feeds) < 2:
            return set()
        out = set()
        for tg in group.last_targets:
            radars = group.track_radars.get(tg.slot, frozenset())
            if len(radars) != 1:
                continue
            for k, feed in enumerate(group.feeds):
                if k in radars or not feed.available:
                    continue
                x, y = apply(invert(group.to_anchor[feed.id]), tg.x, tg.y)
                max_d = self.home.max_distance(feed.id)
                if side_margin(x, y) >= COVER_MARGIN_MM and math.hypot(x, y) <= max_d - COVER_MARGIN_MM:
                    out.add(tg.slot)
                    break
        return out

    @callback
    def _on_door(self, event: Event[EventStateChangedData]) -> None:
        if self.hc is None:
            return
        entity_id = event.data["entity_id"]
        new, old = event.data["new_state"], event.data["old_state"]
        if new is None or new.state in ("unavailable", "unknown"):
            return
        t = new.last_changed_timestamp
        if self._door_kind.get(entity_id) == "lock":
            if old is not None and old.state != new.state and old.state not in ("unavailable", "unknown"):
                self.hc.pulse(entity_id, t)
        else:
            self.hc.door(entity_id, new.state in OPEN_STATES, t)
        self._changed()

    @callback
    def _tick(self, _now: Any) -> None:
        if self.hc is None:
            return
        self.hc.advance(time.time())
        self._changed()

    # --------------------------------------------------------------- output

    def _data(self) -> dict[str, Any]:
        assert self.hc is not None
        return {"regions": self.hc.by_region()}

    @callback
    def _changed(self) -> None:
        if self.hc is None:
            return
        if len(self.hc.changes) > 500:  # a log for the panel, not a history
            del self.hc.changes[:-200]
        state = (self.hc.count(), tuple(sorted(self.hc.by_region().items())), tuple(sorted(self.hc.unknown_floors())))
        if state == self._last:
            return
        self._last = state
        if not self.hc.unknown():
            self._store.async_delay_save(self._data, SAVE_DELAY_S)
        for cb in list(self._listeners):
            cb()

    def home_count(self) -> int | None:
        return None if self.hc is None or self.hc.unknown() else self.hc.count()

    def floor_count(self, level: int) -> int | None:
        if self.hc is None or level in self.hc.unknown_floors():
            return None
        return self.hc.by_floor().get(level, 0)

    def space_count(self, region_id: str) -> int | None:
        if self.hc is None or region_id not in self.spaces:
            return None
        if self.spaces[region_id].level in self.hc.unknown_floors():
            return None
        return self.hc.by_region().get(region_id, 0)

    def known(self) -> int:
        """People known to be home right now (without those on a floor whose exit is in use)."""
        return 0 if self.hc is None else self.hc.count()

    def debug(self) -> dict[str, Any]:
        """For the panel / diagnostics: spaces, tokens and recent changes."""
        if self.hc is None:
            return {"spaces": [], "tokens": [], "changes": []}
        hc = self.hc
        return {
            "home": self.home_count(),
            "known": hc.count(),
            "unknown_floors": sorted(hc.unknown_floors()),
            "spaces": [
                {"id": sp.id, "name": sp.name, "area_id": sp.area_id, "level": sp.level, "observed": sp.observed,
                 "count": self.space_count(sp.id), "exits": list(hc.regions[sp.id].exits),
                 "portals": [{"name": p.name, "to": list(p.to)} for p in hc.regions[sp.id].portals]}
                for sp in self.spaces.values()
            ],
            "connections": [[a, b, d] for a, links in hc._links.items() for b, d in links if a < b],
            "tokens": [
                {"id": tok.id, "region": tok.region, "last_seen": tok.last_seen, "reason": tok.reason,
                 "visible": tok.visible is not None, "unknown": tok.unknown, "provisional": tok.provisional}
                for tok in hc.tokens.values()
            ],
            "changes": [[c.t, c.kind, c.token, c.region, c.detail] for c in hc.changes[-50:]],
        }

    def unique_ids(self) -> set[str]:
        """The head-count sensors' unique ids (to keep them when cleaning up stale entities)."""
        if self.hc is None:
            return set()
        eid = self.home.entry.entry_id
        return {f"{eid}_people", *(f"{eid}_people_floor_{lv}" for lv in self.floors), *(f"{eid}_people_{s}" for s in self.spaces)}
