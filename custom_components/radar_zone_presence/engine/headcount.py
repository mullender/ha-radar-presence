"""Head count per area, floor and home from conservation of people.

People do not appear or vanish: they come in and leave through the home's
true exits (front door, garage door), and move between floors over the
stairs. Radars lose people who sit or lie still, and rooms without a radar
never see anyone, so counts are kept by *tokens*: one per person believed to
be home, each with the region where they were last seen.

- **Regions** are the areas a group of aligned radars watches (one radar in
  most homes), each on a floor. **Connections** say which regions people walk
  between (the stairs, a door between the hallway and the garage); a link
  with a door can only be crossed while that door is being used.
- **Sightings** come from the regions' trackers (``tracker.Tracker``): a
  track that appears is matched to the unseen token most likely to be it:
  seen most recently, and able to have walked there. A track the tracker
  re-finds keeps its token.
- **Exit windows**: while a true exit door is open, nobody can tell who on
  that floor went out or came in, so the floor's people become *unknown*
  (not counted) from the moment the door opens. The home count is unknown
  until ``SETTLE_S`` after the last exit door on that floor closed; zone
  presence is not affected. Counts are then re-established from evidence
  after the door closed:

  * someone seen on another floor (walked up the stairs) is in;
  * someone still seen on the exit floor ``LAG_S`` after the door closed is in
    (radars lag, and some see a little through doors);
  * someone not re-established within ``REESTABLISH_S`` of the close has left.

  A track that appears on the exit floor during the window is someone coming
  in, unless someone unknown on that floor or someone seen moments ago next to
  it (``RECENT_S``) explains it: a person asleep upstairs does not reappear in
  the hallway without being seen on the way.
- **Doorways** (a region's exit zones, each leading to another region or
  outside): where a track appears or vanishes says who it is. A track that
  appears at the stairs is someone from the region they lead to, however long
  that person sat still; one that appears at the front door is someone coming
  in; one that vanishes at the stairs went there (and, if they were unknown,
  is inside). Without doorways, a new track during an exit window can only be
  someone from another region seen within ``RECENT_S``.
- **Direction from the door order**: an exit out of an unobserved region (the
  garage) is used *out* when the door into it from the house was used just
  before (``DIRECTION_S``) the exit opened (through the garage-entry door,
  press the button, the big door opens), else *in* (the remote in the car opens
  the big door first). Going out, nobody new is counted; coming in, nobody
  inside is put in doubt.
- **Rooms without a radar** behind a doorway (a bedroom): someone vanishing
  in the doorway went in, and comes out through it; a track elsewhere is not
  them unless it lasts ``CONFIRM_S`` and no one else explains it (the radar
  missed them coming out).
- **Door sensors miss events**: a track that passes through a doorway to
  outside and vanishes within ``EXIT_PASS_S`` counts as that door opening
  (a contact that logged nothing while the radar saw someone walk out).
- **Unobserved regions** (no radar, or one that only sees ghosts) are inferred
  from their doors: someone lost next to the door into one while that door was
  used went in; someone new coming out of one shortly after its exit door
  opened has arrived.
- **Reflections**: in a region with overlapping radars, a track seen by one
  radar only, where another radar looks and sees nothing, is a reflection
  (a kitchen radar seeing someone twice): it explains nobody until confirmed.
- **No door, no new person**: a track no one can explain (a split track, a
  reflection, a washer) becomes a person only after ``CONFIRM_S`` apart from
  everyone else (and not while someone is in view in a neighbouring region,
  who may be the same person seen by two radars), and counts once it walks into another region or has been
  seen for ``UNEXPLAINED_SEEN_S``.
- **Occupancy sensors** (a bed sensor) say someone is in their region for as
  long as they are on: one person there is *anchored*, not taken to explain a
  track elsewhere and not put in doubt by an exit door, until the sensor turns
  off. Several sensors in one region (a bed's two sides) mean at least one
  person, never one each.
- Counts are the tokens per region, per floor and in total, so the levels
  always add up.

Pure Python, no Home Assistant imports; time is passed in.
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field

from .geometry import signed_distance

FLOOR_TRAVEL_S = 3.0  # fastest time from one floor to the next
SETTLE_S = 60.0  # the home count is unknown until this long after the exit doors closed
LAG_S = 45.0  # someone still seen on the exit floor this long after the door closed did not leave
REESTABLISH_S = 600.0  # someone unknown not seen again within this long after the door closed has left
RECENT_S = 120.0  # during an exit window, someone from another region explains a new track only if seen this recently
CONFIRM_S = 60.0  # an unexplained extra person must be seen this long to count
BOOTSTRAP_CONFIRM_S = 20.0
SEPARATE_MM = 1500.0  # ... and this far from everyone else in view in the region
CROSS_WINDOW_S = 60.0  # a door between two regions must have been open this recently to cross it
INTO_UNOBSERVED_S = 20.0  # lost this close (before or after) to the door into an unobserved region being used: went in
UNOBSERVED_ARRIVE_S = 600.0  # someone new coming out of an unobserved region this long after its exit door opened
UNEXPLAINED_SEEN_S = 600.0  # someone appearing without a door counts once seen this long (or seen in another region)
UNEXPLAINED_EXPIRE_S = 3600.0  # ... within this long, else it was not a person (a washer, a fan, a reflection)
DIRECTION_S = 90.0  # the door from the house into the garage used this long before its exit opened: going out
EXIT_NEAR_MM = 400.0  # a track that passed this close to a doorway to outside...
EXIT_PASS_S = 10.0  # ... and vanished within this long after: as if that door opened (door sensors miss some)
VIRTUAL_EXITS = True  # ... on/off
ESTABLISH_ON_EXIT_FLOOR = True  # still seen on the exit floor LAG_S after the close re-establishes (else: only other floors)
REFOUND_MM = 2000.0  # ... and is this close to where they vanished
REFOUND_S = 30.0  # a track the tracker re-finds within this long keeps its person
PORTAL_MM = 1200.0  # a track appearing or vanishing this close to a doorway came or went through it
STATIC_S = 90.0  # a track that stays within STATIC_MM of where it appeared this long is a machine (a fan behind a wall)...
STATIC_MM = 400.0  # ... until it moves this far: ignored, and whoever it was given to goes back
SPOT_MM = 500.0  # tracks standing still here add up: a spot with STATIC_S of still tracks (a fan the radar keeps
SPOT_FORGET_S = 6 * 3600.0  # losing and re-finding) makes every track born there static; forgotten this long after
SPOT_APPLY = False  # spots are only suggested (to exclude in the panel): applied automatically they also catch a desk


@dataclass(frozen=True, slots=True)
class Portal:
    """A doorway of a region (an exit zone in the region's coordinates) and where it leads."""

    name: str
    polygon: tuple[tuple[float, float], ...]
    to: tuple[str, ...] = ()  # region ids it leads to (a stairwell may lead up and down); () = outside


@dataclass(frozen=True, slots=True)
class Region:
    id: str
    floor: int  # floor level
    exits: tuple[str, ...] = ()  # true exit doors (entity ids) of this region
    name: str = ""
    observed: bool = True  # False: no (usable) radar, e.g. a garage with a glass door; inferred from its doors
    portals: tuple[Portal, ...] = ()


@dataclass(slots=True)
class Token:
    id: int
    region: str
    last_seen: float
    since: float  # when the token was created
    reason: str  # "arrived", "bootstrap", "unexplained"
    visible: tuple[str, int] | None = None  # (region, track id) while seen
    provisional: bool = False  # unexplained, not yet confirmed as a person
    unknown: bool = False  # on an exit floor while its door was used: maybe left
    unknown_floor: int = 0  # ... the floor of that exit
    seen_s: float = 0.0  # time seen since created
    floor_seen: dict[int, float] = field(default_factory=dict)  # floor -> last time seen there
    seen_region: str = ""  # where last actually seen (region can be a guess: moved unseen)
    pos: tuple[float, float] | None = None  # where last seen (in seen_region's coordinates)
    before: tuple | None = None  # (track, region, seen_region, pos, last_seen, unknown, unknown_floor) before its current track
    origin: tuple[str, int] | None = None  # the track that made this person (arrived / appeared there)


@dataclass(slots=True)
class _Pending:
    region: str
    track: int
    first: float
    portal: Portal | None = None  # the doorway it appeared at


@dataclass(slots=True)
class _Window:
    """A floor whose exit doors are (or were just) in use."""

    floor: int
    opened: float
    open_doors: set[str] = field(default_factory=set)
    closed: float | None = None  # when the last open door closed
    direction: str | None = None  # "out", "in", or None (unknown)


@dataclass(frozen=True, slots=True)
class Change:
    t: float
    kind: str  # "arrived", "left", "moved", "unknown", "back", "unexplained", "confirmed", "not a person", "ghost"
    token: int
    region: str
    detail: str = ""


class HeadCount:
    def __init__(
        self,
        regions: Iterable[Region],
        bootstrap_until: float = float("-inf"),
        connections: Iterable[tuple[str, str, str | None]] = (),
    ) -> None:
        """``connections``: (region, region, door entity or None) links between regions. Given any, people move
        only along them, through doors only while those are used; else between adjacent floors."""
        self.regions = {r.id: r for r in regions}
        self._links: dict[str, list[tuple[str, str | None]]] = {}
        for a, b, door in connections:
            self._links.setdefault(a, []).append((b, door))
            self._links.setdefault(b, []).append((a, door))
        self._door_seen: dict[str, tuple[bool, float]] = {}  # any door -> (open, last change)
        self._door_opened: dict[str, float] = {}  # any door -> last time it opened
        self._door_region = {e: r.id for r in self.regions.values() for e in r.exits}
        self.tokens: dict[int, Token] = {}
        self._binding: dict[tuple[str, int], int] = {}  # (region, track) -> token, kept while the track is lost
        self._visible: dict[str, set[int]] = {r: set() for r in self.regions}
        self._pending: dict[tuple[str, int], _Pending] = {}
        self._pos: dict[str, dict[int, tuple[float, float]]] = {r: {} for r in self.regions}
        self.regions_seen: dict[int, str] = {}  # token -> first region it was seen in
        self._windows: dict[int, _Window] = {}  # floor -> current/last exit window
        self._at_exit: dict[tuple[str, int], tuple[float, str]] = {}
        self._paths: dict[tuple[str, int], list[float]] = {}  # track -> [x0, y0, t0, farthest from (x0, y0)]
        self._static: set[tuple[str, int]] = set()  # tracks that never moved: machines, ignored
        self._spots: dict[str, list[list[float]]] = {}  # region -> [[x, y, still seconds, last time]]
        self._unconfirmed: dict[str, set[int]] = {}  # track -> (last time in an outside doorway, its name)
        self._held: dict[str, int | None] = {}  # region an occupancy sensor holds -> the person anchored there
        self._bootstrap_until = bootstrap_until
        self._next = 1
        self.changes: list[Change] = []

    # ----------------------------------------------------------------- counts

    def _people(self) -> list[Token]:
        return [tok for tok in self.tokens.values() if not tok.provisional and not tok.unknown]

    def count(self) -> int:
        """People known to be home (during an exit window, without those on its floor)."""
        return len(self._people())

    def unknown(self) -> bool:
        """An exit door is in use (or just was): the count is not firm."""
        return bool(self.unknown_floors())

    def unknown_floors(self) -> set[int]:
        """Floors whose exit doors are in use (or just were): their counts (and the home's) are not firm."""
        return {w.floor for w in self._windows.values() if self._unsettled(w.floor, self._now)}

    def seed(self, region: str, n: int, t: float) -> None:
        """Restore people believed to be in a region (after a restart): unseen, as if seen long ago."""
        for _ in range(n):
            tok = self._new(region, t, "restored")
            tok.last_seen = tok.since = t - 86400.0

    def pulse(self, entity_id: str, t: float) -> None:
        """A door activity without open/closed (a lock locked or unlocked): opened and closed at once."""
        self.door(entity_id, True, t)
        self.door(entity_id, False, t)

    def evidence(self, region: str, t: float, why: str = "", move: bool = True) -> None:
        """Someone is in this region now, though no track says so: a switch pressed by hand, a closet door.
        Whoever is believed there stays (and is back, if in doubt); else (``move``) the unseen person who could
        have walked there is moved there. It never adds a person: a switch does not say who. (A light switched
        off is someone on their way out: it confirms who is there, it does not move anyone in.)"""
        if region not in self.regions:
            return
        self._tick(t)
        here = [tok for tok in self.tokens.values() if tok.region == region and not tok.provisional]
        if any(tok.visible is not None for tok in here):
            return  # a radar sees them: nothing to add
        if self._in_doorway_to(region):
            return  # someone in view in its doorway reached for the switch (or stepped in): them
        tok = max(here, key=lambda k: k.last_seen) if here else (self._match(region, t) if move else None)
        if tok is None:
            return
        if tok.region != region:
            self._move_unseen(tok, region, t)
        tok.last_seen = t
        tok.floor_seen[self.regions[region].floor] = t
        self.changes.append(Change(t, "evidence", tok.id, region, why))
        if tok.unknown and self._window_floor(region, t) is None and (
            ESTABLISH_ON_EXIT_FLOOR or self.regions[region].floor != tok.unknown_floor
        ):
            self._establish(tok, t, why or "evidence")

    def hold(self, region: str, on: bool, t: float, why: str = "", move: bool = True) -> None:
        """An occupancy sensor (a bed sensor) in this region turned on or off. On: someone is there for as long as it
        stays on. Like evidence, whoever is believed there stays (or the unseen person who could have walked there is
        moved there, ``move``); that person is anchored: not taken to explain a track in another region, nor put in
        doubt by an exit door (someone in bed did not go out), and back at once if in doubt. It never adds a person.
        Off: released, nothing more. (A bed sensor also drops to off for minutes while someone sleeps: off does not
        say they got up. When they do, a radar sees them, or they come out through the room's doorway.)"""
        if region not in self.regions:
            return
        self._tick(t)
        if not on:
            self._held.pop(region, None)
            return
        tok = self._anchor_in(region)
        if tok is None and move and not self._in_doorway_to(region):
            tok = self._match(region, t)
            if tok is not None:
                self._move_unseen(tok, region, t)
        self._held[region] = tok.id if tok is not None else None
        if tok is None:
            return
        if tok.visible is None:
            tok.last_seen = t
            tok.floor_seen[self.regions[region].floor] = t
        self.changes.append(Change(t, "evidence", tok.id, region, why))
        if tok.unknown:
            self._establish(tok, t, why or "occupancy")

    def held(self) -> dict[str, int | None]:
        """Regions an occupancy sensor holds, and who is anchored there."""
        return dict(self._held)

    def _anchor_in(self, region: str) -> Token | None:
        """Who an occupancy sensor in this region means: someone in view there, else whoever is believed there
        (firm before in doubt, seen most recently first)."""
        here = [tok for tok in self.tokens.values() if tok.region == region and not tok.provisional]
        return max(here, key=lambda k: (k.visible is not None, not k.unknown, k.last_seen), default=None)

    def _anchored(self, tok: Token) -> bool:
        return tok.region in self._held and self._held[tok.region] == tok.id

    def correct(self, region: str, n: int, t: float) -> None:
        """Someone who knows says this region holds n people: add or remove people to match. Removes the
        longest-unseen first (a phantom is someone nobody has seen), people in view last."""
        if region not in self.regions or n < 0:
            return
        self._tick(t)
        here = sorted(
            (tok for tok in self.tokens.values() if tok.region == region and not tok.provisional),
            key=lambda k: (k.visible is not None, self._anchored(k), k.last_seen),
        )
        for tok in here[: max(0, len(here) - n)]:
            if tok.visible is not None:
                self._binding.pop(tok.visible, None)
            self._drop(tok, t, "corrected")
        for _ in range(max(0, n - len(here))):
            tok = self._new(region, t, "corrected")
            tok.last_seen = t
        for tok in here[-n:] if n else []:
            if tok.unknown:
                self._establish(tok, t, "corrected")

    def correct_home(self, n: int, t: float) -> None:
        """Someone who knows says n people are home (0: nobody, e.g. everyone just left): removes the
        longest-unseen first, anywhere. It only removes: who is where is not known when adding."""
        if n < 0:
            return
        self._tick(t)
        people = sorted(
            (tok for tok in self.tokens.values() if not tok.provisional),
            key=lambda k: (k.visible is not None, self._anchored(k), k.last_seen),
        )
        drop = people[: max(0, len(people) - n)]
        if n == 0:
            drop += [tok for tok in self.tokens.values() if tok.provisional]
            self._pending.clear()  # tracks waiting to be explained: nobody to explain them now
        for tok in drop:
            if tok.visible is not None:
                self._binding.pop(tok.visible, None)
            self._drop(tok, t, "corrected")
        for tok in people[len(drop) :] if n else []:
            if tok.unknown:
                self._establish(tok, t, "corrected")

    def _in_doorway_to(self, region: str) -> bool:
        """Someone in view next door, at a doorway that leads into this region."""
        for other, r in self.regions.items():
            for portal in r.portals:
                if region not in portal.to:
                    continue
                for tid in self._visible[other]:
                    pos = self._pos[other].get(tid)
                    if pos is not None and -signed_distance(pos[0], pos[1], portal.polygon) <= PORTAL_MM:
                        return True
        return False

    def still_spots(self, min_s: float = STATIC_S) -> dict[str, list[tuple[float, float, float]]]:
        """Spots where tracks keep standing still (x, y, seconds): exclusion suggestions (a fan behind a wall)."""
        return {r: [(sp[0], sp[1], sp[2]) for sp in spots if sp[2] >= min_s] for r, spots in self._spots.items() if spots}

    def by_region(self) -> dict[str, int]:
        out = dict.fromkeys(self.regions, 0)
        for tok in self._people():
            out[tok.region] += 1
        return out

    def by_floor(self) -> dict[int, int]:
        out: dict[int, int] = {}
        for r in self.regions.values():
            out.setdefault(r.floor, 0)
        for tok in self._people():
            out[self.regions[tok.region].floor] += 1
        return out

    _now = float("-inf")

    # ----------------------------------------------------------------- inputs

    def door(self, entity_id: str, is_open: bool, t: float) -> None:
        """A door (true exit or connection) opened or closed."""
        self._tick(t)
        prev = self._door_seen.get(entity_id)
        if prev is None or prev[0] != is_open:
            self._door_seen[entity_id] = (is_open, t)
            if is_open:
                self._door_opened[entity_id] = t
            self._into_unobserved(entity_id, t)
        region = self._door_region.get(entity_id)
        if region is None:
            return
        floor = self.regions[region].floor
        w = self._windows.get(floor)
        if is_open:
            if w is None or (w.closed is not None and not self._unsettled(floor, t)):
                w = self._windows[floor] = _Window(floor, t, direction=self._direction(region, t))
            elif (prev is None or not prev[0]) and w.direction != self._direction(region, t):
                w.direction = None  # another exit on the floor opened the other way
            w.open_doors.add(entity_id)
            w.closed = None
            for tok in self.tokens.values():  # on that floor, or seen there just now (their track may have been lost)
                if w.direction == "in":
                    break
                if self.regions[tok.region].floor == floor or t - tok.floor_seen.get(floor, float("-inf")) <= RECENT_S:
                    self._doubt(tok, t, entity_id, floor)
        elif w is not None and entity_id in w.open_doors:
            w.open_doors.discard(entity_id)
            if not w.open_doors:
                w.closed = t
                for tok in self.tokens.values():  # whoever is in view stays in view: re-established after LAG_S
                    if tok.unknown and tok.visible is not None:
                        tok.since = t

    def frame(
        self, region: str, tracks: Mapping[int, tuple[float, float]], t: float, unconfirmed: Iterable[int] = ()
    ) -> None:
        """The region's current tracks (id -> position) after a tracker update. ``unconfirmed``: tracks seen by one
        radar only where another radar of the region looks and sees nothing (a reflection, until confirmed)."""
        self._tick(t)
        tracks = self._drop_static(region, tracks, t)
        self._unconfirmed[region] = set(unconfirmed)
        prev = self._visible[region]
        cur = set(tracks)
        last_pos = self._pos[region]
        self._pos[region] = dict(tracks)
        for tid in prev - cur:
            self._lose(region, tid, t, last_pos.get(tid))
            if (region, tid) in self._pending:
                del self._pending[(region, tid)]
                self.changes.append(Change(t, "ghost", 0, region, f"track {tid}"))
        for tid in sorted(cur):
            key = (region, tid)
            if key in self._pending:
                continue
            tok = self.tokens.get(self._binding.get(key, -1))
            if tok is not None and tok.visible == key:
                self._bind(tok, region, tid, t)  # continuing
            else:
                # A track appears (new, or re-found by the tracker): whoever could be here and was seen last.
                # (A revived track keeps its person only if they have not been seen elsewhere since.)
                stale = tok is None or tok.visible is not None or tok.seen_region != region or (
                    tok.pos is not None and math.hypot(tracks[tid][0] - tok.pos[0], tracks[tid][1] - tok.pos[1]) > REFOUND_MM
                )  # (track ids get reused: a re-found track is near where its person vanished)
                self._appear(region, tid, t, tracks[tid], prefer=None if stale else tok)
        for key in [k for k in self._pending if k[0] == region]:
            self._recheck(key, t)
        for tid, (x, y) in tracks.items():
            for portal in self.regions[region].portals:
                if not portal.to and -signed_distance(x, y, portal.polygon) <= EXIT_NEAR_MM:
                    self._at_exit[(region, tid)] = (t, portal.name)
        self._visible[region] = cur

    def _drop_static(self, region: str, tracks: Mapping[int, tuple[float, float]], t: float) -> dict[int, tuple[float, float]]:
        """Tracks that have not moved STATIC_MM in STATIC_S are machines (a fan, seen through a wall): left out."""
        for key in [k for k in self._paths if k[0] == region and k[1] not in tracks]:
            del self._paths[key]
            self._static.discard(key)
        spots = self._spots.setdefault(region, [])
        spots[:] = [sp for sp in spots if t - sp[3] < SPOT_FORGET_S]
        for tid, (x, y) in tracks.items():
            key = (region, tid)
            p = self._paths.get(key)
            if p is None:
                self._paths[key] = [x, y, t, 0.0, t]
                if SPOT_APPLY and any(sp[2] >= STATIC_S and math.hypot(x - sp[0], y - sp[1]) <= SPOT_MM for sp in spots):
                    self._static.add(key)  # born on a spot where tracks never move
                    self._give_back(key, t)  # (a re-found track id: whoever it had goes back)
                continue
            p[3] = max(p[3], math.hypot(x - p[0], y - p[1]))
            if p[3] < STATIC_MM:  # still standing where it appeared: its time adds to that spot
                sp = next((sp for sp in spots if math.hypot(p[0] - sp[0], p[1] - sp[1]) <= SPOT_MM), None)
                if sp is None:
                    sp = [p[0], p[1], 0.0, t]
                    spots.append(sp)
                sp[2] += t - p[4]
                sp[3] = t
            p[4] = t
            if key in self._static:
                if p[3] >= STATIC_MM:
                    self._static.discard(key)  # it moved after all: a new track from here on
            elif p[3] < STATIC_MM and (t - p[2] >= STATIC_S or SPOT_APPLY and any(
                sq[2] >= STATIC_S and math.hypot(p[0] - sq[0], p[1] - sq[1]) <= SPOT_MM for sq in spots
            )):
                self._static.add(key)
                self._give_back(key, t)
        return {tid: pos for tid, pos in tracks.items() if (region, tid) not in self._static}

    def _give_back(self, key: tuple[str, int], t: float) -> None:
        """A track turned out static: whoever it was bound to goes back to before it (or was never anyone)."""
        region, tid = key
        if key in self._pending:
            del self._pending[key]
        tok = self.tokens.get(self._binding.pop(key, -1))
        self._visible[region].discard(tid)
        if tok is not None and tok.visible is None and tok.before is not None and tok.before[0] == key:
            pass  # bound to this track id before it was lost: still theirs to give back
        elif tok is None or tok.visible != key:
            self.changes.append(Change(t, "ghost", 0, region, f"track {tid} never moved (a fan?)"))
            return
        tok.visible = None
        if tok.origin == key:
            self._drop(tok, t, "not a person")  # it only ever was this track
            return
        if tok.before is not None and tok.before[0] == key:
            _key, tok.region, tok.seen_region, tok.pos, tok.last_seen, tok.unknown, tok.unknown_floor = tok.before
        tok.before = None
        self.changes.append(Change(t, "ghost", tok.id, tok.region, f"track {tid} in {region} never moved (a fan?): given back"))

    def frame_group(
        self, parts: Mapping[str, Mapping[int, tuple[float, float]]], t: float, unconfirmed: Iterable[int] = ()
    ) -> None:
        """One tracker's tracks split over several regions (aligned radars in different rooms). A track that
        changes region is the same person walking through: handed over, not matched again."""
        for region, tracks in parts.items():
            for tid in tracks:
                src = next((r for r in parts if r != region and tid in self._visible[r]), None)
                if src is not None:
                    self._hand_over(src, region, tid)
        flagged = set(unconfirmed)
        for region, tracks in parts.items():
            self.frame(region, tracks, t, flagged & tracks.keys())

    def _hand_over(self, src: str, dst: str, tid: int) -> None:
        self._visible[src].discard(tid)
        self._visible[dst].add(tid)
        if (pos := self._pos[src].pop(tid, None)) is not None:
            self._pos[dst][tid] = pos
        if (p := self._pending.pop((src, tid), None)) is not None:
            p.region = dst
            self._pending[(dst, tid)] = p
        if (ex := self._at_exit.pop((src, tid), None)) is not None:
            self._at_exit[(dst, tid)] = ex
        if (path := self._paths.pop((src, tid), None)) is not None:
            self._paths[(dst, tid)] = path
        if (src, tid) in self._static:
            self._static.discard((src, tid))
            self._static.add((dst, tid))
        if (tok_id := self._binding.pop((src, tid), None)) is not None:
            self._binding[(dst, tid)] = tok_id
            if (tok := self.tokens.get(tok_id)) is not None and tok.visible == (src, tid):
                tok.visible = (dst, tid)  # frame() sees it continuing, and logs the move
                if tok.before is not None and tok.before[0] == (src, tid):
                    tok.before = ((dst, tid), *tok.before[1:])
                if tok.origin == (src, tid):
                    tok.origin = (dst, tid)

    def advance(self, t: float) -> None:
        self._tick(t)

    # -------------------------------------------------------------- internals

    def _tick(self, t: float) -> None:
        self._now = max(self._now, t)
        self._expire_unknown(t)
        self._confirm(t)
        for region, tid in self._held.items():
            tok = self.tokens.get(tid) if tid is not None else None
            if tok is None or tok.region != region or tok.provisional:  # walked out, corrected away: whoever is left
                nxt = self._anchor_in(region)
                self._held[region] = nxt.id if nxt is not None else None

    def _virtual_exit(self, region: str, name: str, t: float) -> None:
        floor = self.regions[region].floor
        w = self._windows.get(floor)
        if w is not None and (w.closed is None or self._unsettled(floor, t)):
            if w.closed is not None:
                w.closed = max(w.closed, t)
            return  # a door on this floor is in use already
        # Nobody can have come in through a door that did not open: at most someone went out.
        self._windows[floor] = _Window(floor, t, closed=t, direction="out")
        for tok in self.tokens.values():
            if self.regions[tok.region].floor == floor or t - tok.floor_seen.get(floor, float("-inf")) <= RECENT_S:
                self._doubt(tok, t, f"vanished at {name}", floor)

    def _direction(self, region: str, t: float) -> str | None:
        """Out or in, from the order of the doors, for an exit of an unobserved region; else unknown."""
        if self.regions[region].observed:
            return None
        inner = [d for other, d in self._links.get(region, ()) if d is not None and self.regions[other].observed]
        if not inner:
            return None
        used = any(t - DIRECTION_S <= self._door_seen.get(d, (False, float("-inf")))[1] <= t or self._door_seen.get(d, (False, 0.0))[0] for d in inner)
        return "out" if used else "in"

    def _unsettled(self, floor: int, t: float) -> bool:
        w = self._windows.get(floor)
        return w is not None and (w.closed is None or t - w.closed < SETTLE_S)

    def _window_floor(self, region: str, t: float) -> _Window | None:
        """The exit window of the region's floor, while new tracks there may still be people coming in."""
        w = self._windows.get(self.regions[region].floor)
        return w if w is not None and self._unsettled(w.floor, t) else None

    def _doubt(self, tok: Token, t: float, why: str, floor: int | None = None) -> None:
        if not tok.unknown and not self._anchored(tok):  # (an occupancy sensor says they are in its room)
            tok.unknown = True
            tok.unknown_floor = self.regions[tok.region].floor if floor is None else floor
            tok.since = t
            self.changes.append(Change(t, "unknown", tok.id, tok.region, why))

    def _expire_unknown(self, t: float) -> None:
        """Re-establish people still seen on the exit floor after the door closed; drop who was not seen again."""
        for tok in list(self.tokens.values()):
            if not tok.unknown:
                continue
            w = self._windows.get(tok.unknown_floor)
            if w is None or w.closed is None:
                continue
            if ESTABLISH_ON_EXIT_FLOOR and tok.visible is not None and t - max(w.closed, tok.since) >= LAG_S:
                self._establish(tok, t, "still here")
            elif t - w.closed >= REESTABLISH_S and (tok.visible is None or not ESTABLISH_ON_EXIT_FLOOR or t - max(w.closed, tok.since) < LAG_S):
                self._drop(tok, t, "left")

    def _establish(self, tok: Token, t: float, why: str) -> None:
        tok.unknown = False
        self.changes.append(Change(t, "arrived" if tok.reason == "arrived" and tok.seen_s <= LAG_S * 4 else "back", tok.id, tok.region, why))

    def _drop(self, tok: Token, t: float, kind: str) -> None:
        del self.tokens[tok.id]
        self.regions_seen.pop(tok.id, None)
        for key in [k for k, v in self._binding.items() if v == tok.id]:
            del self._binding[key]
        self.changes.append(Change(t, kind, tok.id, tok.region))

    def _confirm(self, t: float) -> None:
        """Unexplained tracks: a person walks on into another region or stays around; a reflection does not."""
        for tok in list(self.tokens.values()):
            if not tok.provisional:
                continue
            first_region = self.regions_seen.get(tok.id, tok.region)
            if tok.region != first_region or tok.seen_s >= UNEXPLAINED_SEEN_S:
                tok.provisional = False
                self.changes.append(Change(t, "confirmed", tok.id, tok.region, tok.reason))
            elif t - tok.since >= UNEXPLAINED_EXPIRE_S:
                self._drop(tok, t, "not a person")

    def _new(self, region: str, t: float, reason: str) -> Token:
        tok = Token(self._next, region, t, t, reason)
        self._next += 1
        self.tokens[tok.id] = tok
        self.changes.append(Change(t, reason, tok.id, region))
        return tok

    def _bind(self, tok: Token, region: str, tid: int, t: float) -> None:
        self.regions_seen.setdefault(tok.id, region)
        if tok.visible != (region, tid):  # a new track for this person: remember where they were, in case it is a machine
            tok.before = ((region, tid), tok.region, tok.seen_region, tok.pos, tok.last_seen, tok.unknown, tok.unknown_floor)
            if tok.origin is None and tok.seen_s == 0.0 and t - tok.since < 1.0 and tok.reason in ("arrived", "unexplained", "bootstrap"):
                tok.origin = (region, tid)
        if tok.visible == (region, tid):
            tok.seen_s += max(0.0, t - tok.last_seen)
        if tok.region != region:
            at = f" ({tok.pos[0]:.0f}, {tok.pos[1]:.0f}) -> ({self._pos[region][tid][0]:.0f}, {self._pos[region][tid][1]:.0f})" if tok.pos and tid in self._pos[region] else ""
            self.changes.append(Change(t, "moved", tok.id, region, f"from {tok.region}{at} after {t - tok.last_seen:.0f}s"))
        for key in [k for k, v in self._binding.items() if v == tok.id and k != (region, tid)]:
            del self._binding[key]
        self._binding[(region, tid)] = tok.id
        tok.region, tok.visible, tok.last_seen = region, (region, tid), t
        tok.floor_seen[self.regions[region].floor] = t
        tok.seen_region = region
        tok.pos = self._pos[region].get(tid, tok.pos)
        if tok.unknown and self._window_floor(region, t) is None and (
            ESTABLISH_ON_EXIT_FLOOR or self.regions[region].floor != tok.unknown_floor
        ):
            self._establish(tok, t, "walked in")  # off the exit floor (or seen again after the window): inside
        elif not tok.unknown and (w := self._window_floor(region, t)) is not None and w.direction != "in" and not tok.provisional:
            self._doubt(tok, t, "on the exit floor")  # walked down to the door while it is in use

    def _portal_at(self, region: str, pos: tuple[float, float] | None) -> Portal | None:
        if pos is None:
            return None
        best = None
        for p in self.regions[region].portals:
            d = -signed_distance(pos[0], pos[1], p.polygon)
            if d <= PORTAL_MM and (best is None or d < best[0]):
                best = (d, p)
        return best[1] if best else None

    def _lose(self, region: str, tid: int, t: float, pos: tuple[float, float] | None = None) -> None:
        tok = self.tokens.get(self._binding.get((region, tid), -1))
        if tok is not None and tok.visible == (region, tid):
            tok.visible = None
            portal = self._portal_at(region, pos)
            passed = self._at_exit.pop((region, tid), None)
            if VIRTUAL_EXITS and passed is not None and t - passed[0] <= EXIT_PASS_S:
                self._virtual_exit(region, passed[1], t)  # went through the front door and vanished: maybe out, sensor or not
            if portal is not None and len(portal.to) == 1 and (self.regions[portal.to[0]].observed or self._enclosed(portal.to[0])):
                self._move_unseen(tok, portal.to[0], t)  # went through (a stairwell both ways: unknown which)
                return
            for other, door in self._links.get(region, ()):
                if door is not None and not self.regions[other].observed and self._door_recent(door, t, INTO_UNOBSERVED_S):
                    self._move_unseen(tok, other, t)
                    break

    def _door_recent(self, door: str, t: float, window: float) -> bool:
        st = self._door_seen.get(door)
        return st is not None and (st[0] or abs(t - st[1]) <= window)

    def _move_unseen(self, tok: Token, region: str, t: float) -> None:
        self.changes.append(Change(t, "moved", tok.id, region, f"from {tok.region} (unseen)"))
        tok.region = region
        if (w := self._window_floor(region, t)) is not None and w.direction != "in":
            self._doubt(tok, t, "towards the exit")

    def _into_unobserved(self, door: str, t: float) -> None:
        """A door into an unobserved region was used: whoever was just lost next to it went in."""
        for a, b, d in [(a, b, d) for a in self._links for b, d in self._links[a] if d == door]:
            if self.regions[a].observed and not self.regions[b].observed:
                for tok in list(self.tokens.values()):
                    if tok.region == a and tok.visible is None and t - tok.last_seen <= INTO_UNOBSERVED_S:
                        self._move_unseen(tok, b, t)

    def _reach(self, tok: Token, region: str, t: float) -> int | None:
        """Cost of explaining a sighting in `region` by this unseen token, or None if impossible."""
        if tok.region == region:
            return 0
        gate = self._window_floor(region, t) is not None and not tok.unknown and not self.regions[region].portals
        if gate and t - tok.last_seen > RECENT_S:
            return None  # during an exit window, a new track on its floor is someone coming in, not a sleeper
        if self._links:
            hops = self._path(tok.region, region, t)
            floors = abs(self.regions[tok.region].floor - self.regions[region].floor)
            if hops is None or t - tok.last_seen < FLOOR_TRAVEL_S * floors:
                return None
            if gate and hops > 1:
                return None  # ... and someone from upstairs is seen next to the stairs first
            return 1 + hops
        floors = abs(self.regions[tok.region].floor - self.regions[region].floor)
        if t - tok.last_seen < FLOOR_TRAVEL_S * max(floors, 1):
            return None
        return 1 + floors

    def _door_used(self, door: str, t: float) -> bool:
        """Open now, or opened/closed within the last CROSS_WINDOW_S (people cross just before they show up)."""
        st = self._door_seen.get(door)
        return st is not None and (st[0] or t - CROSS_WINDOW_S <= st[1] <= t)

    def _path(self, a: str, b: str, t: float) -> int | None:
        """Fewest links from region a to b, through doors only if they were used just now."""
        seen, frontier, hops = {a}, [a], 0
        while frontier:
            hops += 1
            nxt = []
            for r in frontier:
                for other, door in self._links.get(r, ()):
                    if other in seen or (door is not None and not self._door_used(door, t)):
                        continue
                    if other == b:
                        return hops
                    seen.add(other)
                    nxt.append(other)
            frontier = nxt
        return None

    def _enclosed(self, region: str) -> bool:
        """An unobserved room with no way out but doorways from observed rooms (a bedroom without a radar)."""
        r = self.regions[region]
        links = self._links.get(region, ())
        return not r.observed and not r.exits and bool(links) and all(d is None and self.regions[o].observed for o, d in links)

    def _match(self, region: str, t: float, only: Iterable[str] | None = None, patient: bool = False) -> Token | None:
        """The unseen person most likely to be a new track here: whoever was seen most recently and could have
        walked here. (A still person who reappears is re-found by the region's tracker near where they vanished, so
        a new track is usually someone on the move.) Ties go to the nearer region."""
        best: tuple[float, int, Token] | None = None
        for tok in self.tokens.values():
            if tok.visible is not None or (only is not None and tok.region not in only):
                continue
            if tok.unknown and tok.region != region and self.regions[region].portals and (only is None or tok.region not in only):
                continue  # someone at the exit comes back through the doorway from where they are, not out of thin air
            if self._enclosed(tok.region) and (only is None or tok.region not in only) and not patient:
                continue  # someone in a room without a radar comes out through its door (unless missed: patient)
            if tok.region != region and self._anchored(tok) and (only is None or tok.region not in only):
                continue  # in bed (an occupancy sensor holds them), unless coming out through its doorway
            cost = self._reach(tok, region, t)
            if cost is not None and (best is None or (-tok.last_seen, cost) < (-best[2].last_seen, best[1])):
                best = (tok.last_seen, cost, tok)
        return best[2] if best else None

    def _next_to_someone(self, region: str, tid: int, pos: tuple[float, float]) -> bool:
        for k, q in self._pos[region].items():
            tok = self.tokens.get(self._binding.get((region, k), -1))
            if k != tid and tok is not None and tok.visible == (region, k) and math.hypot(pos[0] - q[0], pos[1] - q[1]) < SEPARATE_MM:
                return True
        return False

    def _from_unobserved(self, region: str, t: float) -> bool:
        """Coming out of an unobserved region (the garage) shortly after its exit door opened."""
        for other, door in self._links.get(region, ()):
            if door is None or self.regions[other].observed or not self._door_used(door, t):
                continue
            if any(t - self._door_opened.get(e, float("-inf")) <= UNOBSERVED_ARRIVE_S for e in self.regions[other].exits):
                return True
        return False

    def _appear(self, region: str, tid: int, t: float, pos: tuple[float, float], prefer: Token | None = None) -> None:
        portal = self._portal_at(region, pos)  # (a re-found track at a doorway too: the doorway says who could be there)
        if prefer is None and tid in self._unconfirmed.get(region, ()):
            self._pending[(region, tid)] = _Pending(region, tid, t)  # one radar's reflection, until another sees it
            return
        if prefer is None and portal is None and self._next_to_someone(region, tid, pos):
            # Right next to someone in view: most likely their track splitting, not someone else arriving.
            self._pending[(region, tid)] = _Pending(region, tid, t)
            return
        if portal is not None and all(not self.regions[r].observed for r in portal.to):
            # At a door to outside or the garage: someone back from the garage, or someone here lost at the door a
            # moment ago (seen through it, or the radar dropped them in the doorway), else someone coming in.
            tok = (self._match(region, t, only=portal.to) if portal.to else None) or self._match(region, t, only=(region,))
        elif portal is not None:
            # At the stairs: someone from where they lead (however long they sat still), else whoever could be.
            tok = self._match(region, t, only=portal.to) or self._match(region, t, only=(region,)) or self._match(region, t)
        else:
            tok = self._match(region, t)
        # The tracker re-found its track: the same person if it lost them just now; after a long gap, whoever was seen
        # last is likelier (a settled lost track can be revived by someone else).
        if prefer is not None and (tok is None or tok.last_seen <= prefer.last_seen or t - prefer.last_seen <= REFOUND_S):
            tok = prefer
        if tok is not None:
            self._bind(tok, region, tid, t)
        elif (w := self._window_floor(region, t)) is not None and w.direction != "out":
            tok = self._new(region, t, "arrived")  # coming in: unknown until re-established like everyone there
            tok.unknown = True
            self._bind(tok, region, tid, t)
        elif self._from_unobserved(region, t):
            tok = self._new(region, t, "arrived")
            self._bind(tok, region, tid, t)
        else:
            self._pending[(region, tid)] = _Pending(region, tid, t, portal)

    def _recheck(self, key: tuple[str, int], t: float) -> None:
        """An unexplained track: someone who went unseen meanwhile, or (after a while, apart from others) someone new."""
        region, tid = key
        p = self._pending[key]
        if tid in self._unconfirmed.get(region, ()):
            return  # still only one radar sees it where another one looks
        if self._next_to_someone(region, tid, self._pos[region][tid]):
            return  # still beside the person it probably split from
        # (Appeared at a doorway: someone from where it leads, not from a room without a radar elsewhere.)
        patient = t - p.first >= CONFIRM_S and (p.portal is None or any(self._enclosed(r) for r in p.portal.to))
        if (tok := self._match(region, t, patient=patient)) is not None:
            del self._pending[key]
            self._bind(tok, region, tid, t)
            return
        if (w := self._window_floor(region, t)) is not None and w.direction != "out":
            del self._pending[key]  # seen outside before the door opened (radars see through doors): coming in
            tok = self._new(region, t, "arrived")
            tok.unknown = True
            self._bind(tok, region, tid, t)
            return
        wait = BOOTSTRAP_CONFIRM_S if t < self._bootstrap_until else CONFIRM_S
        if t - p.first < wait:
            return
        x, y = self._pos[region][tid]
        others = [q for k, q in self._pos[region].items() if k != tid]
        # Someone in view next door (no door between) may be this very person, seen by both radars.
        neighbour_seen = any(door is None and self._visible.get(other) for other, door in self._links.get(region, ()))
        if not neighbour_seen and all(math.hypot(x - q[0], y - q[1]) >= SEPARATE_MM for q in others):
            del self._pending[key]
            tok = self._new(region, t, "bootstrap" if t < self._bootstrap_until else "unexplained")
            tok.provisional = t >= self._bootstrap_until
            self._bind(tok, region, tid, t)
