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
from collections.abc import Callable
from typing import TYPE_CHECKING, Any

from homeassistant.core import CALLBACK_TYPE, Event, EventStateChangedData, HomeAssistant, callback
from homeassistant.helpers import area_registry as ar, device_registry as dr, entity_registry as er, floor_registry as fr
from homeassistant.helpers.event import async_track_state_change_event, async_track_time_interval
from homeassistant.helpers.storage import Store
from homeassistant.util import dt as dt_util

from .const import CONF_EVIDENCE, CONF_EVIDENCE_ON, CONF_OUTSIDE_DOORS, DOMAIN, OUTSIDE
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
LOG_KEEP_S = 3 * 86400.0  # the decision log the panel's head count view replays
LOG_SAVE_DELAY_S = 120
SEEN_EVERY_S = 15.0
EVENT_FRESH_S = 30.0  # a button press (event entity) counts only if its time is this recent  # who a radar sees, logged at most this often
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
        # Decision log: every head count change, door and evidence signal, each with who is where after it.
        self.log: list[dict[str, Any]] = []
        self._log_store: Store[dict[str, Any]] = Store(hass, STORE_VERSION, f"{DOMAIN}.headcount_log.{home.entry.entry_id}")
        self._log_listeners: list[Callable[[list[dict[str, Any]]], None]] = []
        self._logged = 0  # hc.changes already in the log
        self._seen_logged: tuple = ()
        self._seen_at = 0.0
        self.hc: HeadCount | None = None
        self._door_kind: dict[str, str] = {}  # entity -> "door" | "lock"
        self._evidence: dict[str, tuple[str, bool]] = {}  # entity -> (region, only switching on counts)
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
        by_area: dict[str, list[str]] = {}
        for sid, sp in self.spaces.items():
            by_area.setdefault(sp.area_id, []).append(sid)
        for ids in by_area.values():  # one room seen by two radar groups: the same room
            links.update((a, b, None) for i, a in enumerate(ids) for b in ids[i + 1 :])
        for entity_id in home.entry.options.get(CONF_OUTSIDE_DOORS, []) or []:
            area_id = self._entity_area(entity_id)
            if area_id is None or (region_id := region_for(area_id)) is None:
                _LOGGER.warning("Head count: outside door %s has no area, ignored", entity_id)
                continue
            exits.setdefault(region_id, []).append(entity_id)
            self._door_kind[entity_id] = "lock" if entity_id.startswith("lock.") else "door"
        for key, on_only in ((CONF_EVIDENCE, False), (CONF_EVIDENCE_ON, True)):
            for entity_id in home.entry.options.get(key, []) or []:
                area_id = self._entity_area(entity_id)
                if area_id is None or (region_id := area_region.get(area_id)) is None:
                    _LOGGER.warning("Head count: %s is not in an area of the head count, ignored", entity_id)
                    continue
                self._evidence[entity_id] = (region_id, on_only)
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
        if (saved_log := await self._log_store.async_load()) and isinstance(saved_log.get("log"), list):
            cutoff = time.time() - LOG_KEEP_S
            self.log = [e for e in saved_log["log"] if isinstance(e, dict) and e.get("t", 0) >= cutoff]
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
        if self._evidence:
            self._unsubs.append(async_track_state_change_event(self.hass, list(self._evidence), self._on_evidence))
        self._unsubs.append(async_track_time_interval(self.hass, self._tick, timedelta(seconds=TICK_S)))
        self._changed()

    @callback
    def async_stop(self) -> None:
        for unsub in self._unsubs:
            unsub()
        self._unsubs.clear()
        if self.hc is not None:
            self._log_changes()  # what happened since the last update, before the log is saved
            self._store.async_delay_save(self._data, 0)
            self._log_store.async_delay_save(self._log_data, 0)

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
        self._log_signal(t, "door", entity_id, new.state)
        if self._door_kind.get(entity_id) == "lock":
            if old is not None and old.state != new.state and old.state not in ("unavailable", "unknown"):
                self.hc.pulse(entity_id, t)
        else:
            self.hc.door(entity_id, new.state in OPEN_STATES, t)
        self._changed()

    @callback
    def _on_evidence(self, event: Event[EventStateChangedData]) -> None:
        """A switch or contact used by hand: someone is in its area. Changes by automations, scripts or the
        app carry a parent or a user in their context and do not count."""
        if self.hc is None:
            return
        entity_id = event.data["entity_id"]
        new, old = event.data["new_state"], event.data["old_state"]
        if new is None or new.state in ("unavailable", "unknown"):
            return
        if entity_id.startswith("event."):
            # Its state is the time of the press. At start-up it restores the last one: only fresh presses count.
            pressed = dt_util.parse_datetime(new.state)
            if pressed is None or abs(time.time() - pressed.timestamp()) > EVENT_FRESH_S:
                return
        elif old is None or old.state in ("unavailable", "unknown") or old.state == new.state:
            return
        t = new.last_changed_timestamp
        if new.context.parent_id is not None or new.context.user_id is not None:
            self._log_signal(t, "ignored", entity_id, f"{new.state}: by an automation or script" if new.context.parent_id else f"{new.state}: from the app")
            return
        region, on_only = self._evidence[entity_id]
        if on_only and new.state != "on":
            self._log_signal(t, "ignored", entity_id, f"{new.state}: only switching on counts (a timer may turn it off)")
            return
        self._log_signal(t, "signal", entity_id, new.state, region)
        # Switched off (a light on the way out): confirms who is there, moves nobody in. Contacts and buttons: both.
        off = new.state == "off" and entity_id.split(".")[0] in ("light", "switch", "fan", "input_boolean")
        self.hc.evidence(region, new.last_changed_timestamp, entity_id, move=not off)
        self._changed()

    @callback
    def _tick(self, _now: Any) -> None:
        if self.hc is None:
            return
        now = time.time()
        self.hc.advance(now)
        self._changed()
        seen = tuple(sorted(tok.id for tok in self.hc.tokens.values() if tok.visible is not None))
        if seen != self._seen_logged and now - self._seen_at >= SEEN_EVERY_S:
            self._seen_logged, self._seen_at = seen, now
            self._append([{"t": now, "kind": "seen", **self._snapshot()}])

    # --------------------------------------------------------------- output

    def _data(self) -> dict[str, Any]:
        assert self.hc is not None
        return {"regions": self.hc.by_region()}

    @callback
    def _changed(self) -> None:
        if self.hc is None:
            return
        self._log_changes()
        if len(self.hc.changes) > 500:  # the panel's log keeps the history
            trimmed = len(self.hc.changes) - 200
            del self.hc.changes[:trimmed]
            self._logged = max(0, self._logged - trimmed)
        state = (self.hc.count(), tuple(sorted(self.hc.by_region().items())), tuple(sorted(self.hc.unknown_floors())))
        if state == self._last:
            return
        self._last = state
        if not self.hc.unknown():
            self._store.async_delay_save(self._data, SAVE_DELAY_S)
        for cb in list(self._listeners):
            cb()

    # ------------------------------------------------------------------ log

    def _snapshot(self) -> dict[str, Any]:
        assert self.hc is not None
        tokens = [
            [tok.id, tok.region, ("v" if tok.visible is not None else "") + ("u" if tok.unknown else "") + ("p" if tok.provisional else "")]
            for tok in self.hc.tokens.values()
        ]
        return {"tokens": tokens, "unknown_floors": sorted(self.hc.unknown_floors())}

    def _log_changes(self) -> None:
        assert self.hc is not None
        new = self.hc.changes[self._logged :]
        if not new:
            return
        self._logged = len(self.hc.changes)
        snap = self._snapshot()
        self._append([{"t": c.t, "kind": c.kind, "token": c.token, "region": c.region, "detail": c.detail, **snap} for c in new])

    def _log_signal(self, t: float, kind: str, entity_id: str, detail: str, region: str | None = None) -> None:
        if self.hc is None:
            return
        self._log_changes()  # what happened before it, first
        self._append([{"t": t, "kind": kind, "entity": entity_id, "region": region, "detail": detail, **self._snapshot()}])

    def _append(self, entries: list[dict[str, Any]]) -> None:
        self.log += entries
        cutoff = time.time() - LOG_KEEP_S
        if self.log and self.log[0]["t"] < cutoff - 3600:
            self.log = [e for e in self.log if e["t"] >= cutoff]
        self._log_store.async_delay_save(self._log_data, LOG_SAVE_DELAY_S)
        for cb in list(self._log_listeners):
            cb(entries)

    def _log_data(self) -> dict[str, Any]:
        return {"log": self.log}

    @callback
    def async_add_log_listener(self, cb: Callable[[list[dict[str, Any]]], None]) -> CALLBACK_TYPE:
        self._log_listeners.append(cb)
        return lambda: self._log_listeners.remove(cb)

    def history(self, start: float, end: float) -> dict[str, Any]:
        """The decision log in [start, end], the state just before it, and the home's layout (for the panel)."""
        layout = self.debug()
        before = next((e for e in reversed(self.log) if e["t"] < start), None)
        return {
            "spaces": layout["spaces"],
            "connections": layout["connections"],
            "floors": [{"level": lv, "floor_id": fid, "name": name} for lv, (fid, name) in sorted(self.floors.items())],
            "doors": self._door_spaces(),
            "evidence": {e: [r, on_only] for e, (r, on_only) in self._evidence.items()},
            "before": before,
            "log": [e for e in self.log if start <= e["t"] <= end],
            "now": {"t": time.time(), **self._snapshot()} if self.hc else None,
            "log_start": self.log[0]["t"] if self.log else None,
        }

    def _door_spaces(self) -> dict[str, list[str]]:
        """Door entity -> the spaces it is in (an exit: one; between two spaces: both)."""
        out: dict[str, list[str]] = {}
        if self.hc is None:
            return out
        for e, r in self.hc._door_region.items():
            out.setdefault(e, []).append(r)
        for a, links in self.hc._links.items():
            for b, d in links:
                if d and a < b:
                    out.setdefault(d, []).extend([a, b])
        return out

    def correct(self, space_id: str, n: int) -> None:
        """Someone who knows sets a space's count (a phantom left over, someone missed). Logged as 'corrected'."""
        if self.hc is None or space_id not in self.spaces:
            raise ValueError(f"unknown space {space_id}")
        now = time.time()
        area = self.spaces[space_id].area_id
        for sid, sp in self.spaces.items():  # an area seen by several radar groups: the count goes to this one
            if sp.area_id == area:
                self.hc.correct(sid, n if sid == space_id else 0, now)
        self._changed()
        self._store.async_delay_save(self._data, 0)

    def correct_home(self, n: int) -> None:
        """Someone who knows sets the home count (0: nobody home). Only removes people. Logged as 'corrected'."""
        if self.hc is None:
            raise ValueError("no head count")
        self.hc.correct_home(n, time.time())
        self._changed()
        self._store.async_delay_save(self._data, 0)

    def home_count(self) -> int | None:
        return None if self.hc is None or self.hc.unknown() else self.hc.count()

    def floor_count(self, level: int) -> int | None:
        if self.hc is None or level in self.hc.unknown_floors():
            return None
        return self.hc.by_floor().get(level, 0)

    def space_count(self, region_id: str) -> int | None:
        if self.hc is None or region_id not in self.spaces:
            return None
        sp = self.spaces[region_id]
        if sp.level in self.hc.unknown_floors():
            return None
        counts = self.hc.by_region()
        return sum(counts.get(sid, 0) for sid, other in self.spaces.items() if other.area_id == sp.area_id)

    def area_spaces(self) -> list[str]:
        """One space per area for the sensors (an area seen by several radar groups has several spaces)."""
        return [sid for sid, sp in self.spaces.items() if sid == sp.area_id]

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
        return {
            f"{eid}_people",
            f"{eid}_nobody_home",
            *(f"{eid}_people_floor_{lv}" for lv in self.floors),
            *(f"{eid}_people_{s}" for s in self.area_spaces()),
        }
