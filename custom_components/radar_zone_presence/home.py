"""Live glue between Home Assistant and the engine, for the whole home.

One config entry is the home. Each radar subentry gets a ``RadarFeed``
(frame assembly, its own exclusions and reconnect grace). Radars linked by
alignments form a group that shares a map (the anchor radar's frame); each
group runs one ``ZoneEngine`` on the fused targets of its radars, with the
zones and exits of all its radars transformed into that frame.

With a single radar this is exactly the old per-radar engine: the transform
is the identity and the fuser passes slots through unchanged.
"""

from __future__ import annotations

import logging
import math
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from homeassistant.config_entries import ConfigEntry, ConfigSubentry
from homeassistant.const import ATTR_UNIT_OF_MEASUREMENT
from homeassistant.core import CALLBACK_TYPE, Event, EventStateChangedData, HomeAssistant, callback
from homeassistant.helpers.event import async_call_later, async_track_state_change_event

from .const import (
    CONF_DEVICE_ID,
    CONF_DISPLAY,
    CONF_HEADCOUNT,
    CONF_RADAR,
    CONF_RECONNECT_GRACE,
    CONF_TARGETS,
    CONF_UNIT,
    CONF_ZONES,
    DEFAULT_MAX_DISTANCE_MM,
    FOV_HALF_ANGLE_DEG,
    SUBENTRY_RADAR,
    SUBENTRY_ZONE,
)
from .discovery import async_resolve_units
from .engine import (
    COALESCE_S,
    KIND_EXCLUDE,
    KIND_EXIT,
    KIND_INCLUDE,
    EngineSnapshot,
    Frame,
    FrameAssembler,
    Target,
    TargetEntities,
    Zone,
    ZoneEngine,
    point_in_polygon,
)
from .engine.align import AlignmentGroup, Affine, alignment_groups, apply, invert, mul, transform_polygon
from .engine.tracker import Observation, Tracker
from .engine.zones import KIND_LINGER, KIND_TRANSIENT

_LOGGER = logging.getLogger(__name__)

DOOR_WINDOW_S = 30.0  # a passage through an exit with a door counts if the door moved this close to it


@dataclass(frozen=True, slots=True)
class RadarView:
    """What the panel shows for one radar: its raw frame plus its share of the group's result."""

    frame: Frame
    kept: tuple[Target, ...]
    excluded_count: int
    suppressed: bool
    zones: EngineSnapshot
    fresh: bool  # False: only the zone states changed (another radar of the group, or a delay)


FrameListener = Callable[[RadarView], None]


class RadarFeed:
    """One radar: assembles frames and applies its exclusions and reconnect grace."""

    def __init__(self, sub: ConfigSubentry, grace_s: float) -> None:
        data = sub.data
        self.id = sub.subentry_id
        self.title = sub.title
        self.device_id: str = data[CONF_DEVICE_ID]
        self.unit_fallback: str | None = data.get(CONF_UNIT)
        self.display: dict[str, Any] = dict(data.get(CONF_DISPLAY) or {})
        self.headcount: bool = bool(data.get(CONF_HEADCOUNT, True))
        self.targets = [TargetEntities(t["slot"], t["x"], t["y"]) for t in data[CONF_TARGETS]]
        self.units: dict[str, str | None] = {}
        self.assembler = FrameAssembler(self.targets, units=self.units)
        self.zones = [Zone.from_dict(z) for z in data.get(CONF_ZONES, [])]
        self.exclude = [z for z in self.zones if z.kind == KIND_EXCLUDE]
        self.exits = [z for z in self.zones if z.kind == KIND_EXIT]
        self.spots = [z for z in self.zones if z.kind in (KIND_LINGER, KIND_TRANSIENT)]
        self.grace_s = grace_s
        self.last_frame: Frame | None = None
        self.kept: tuple[Target, ...] = ()
        self.excluded_count = 0
        self.suppressed = False
        self._available = True
        self._grace_until = -math.inf
        self.flush_unsub: CALLBACK_TYPE | None = None

    @property
    def entity_ids(self) -> set[str]:
        return self.assembler.entity_ids

    @property
    def available(self) -> bool:
        return self.last_frame is None or self.last_frame.available

    def process(self, frame: Frame) -> None:
        t = frame.t
        if frame.available and not self._available:
            self._grace_until = t + self.grace_s
        self._available = frame.available
        self.last_frame = frame
        self.suppressed = t < self._grace_until
        if self.suppressed:
            self.kept, self.excluded_count = (), 0
            return
        self.kept = tuple(
            tg for tg in frame.targets if not any(point_in_polygon(tg.x, tg.y, z.polygon) for z in self.exclude)
        )
        self.excluded_count = len(frame.targets) - len(self.kept)


@dataclass(frozen=True, slots=True)
class ZoneDef:
    subentry_id: str
    zone: Zone  # polygon in its radar's frame
    radar_id: str


def _fov_covers(polygon: tuple[tuple[float, float], ...], max_distance: float) -> bool:
    """Does any sample of the polygon (vertices, edge midpoints, centroid) fall in the radar's field of view?"""
    pts = list(polygon)
    n = len(polygon)
    pts += [((polygon[i][0] + polygon[i - 1][0]) / 2, (polygon[i][1] + polygon[i - 1][1]) / 2) for i in range(n)]
    pts.append((sum(p[0] for p in polygon) / n, sum(p[1] for p in polygon) / n))
    half = math.radians(FOV_HALF_ANGLE_DEG)
    return any(y > 0 and math.hypot(x, y) <= max_distance and abs(math.atan2(x, y)) <= half for x, y in pts)


class GroupRuntime:
    """Radars aligned to each other, evaluated together in the anchor's frame."""

    def __init__(self, group: AlignmentGroup, feeds: dict[str, RadarFeed], zones: list[ZoneDef]) -> None:
        self.anchor = group.anchor
        self.to_anchor: dict[str, Affine] = dict(group.to_anchor)
        self.feeds = [feeds[rid] for rid in group.members]
        self.zone_defs = {zd.zone.id: zd for zd in zones}
        engine_zones = [
            Zone(zd.zone.id, zd.zone.name, KIND_INCLUDE, transform_polygon(self.to_anchor[zd.radar_id], zd.zone.polygon), zd.zone.filters, zd.zone.area_id)
            for zd in zones
        ]
        self.exits: list[Zone] = []  # id "<radar id>:<exit id>", polygon in the anchor's frame
        for feed in self.feeds:
            a = self.to_anchor[feed.id]
            self.exits += [
                Zone(f"{feed.id}:{z.id}", z.name, KIND_EXIT, transform_polygon(a, z.polygon), door_entity_id=z.door_entity_id)
                for z in feed.exits
            ]
        self.engine = ZoneEngine([*engine_zones, *self.exits], 0.0)
        self._positions: dict[int, tuple[float, float]] = {}  # track id -> position, previous evaluation
        spots = [
            Zone(f"{feed.id}:{z.id}", z.name, z.kind, transform_polygon(self.to_anchor[feed.id], z.polygon))
            for feed in self.feeds
            for z in feed.spots
        ]
        self.tracker = Tracker(spots, [invert(self.to_anchor[f.id]) for f in self.feeds])
        self.snapshot: EngineSnapshot = self.engine.snapshot()
        self.track_radars: dict[int, frozenset[int]] = {}
        self.last_targets: tuple[Target, ...] = ()  # fused tracks, anchor's frame
        self.deadline_unsub: CALLBACK_TYPE | None = None
        self.deadline = 0.0

    def coverage(self, zone_id: str, max_distance: Callable[[str], float]) -> list[str]:
        """Radars of the group whose field of view covers part of the zone, the zone's own radar first."""
        zd = self.zone_defs[zone_id]
        to_zone_radar = self.to_anchor[zd.radar_id]
        out = []
        for feed in self.feeds:
            a = mul(invert(self.to_anchor[feed.id]), to_zone_radar)  # zone radar -> this radar
            if feed.id == zd.radar_id or _fov_covers(transform_polygon(a, zd.zone.polygon), max_distance(feed.id)):
                out.append(feed.id)
        out.sort(key=lambda rid: rid != zd.radar_id)
        return out

    @property
    def available(self) -> bool:
        return any(f.available for f in self.feeds)

    def evaluate(self, t: float) -> list[tuple[str, str]]:
        """Run the engine on the radars' latest targets; return passages [(exit id, "arrived" | "left")]."""
        obs = []
        for k, feed in enumerate(self.feeds):
            a = self.to_anchor[feed.id]
            for tg in feed.kept:
                x, y = apply(a, tg.x, tg.y)
                obs.append(Observation(k, tg.slot, x, y))
        fused = self.tracker.fuse(obs, t)
        self.track_radars = fused.radars
        self.last_targets = fused.targets
        self.snapshot = self.engine.process(Frame(t, fused.targets, self.available, fused.gone, fused.dropped))
        return self._passages(fused.targets, fused.gone, fused.born)

    def _passages(self, targets: tuple[Target, ...], gone: tuple[int, ...], born: tuple[int, ...]) -> list[tuple[str, str]]:
        """Someone new appearing in an exit came in; someone vanishing in one left.

        Merges are neither, and a person re-found where they were lost did not arrive.
        """
        cur = {tg.slot: (tg.x, tg.y) for tg in targets}
        prev, self._positions = self._positions, cur
        if not self.exits:
            return []
        out = []
        for tid, (x, y) in prev.items():
            if tid not in cur and tid not in gone:
                out += [(e.id, "left") for e in self.exits if point_in_polygon(x, y, e.polygon)]
        for tid in born:
            x, y = cur[tid]
            out += [(e.id, "arrived") for e in self.exits if point_in_polygon(x, y, e.polygon)]
        return out

    def next_deadline(self) -> float | None:
        ds = [d for d in (self.engine.next_deadline(), self.tracker.next_deadline()) if d is not None]
        return min(ds) if ds else None

    def advance(self, t: float) -> None:
        """Due deadlines: forget lost people (releasing their holds), apply delays."""
        if dropped := self.tracker.expire(t):
            self.engine.release(t, dropped)
        self.engine.advance(t)
        self.snapshot = self.engine.snapshot()

    def seen_by(self, zone_id: str) -> set[str]:
        """Radars currently seeing someone inside the zone."""
        zs = self.snapshot.zones.get(zone_id)
        if zs is None:
            return set()
        return {self.feeds[k].id for slot in zs.slots for k in self.track_radars.get(slot, ())}


class HomeRuntime:
    """Owns every radar feed and group engine of the home config entry."""

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        self.hass = hass
        self.entry = entry
        grace = float(entry.options.get(CONF_RECONNECT_GRACE, 0) or 0)
        self.feeds: dict[str, RadarFeed] = {
            sid: RadarFeed(sub, grace) for sid, sub in entry.subentries.items() if sub.subentry_type == SUBENTRY_RADAR
        }
        self.zones: dict[str, ZoneDef] = {}
        for sid, sub in entry.subentries.items():
            if sub.subentry_type != SUBENTRY_ZONE:
                continue
            radar_id = sub.data.get(CONF_RADAR)
            if radar_id not in self.feeds:
                _LOGGER.warning("Zone %s belongs to a radar that is no longer configured", sub.title)
                continue
            zone = Zone.from_dict({**sub.data, "kind": KIND_INCLUDE})
            self.zones[zone.id] = ZoneDef(sid, zone, radar_id)

        self.groups: list[GroupRuntime] = []
        self.group_of: dict[str, GroupRuntime] = {}  # radar id -> group
        for g in alignment_groups({rid: f.display.get("aligned_to") for rid, f in self.feeds.items()}):
            members = set(g.members)
            group = GroupRuntime(g, self.feeds, [zd for zd in self.zones.values() if zd.radar_id in members])
            self.groups.append(group)
            for rid in members:
                self.group_of[rid] = group
        self._feed_of_entity = {eid: f for f in self.feeds.values() for eid in f.entity_ids}
        self._max_distance: dict[str, float] = {}
        from .headcount_runtime import HeadCountRuntime  # (imports home for typing only)

        self.headcount = HeadCountRuntime(hass, self)

        self._entity_listeners: dict[int, list[CALLBACK_TYPE]] = {}  # id(group) -> callbacks
        self._frame_listeners: dict[str, list[FrameListener]] = {}  # radar id -> callbacks
        self._close_listeners: list[CALLBACK_TYPE] = []
        self._passage_listeners: dict[str, list[Callable[[str, dict[str, Any]], None]]] = {}
        self._pending_passages: list[tuple[str, str, float, str]] = []
        self._door_unsubs: dict[str, CALLBACK_TYPE] = {}
        self._unsubs: list[CALLBACK_TYPE] = []
        self.reload_scheduled = False

    # ------------------------------------------------------------- lookups

    def zone_group(self, zone_id: str) -> GroupRuntime:
        return self.group_of[self.zones[zone_id].radar_id]

    def set_max_distance(self, radar_id: str, mm: float) -> None:
        self._max_distance[radar_id] = mm

    def max_distance(self, radar_id: str) -> float:
        return self._max_distance.get(radar_id, DEFAULT_MAX_DISTANCE_MM)

    def coverage(self, zone_id: str) -> list[str]:
        return self.zone_group(zone_id).coverage(zone_id, lambda rid: self._max_distance.get(rid, DEFAULT_MAX_DISTANCE_MM))

    def radar_view(self, radar_id: str, fresh: bool = True) -> RadarView | None:
        feed = self.feeds[radar_id]
        if feed.last_frame is None:
            return None
        return RadarView(feed.last_frame, feed.kept, feed.excluded_count, feed.suppressed, self.group_of[radar_id].snapshot, fresh)

    # ------------------------------------------------------------ lifecycle

    @callback
    def async_start(self) -> None:
        now = time.time()
        for feed in self.feeds.values():
            feed.units.update(async_resolve_units(self.hass, feed.entity_ids, feed.unit_fallback))
            for entity_id in feed.entity_ids:
                if (state := self.hass.states.get(entity_id)) is not None:
                    feed.assembler.seed(entity_id, state.state)
            feed.process(feed.assembler.build_at(now))
        for group in self.groups:
            group.evaluate(now)  # the targets already in view at start-up are not passages
            self._schedule_deadline(group)
        if self._feed_of_entity:
            self._unsubs.append(
                async_track_state_change_event(self.hass, list(self._feed_of_entity), self._on_state)
            )

    @callback
    def async_stop(self) -> None:
        self.headcount.async_stop()
        for unsub in (*self._unsubs, *self._door_unsubs.values()):
            unsub()
        self._unsubs.clear()
        self._door_unsubs.clear()
        for feed in self.feeds.values():
            if feed.flush_unsub:
                feed.flush_unsub()
                feed.flush_unsub = None
        for group in self.groups:
            if group.deadline_unsub:
                group.deadline_unsub()
                group.deadline_unsub = None
        for cb in list(self._close_listeners):
            cb()
        self._close_listeners.clear()
        self._frame_listeners.clear()

    # ------------------------------------------------------------ listeners

    @callback
    def async_add_entity_listener(self, group: GroupRuntime, cb: CALLBACK_TYPE) -> CALLBACK_TYPE:
        cbs = self._entity_listeners.setdefault(id(group), [])
        cbs.append(cb)
        return lambda: cbs.remove(cb)

    @callback
    def async_add_frame_listener(self, radar_id: str, cb: FrameListener) -> CALLBACK_TYPE:
        cbs = self._frame_listeners.setdefault(radar_id, [])
        cbs.append(cb)

        def remove() -> None:
            if cb in cbs:
                cbs.remove(cb)

        return remove

    @callback
    def async_add_close_listener(self, cb: CALLBACK_TYPE) -> CALLBACK_TYPE:
        self._close_listeners.append(cb)

        def remove() -> None:
            if cb in self._close_listeners:
                self._close_listeners.remove(cb)

        return remove

    # ------------------------------------------------------------- passages

    @callback
    def async_add_passage_listener(self, exit_id: str, cb: Callable[[str, dict[str, Any]], None]) -> CALLBACK_TYPE:
        """exit id is "<radar id>:<exit zone id>"; cb(kind, attributes)."""
        cbs = self._passage_listeners.setdefault(exit_id, [])
        cbs.append(cb)
        return lambda: cbs.remove(cb)

    @callback
    def _passage(self, group: GroupRuntime, exit_id: str, kind: str, t: float) -> None:
        """With a door sensor, a passage only counts if the door moved around it."""
        exit_zone = next(e for e in group.exits if e.id == exit_id)
        door = exit_zone.door_entity_id
        if door is None:
            self._fire_passage(exit_id, kind, {})
            return
        state = self.hass.states.get(door)
        if state is not None and abs(state.last_changed_timestamp - t) <= DOOR_WINDOW_S:
            self._fire_passage(exit_id, kind, {"door_entity_id": door})
            return
        # The door may still open or close (people often vanish before it shuts).
        self._pending_passages = [p for p in self._pending_passages if t - p[2] <= DOOR_WINDOW_S]
        self._pending_passages.append((exit_id, kind, t, door))
        if door not in self._door_unsubs:
            self._door_unsubs[door] = async_track_state_change_event(self.hass, [door], self._on_door)

    @callback
    def _on_door(self, event: Event[EventStateChangedData]) -> None:
        door = event.data["entity_id"]
        now = time.time()
        for pending in [p for p in self._pending_passages if p[3] == door and now - p[2] <= DOOR_WINDOW_S]:
            self._pending_passages.remove(pending)
            self._fire_passage(pending[0], pending[1], {"door_entity_id": door})

    @callback
    def _fire_passage(self, exit_id: str, kind: str, attrs: dict[str, Any]) -> None:
        for cb in list(self._passage_listeners.get(exit_id, ())):
            cb(kind, attrs)

    # -------------------------------------------------------------- updates

    @callback
    def _on_state(self, event: Event[EventStateChangedData]) -> None:
        entity_id = event.data["entity_id"]
        feed = self._feed_of_entity.get(entity_id)
        if feed is None:
            return
        new = event.data["new_state"]
        if new is None:
            opened = feed.assembler.update(entity_id, None, time.time())
        else:
            unit = new.attributes.get(ATTR_UNIT_OF_MEASUREMENT)
            if unit is not None and unit != feed.units.get(entity_id):
                feed.units[entity_id] = unit
                feed.units.update(async_resolve_units(self.hass, feed.entity_ids, feed.unit_fallback))
            opened = feed.assembler.update(entity_id, new.state, new.last_updated_timestamp)
        if opened:

            @callback
            def flush(_now: Any) -> None:
                self._flush(feed)

            feed.flush_unsub = async_call_later(self.hass, COALESCE_S, flush)

    @callback
    def _flush(self, feed: RadarFeed) -> None:
        feed.flush_unsub = None
        frame = feed.assembler.build()
        feed.process(frame)
        group = self.group_of[feed.id]
        for exit_id, kind in group.evaluate(frame.t):
            self._passage(group, exit_id, kind, frame.t)
        self.headcount.frame(group, frame.t)
        self._publish(group, feed)
        self._schedule_deadline(group)

    @callback
    def _schedule_deadline(self, group: GroupRuntime) -> None:
        if group.deadline_unsub:
            group.deadline_unsub()
            group.deadline_unsub = None
        deadline = group.next_deadline()
        if deadline is None:
            return
        group.deadline = deadline

        @callback
        def fire(_now: Any) -> None:
            group.deadline_unsub = None
            # The timer fired, so the deadline is due even if the clocks disagree slightly.
            group.advance(max(time.time(), group.deadline))
            self._publish(group)
            self._schedule_deadline(group)

        group.deadline_unsub = async_call_later(self.hass, max(0.0, deadline - time.time()), fire)

    @callback
    def _publish(self, group: GroupRuntime, source: RadarFeed | None = None) -> None:
        for cb in list(self._entity_listeners.get(id(group), ())):
            cb()
        for feed in group.feeds:
            cbs = self._frame_listeners.get(feed.id)
            if not cbs:
                continue
            view = self.radar_view(feed.id, fresh=feed is source)
            if view is None:
                continue
            for fl in list(cbs):
                try:
                    fl(view)
                except Exception:  # a broken websocket subscriber must not stop the engine
                    _LOGGER.exception("frame listener failed")
