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

import copy
import logging
import math
import re
import time
from dataclasses import dataclass
from datetime import timedelta
from functools import partial
from collections.abc import Callable
from typing import TYPE_CHECKING, Any

from homeassistant.core import CALLBACK_TYPE, Event, EventStateChangedData, HomeAssistant, callback
from homeassistant.helpers import area_registry as ar, device_registry as dr, entity_registry as er, floor_registry as fr
from homeassistant.helpers.event import async_call_later, async_track_state_change_event, async_track_time_interval
from homeassistant.helpers.storage import Store
from homeassistant.util import dt as dt_util

from .const import CONF_EVIDENCE, CONF_EVIDENCE_ON, CONF_OCCUPANCY, CONF_OUTSIDE_DOORS, CONF_VACUUMS, DOMAIN, OUTSIDE
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
CONTACT_MIN_S = 2.0  # a door contact must stay open this long to count (a magnet at the edge of its range flickers)
OCCUPANCY_STEADY_S = 10.0  # an occupancy sensor's region counts as held / free once it has stayed so this long
EVENT_FRESH_S = 30.0  # a button press (event entity) counts only if its time is this recent  # who a radar sees, logged at most this often
BOOTSTRAP_S = 3600.0  # without saved counts, people seen in the first hour count without a door
COVER_MARGIN_MM = 500.0  # another radar "looks" at a spot this far inside its view
OPEN_STATES = {"on", "open", "opening", "closing"}
VACUUM_ACTIVE = {"cleaning", "returning"}
HOLD_MAX_S = 300.0  # a robot vacuum that has not said where it is cleaning by then: replay without knowing


def _room_key(name: str) -> str:
    """A vacuum's room name against an area name: letters and digits only ("Guest’s Room", "living room")."""
    return re.sub(r"[\W_]+", "", name.casefold())


@dataclass
class _Hold:
    """A robot vacuum started without saying where: the head count as it was, and everything fed to it since, to
    replay once its room is known (with that room's radar ignored). Meanwhile new tracks wait."""

    hc: HeadCount
    log_len: int
    logged: int
    started: float
    calls: list[tuple[str, tuple]]


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
        self.space_radars: dict[str, list[str]] = {}  # region id -> radars that see it (its own first), for the panel
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
        self._door_kind: dict[str, str] = {}  # entity -> "door" | "lock" | "door_lock"
        self._lock_of: dict[str, str] = {}  # door contact -> the lock on the same device (a smart lock's door sensor)
        self._evidence: dict[str, tuple[str, bool]] = {}  # entity -> (region, only switching on counts)
        self._occupancy: dict[str, str] = {}  # occupancy sensor (a bed sensor) -> its region
        self._occupied: dict[str, tuple[bool, float]] = {}  # region -> (any of its occupancy sensors on, since)
        self._contact_open: dict[str, float] = {}  # door contact -> when it opened (not counted yet)
        self._occupancy_wait: dict[str, tuple[bool, float, str]] = {}  # region -> (on, since, sensor) until steady
        self._vacuums: dict[str, str | None] = {}  # robot vacuum -> its current room sensor
        self._vacuumed: dict[str, str] = {}  # space a robot vacuum is cleaning -> the vacuum: its tracks are it
        self._hold: _Hold | None = None  # one is cleaning, its room not known yet
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

    def _pair_locks(self) -> None:
        """A door contact with a lock on the same device (a smart lock's door sensor): when it is locked the door
        is closed, whatever the contact says (one stayed "open" all night after the door was locked)."""
        ents = er.async_get(self.hass)
        for door, kind in list(self._door_kind.items()):
            if kind != "door" or (ent := ents.async_get(door)) is None or not ent.device_id:
                continue
            locks = [e.entity_id for e in er.async_entries_for_device(ents, ent.device_id) if e.domain == "lock"]
            if len(locks) == 1:
                self._lock_of[door] = locks[0]
                # Also listed as an outside door itself: the door's contact says when it is used; the lock only says
                # it is closed (its pulses would put the floor in doubt every time it is locked or unlocked).
                self._door_kind[locks[0]] = "door_lock"

    def _locked(self, door: str) -> bool:
        lock = self._lock_of.get(door)
        return lock is not None and (st := self.hass.states.get(lock)) is not None and st.state == "locked"

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
            for area_id, rid in region_of_area.items():
                own = [f for f, a in feed_area.items() if a == area_id]
                zoned = [zd.radar_id for zd in group.zone_defs.values()
                         if zd.radar_id in feed_area and (zd.zone.area_id or feed_area[zd.radar_id]) == area_id]
                self.space_radars[rid] = list(dict.fromkeys(own + zoned)) or list(feed_area)
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
        for entity_id in home.entry.options.get(CONF_OCCUPANCY, []) or []:
            area_id = self._entity_area(entity_id)
            if area_id is None or (region_id := area_region.get(area_id)) is None:
                _LOGGER.warning("Head count: %s is not in an area of the head count, ignored", entity_id)
                continue
            self._occupancy[entity_id] = region_id
        ents = er.async_get(self.hass)
        for vac in home.entry.options.get(CONF_VACUUMS, []) or []:
            ent = ents.async_get(vac)
            rooms = [
                e.entity_id for e in (er.async_entries_for_device(ents, ent.device_id) if ent and ent.device_id else [])
                if e.domain == "sensor" and (e.translation_key == "current_room" or e.entity_id.endswith("_current_room"))
            ]
            self._vacuums[vac] = rooms[0] if rooms else None
            if not rooms:
                _LOGGER.warning("Head count: robot vacuum %s reports no current room; its tracks cannot be ignored", vac)
        for region_id, doors in exits.items():
            for d in doors:
                self._door_kind.setdefault(d, "lock" if d.startswith("lock.") else "door")
        for _a, _b, door in links:
            if door:
                self._door_kind.setdefault(door, "door")
        self._pair_locks()

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
                if kind == "door" and state is not None and state.state in OPEN_STATES and not self._locked(entity_id):
                    self._hc("door", entity_id, True, now)
        if self._evidence:
            self._unsubs.append(async_track_state_change_event(self.hass, list(self._evidence), self._on_evidence))
        if self._occupancy:
            self._unsubs.append(async_track_state_change_event(self.hass, list(self._occupancy), self._on_occupancy))
            now = time.time()
            for region in dict.fromkeys(self._occupancy.values()):
                if self._region_occupied(region):  # held already: anchor whoever is believed there, move nobody
                    self._occupied[region] = (True, now)
                    self._hc("hold", region, True, now, "occupied at start", False)
        if watch := [e for pair in self._vacuums.items() for e in pair if e]:
            self._unsubs.append(async_track_state_change_event(self.hass, watch, self._on_vacuum))
            self._update_vacuumed(time.time())
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
            self._hc("frame", {next(iter(region_of_area.values())): tracks}, t, unconfirmed)
        else:
            self._hc("frame_group", {region_of_area[a]: part for a, part in rooms.split(tracks).items()}, t, unconfirmed)
        self._changed()

    def _hc(self, name: str, *args: Any, replay: bool = False) -> None:
        """Feed the head count. Tracks in a room a robot vacuum is cleaning are left out; while it has not said
        where yet, every input is kept to replay and new tracks wait (unconfirmed)."""
        assert self.hc is not None
        if self._hold is not None and not replay:
            self._hold.calls.append((name, args))
        if name in ("frame", "frame_group"):
            parts, t, unconfirmed = args
            if self._hold is not None and not replay:
                unconfirmed = {tid for part in parts.values() for tid in part}
            parts = {r: {} if r in self._vacuumed else part for r, part in parts.items()}
            if name == "frame":
                ((region, tracks),) = parts.items()
                self.hc.frame(region, tracks, t, unconfirmed)
            else:
                self.hc.frame_group(parts, t, unconfirmed)
            return
        getattr(self.hc, name)(*args)

    def _end_hold(self, t: float) -> None:
        """Back to the head count as it was when the vacuum started; replay what came since, now knowing its room."""
        hold, self._hold = self._hold, None
        if hold is None:
            return
        signals = [e for e in self.log[hold.log_len :] if e["kind"] in ("door", "signal", "ignored")]
        del self.log[hold.log_len :]
        self.log += signals
        self.hc, self._logged = hold.hc, hold.logged
        for name, args in hold.calls:
            self._hc(name, *args, replay=True)
        self._log_changes()
        self.log[hold.log_len :] = sorted(self.log[hold.log_len :], key=lambda e: e["t"])
        self._log_signal(t, "signal", next(iter(self._vacuums)), f"replayed {len(hold.calls)} updates since it started")
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
        kind = self._door_kind.get(entity_id)
        if new.state == "locked":  # the door it locks is closed
            for door, lock in self._lock_of.items():
                if lock == entity_id and (seen := self.hc._door_seen.get(door)) is not None and seen[0]:
                    self._log_signal(t, "door", door, "off (locked)")
                    self._hc("door", door, False, t)
                    self._changed()
        elif old is not None and old.state == "locked":  # unlocked: the contact counts again (it may say open already)
            for door, lock in self._lock_of.items():
                if (lock == entity_id and (st := self.hass.states.get(door)) is not None and st.state in OPEN_STATES
                        and not self.hc._door_seen.get(door, (False,))[0]):
                    self._log_signal(t, "door", door, f"{st.state} (unlocked)")
                    self._hc("door", door, True, t)
                    self._changed()
        if kind == "door_lock":
            return
        if kind == "door" and new.state in OPEN_STATES and self._locked(entity_id):
            self._log_signal(t, "ignored", entity_id, f"{new.state}: the door is locked, so it is closed")
            return
        self._log_signal(t, "door", entity_id, new.state)
        if kind == "lock":
            if old is not None and old.state != new.state and old.state not in ("unavailable", "unknown"):
                self._hc("pulse", entity_id, t)
        else:
            self._hc("door", entity_id, new.state in OPEN_STATES, t)
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
        if entity_id.startswith("binary_sensor."):
            # Door contacts: an opening counts once it has lasted CONTACT_MIN_S; shorter ones are the sensor flickering.
            if new.state == "on":
                self._contact_open[entity_id] = t
                async_call_later(self.hass, CONTACT_MIN_S, partial(self._contact_held, entity_id, t))
                return
            opened = self._contact_open.pop(entity_id, None)
            if opened is not None and t - opened < CONTACT_MIN_S:
                self._log_signal(t, "ignored", entity_id, f"open {t - opened:.1f} s only: the sensor flickering")
                return
        self._log_signal(t, "signal", entity_id, new.state, region)
        # Switched off (a light on the way out): confirms who is there, moves nobody in. Contacts and buttons: both.
        off = new.state == "off" and entity_id.split(".")[0] in ("light", "switch", "fan", "input_boolean")
        self._hc("evidence", region, new.last_changed_timestamp, entity_id, not off)
        self._changed()

    def _region_occupied(self, region: str) -> bool:
        return any(
            (st := self.hass.states.get(e)) is not None and st.state == "on" for e, r in self._occupancy.items() if r == region
        )

    @callback
    def _on_occupancy(self, event: Event[EventStateChangedData]) -> None:
        """An occupancy sensor (a bed sensor) changed: its region is held while any of its sensors is on, once that
        has lasted OCCUPANCY_STEADY_S (someone turning over, a sensor bouncing)."""
        if self.hc is None:
            return
        entity_id = event.data["entity_id"]
        new = event.data["new_state"]
        if new is None or new.state in ("unavailable", "unknown"):
            return
        region = self._occupancy[entity_id]
        on = self._region_occupied(region)
        if self._occupied.get(region, (False, 0.0))[0] == on and region not in self._occupancy_wait:
            return
        t = new.last_changed_timestamp
        self._occupancy_wait[region] = (on, t, entity_id)
        async_call_later(self.hass, OCCUPANCY_STEADY_S, partial(self._occupancy_steady, region, t))

    @callback
    def _occupancy_steady(self, region: str, t: float, _now: Any) -> None:
        if self.hc is None or (wait := self._occupancy_wait.get(region)) is None or wait[1] != t:
            return
        del self._occupancy_wait[region]
        on, _t, entity_id = wait
        if self._occupied.get(region, (False, 0.0))[0] == on:
            return  # back as it was (a bounce)
        self._occupied[region] = (on, t)
        self._log_signal(t, "signal", entity_id, "on: someone is there while it stays on" if on else "off: they got up", region)
        self._hc("hold", region, on, t, entity_id)
        self._changed()

    @callback
    def _on_vacuum(self, event: Event[EventStateChangedData]) -> None:
        if self.hc is not None and (new := event.data["new_state"]) is not None:
            self._update_vacuumed(new.last_changed_timestamp)

    def _update_vacuumed(self, t: float) -> None:
        """The spaces of the rooms the robot vacuums are cleaning (their room sensor's state is an area name)."""
        by: dict[str, str] = {}  # room name -> the vacuum cleaning it
        unsure = False
        for vac, room in self._vacuums.items():
            st = self.hass.states.get(vac)
            if st is None or st.state not in VACUUM_ACTIVE:
                continue
            rs = self.hass.states.get(room) if room else None
            if rs is None or rs.state in ("unknown", "unavailable", ""):
                unsure = True  # (it reports its room a minute or two after it starts)
            else:
                by[_room_key(rs.state)] = vac
        if unsure and self._hold is None:
            self._log_signal(t, "signal", next(iter(self._vacuums)), "cleaning, room not known yet: new tracks wait")
            self._hold = _Hold(copy.deepcopy(self.hc), len(self.log), self._logged, t, [])
        vacuumed = {sid: by[_room_key(sp.name)] for sid, sp in self.spaces.items() if _room_key(sp.name) in by}
        if vacuumed != self._vacuumed:
            for sid in vacuumed.keys() - self._vacuumed.keys():
                self._log_signal(t, "signal", vacuumed[sid], "cleaning here: this radar is ignored", sid)
            for sid in self._vacuumed.keys() - vacuumed.keys():
                self._log_signal(t, "signal", self._vacuumed[sid], "done: this radar counts again", sid)
            self._vacuumed = vacuumed
            self._changed()
        if not unsure and self._hold is not None:
            self._end_hold(t)

    @callback
    def _contact_held(self, entity_id: str, opened: float, _now: Any) -> None:
        """A door contact still open CONTACT_MIN_S after opening: someone opened it (at the time it opened)."""
        if self.hc is None or self._contact_open.get(entity_id) != opened:
            return
        region, _on_only = self._evidence[entity_id]
        self._log_signal(opened, "signal", entity_id, "on", region)
        self._hc("evidence", region, opened, entity_id)
        self._changed()

    @callback
    def _tick(self, _now: Any) -> None:
        if self.hc is None:
            return
        now = time.time()
        if self._hold is not None and now - self._hold.started > HOLD_MAX_S:
            self._end_hold(now)
        self._hc("advance", now)
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
            "occupancy": dict(self._occupancy),
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
        self._end_hold(now)
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
        self._end_hold(time.time())
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
                 "radars": self.space_radars.get(sp.id, []),
                 "portals": [{"name": p.name, "to": list(p.to)} for p in hc.regions[sp.id].portals]}
                for sp in self.spaces.values()
            ],
            "connections": [[a, b, d] for a, links in hc._links.items() for b, d in links if a < b],
            "tokens": [
                {"id": tok.id, "region": tok.region, "last_seen": tok.last_seen, "reason": tok.reason,
                 "visible": tok.visible is not None, "unknown": tok.unknown, "provisional": tok.provisional,
                 "anchored": hc._anchored(tok)}
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
