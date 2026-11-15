"""Head count per area, floor and home from conservation of people.

People do not appear or vanish: they come in and leave through the home's
true exits (front door, garage door), and move between floors over the
stairs. Radars lose people who sit or lie still, and rooms without a radar
never see anyone, so counts are kept by *tokens*: one per person believed to
be home, each with the region where they were last seen.

- **Regions** are the areas a group of aligned radars watches (one radar in
  most homes), each on a floor. Floors are ordered by level; people move
  between adjacent floors.
- **Sightings** come from the regions' trackers (``tracker.Tracker``): a
  track that appears is matched to a token that could be there: an unseen
  token in the same region, else on the same floor, else on an adjacent floor
  (allowing ``FLOOR_TRAVEL_S`` per floor), preferring the one seen most
  recently. A track the tracker re-finds keeps its token.
- **Arrivals**: a track that no token can explain, in a region whose true
  exit door is open or closed less than ``DOOR_WINDOW_S`` ago, is someone
  coming in: a new token. Without a door it is *unexplained* (a split track, a
  reflection, or someone missed coming in): it becomes a token only after
  ``CONFIRM_S`` at least ``SEPARATE_MM`` from everyone else in view, and only
  if no token went unseen meanwhile that could be it.
- **Departures**: tokens seen in a door's region shortly before or while
  it was open, last seen there no later than ``DEPART_GRACE_S`` after it
  closed and then unseen for ``GONE_S``, have left.
- **Connections with doors**: two regions joined by a door (the hallway
  and the garage) can only be crossed if that door was open within
  ``CROSS_WINDOW_S``. Without one, a track in the garage while nobody opened
  the door from the house is someone arriving, not someone from inside.
- **Unobserved regions** (no radar, or one that only sees ghosts): someone
  lost next to the door into it while that door was used went in; whoever is
  inside when its exit door opens and closes and does not come back out has
  left; someone new coming out of it shortly after its exit door opened has
  arrived.
- Counts are the tokens per region, per floor and in total, so the levels
  always add up.

Pure Python, no Home Assistant imports; time is passed in.
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field

FLOOR_TRAVEL_S = 3.0  # fastest time from one floor to the next
DOOR_WINDOW_S = 30.0  # arrivals up to this long after the door closed; leavers seen this long before it opened
DEPART_GRACE_S = 60.0  # a leaver may still be seen this long after the door closed (lagging sensors)
GONE_S = 30.0  # ... and must then stay unseen this long
SETTLE_MAX_S = 300.0  # decide a door's departures at the latest this long after it closed
CONFIRM_S = 60.0  # an unexplained extra person must be seen this long to count
BOOTSTRAP_CONFIRM_S = 20.0
SEPARATE_MM = 1500.0  # ... and this far from everyone else in view in the region
CROSS_WINDOW_S = 60.0  # a door between two regions must have been open this recently to cross it
ARRIVE_CONFIRM_S = 600.0  # an arrival must be seen in another region within this long
INTO_UNOBSERVED_S = 20.0  # lost this close (before or after) to the door into an unobserved region being used: went in
UNOBSERVED_ARRIVE_S = 600.0  # someone new coming out of an unobserved region this long after its exit door opened
UNOBSERVED_STAY_S = 1800.0  # a door-opening counts people who went into the unobserved region up to this long before
ARRIVE_GONE_S = 60.0  # an arrival unseen this long without having walked on was not a person
UNEXPLAINED_SEEN_S = 600.0  # someone appearing without a door counts once seen this long (or seen in another region)
UNEXPLAINED_EXPIRE_S = 3600.0  # ... within this long, else it was not a person (a washer, a fan, a reflection)


@dataclass(frozen=True, slots=True)
class Region:
    id: str
    floor: int  # floor level
    exits: tuple[str, ...] = ()  # true exit doors (entity ids) of this region
    name: str = ""
    observed: bool = True  # False: no (usable) radar, e.g. a garage with a glass door; inferred from its doors


@dataclass(slots=True)
class Token:
    id: int
    region: str
    last_seen: float
    since: float  # when the token was created
    reason: str  # "arrived", "bootstrap", "unexplained"
    visible: tuple[str, int] | None = None  # (region, track id) while seen
    provisional: bool = False  # an arrival not yet confirmed as a person (could be the door or a car)
    seen_s: float = 0.0  # time seen since created


@dataclass(slots=True)
class _Pending:
    region: str
    track: int
    first: float


@dataclass(slots=True)
class _Door:
    region: str
    opened: float
    closed: float | None = None
    candidates: set[int] = field(default_factory=set)


@dataclass(frozen=True, slots=True)
class Change:
    t: float
    kind: str  # "arrived", "left", "moved", "unexplained", "ghost"
    token: int
    region: str
    detail: str = ""


class HeadCount:
    def __init__(
        self,
        regions: Iterable[Region],
        bootstrap_until: float = float("-inf"),
        connections: Iterable[tuple[str, str, str]] = (),
    ) -> None:
        """``connections``: (region, region, door entity or None) links between regions. Given any, people move
        only along them, through doors that opened since they were last seen; else between adjacent floors."""
        self.regions = {r.id: r for r in regions}
        self._via = {frozenset((a, b)): door for a, b, door in connections}
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
        self._doors: dict[str, _Door] = {}  # exit entity -> current/last opening
        self._bootstrap_until = bootstrap_until
        self._next = 1
        self.changes: list[Change] = []

    # ----------------------------------------------------------------- counts

    def _people(self) -> list[Token]:
        return [tok for tok in self.tokens.values() if not tok.provisional]

    def count(self) -> int:
        return len(self._people())

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

    # ----------------------------------------------------------------- inputs

    def door(self, entity_id: str, is_open: bool, t: float) -> None:
        """A door (true exit or connection) opened or closed."""
        prev = self._door_seen.get(entity_id)
        if prev is None or prev[0] != is_open:
            self._door_seen[entity_id] = (is_open, t)
            if is_open:
                self._door_opened[entity_id] = t
            self._into_unobserved(entity_id, t)
        region = self._door_region.get(entity_id)
        if region is None:
            return
        d = self._doors.get(entity_id)
        if is_open:
            if d is None or d.closed is not None:
                if d is not None:
                    self._decide(entity_id, d, t)
                d = _Door(region, t)
                recent = DOOR_WINDOW_S if self.regions[region].observed else UNOBSERVED_STAY_S
                d.candidates = {tok.id for tok in self.tokens.values() if tok.region == region and t - tok.last_seen <= recent}
                self._doors[entity_id] = d
        elif d is not None and d.closed is None:
            d.closed = t

    def frame(self, region: str, tracks: Mapping[int, tuple[float, float]], t: float) -> None:
        """The region's current tracks (id -> position) after a tracker update."""
        self._settle(t)
        self._confirm(t)
        prev = self._visible[region]
        cur = set(tracks)
        self._pos[region] = dict(tracks)
        for tid in prev - cur:
            self._lose(region, tid, t)
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
                self._appear(region, tid, t, prefer=tok if tok is not None and tok.visible is None else None)
        for key in [k for k in self._pending if k[0] == region]:
            self._recheck(key, t)
        for tid in cur:
            tok = self.tokens.get(self._binding.get((region, tid), -1))
            if tok is not None and tok.visible == (region, tid):
                for d in self._doors.values():
                    if d.region == region and (d.closed is None or t - d.closed <= DEPART_GRACE_S):
                        d.candidates.add(tok.id)
        self._visible[region] = cur

    def advance(self, t: float) -> None:
        self._settle(t)

    def _confirm(self, t: float) -> None:
        """Provisional arrivals: a person walks on into the home (another region) or stays around; the door or a car does not."""
        for tok in list(self.tokens.values()):
            if not tok.provisional:
                continue
            first_region = self.regions_seen.get(tok.id, tok.region)
            arrival = tok.reason == "arrived"
            # An arrival counts once it walks on into the home: cars, doors and bikes stay where they are.
            if tok.region != first_region or (not arrival and tok.seen_s >= UNEXPLAINED_SEEN_S):
                tok.provisional = False
                self.changes.append(Change(t, "confirmed", tok.id, tok.region, tok.reason))
            elif t - tok.since >= (ARRIVE_CONFIRM_S if arrival else UNEXPLAINED_EXPIRE_S) or (
                arrival and tok.visible is None and t - tok.last_seen >= ARRIVE_GONE_S
            ):
                del self.tokens[tok.id]
                for key in [k for k, v in self._binding.items() if v == tok.id]:
                    del self._binding[key]
                self.changes.append(Change(t, "not a person", tok.id, tok.region))

    # -------------------------------------------------------------- internals

    def _new(self, region: str, t: float, reason: str) -> Token:
        tok = Token(self._next, region, t, t, reason)
        self._next += 1
        self.tokens[tok.id] = tok
        self.changes.append(Change(t, reason, tok.id, region))
        return tok

    def _bind(self, tok: Token, region: str, tid: int, t: float) -> None:
        self.regions_seen.setdefault(tok.id, region)
        if tok.visible == (region, tid):
            tok.seen_s += max(0.0, t - tok.last_seen)
        if tok.region != region:
            self.changes.append(Change(t, "moved", tok.id, region, f"from {tok.region}"))
        for key in [k for k, v in self._binding.items() if v == tok.id and k != (region, tid)]:
            del self._binding[key]
        self._binding[(region, tid)] = tok.id
        tok.region, tok.visible, tok.last_seen = region, (region, tid), t

    def _lose(self, region: str, tid: int, t: float) -> None:
        tok = self.tokens.get(self._binding.get((region, tid), -1))
        if tok is not None and tok.visible == (region, tid):
            tok.visible = None
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
        for d in self._doors.values():
            if d.region == region:
                d.candidates.add(tok.id)

    def _into_unobserved(self, door: str, t: float) -> None:
        """A door into an unobserved region was used: whoever was just lost next to it went in."""
        for a, b, d in [(a, b, d) for a in self._links for b, d in self._links[a] if d == door]:
            if self.regions[a].observed and not self.regions[b].observed:
                for tok in self.tokens.values():
                    if tok.region == a and tok.visible is None and t - tok.last_seen <= INTO_UNOBSERVED_S:
                        self._move_unseen(tok, b, t)

    def _reach(self, tok: Token, region: str, t: float) -> int | None:
        """Cost of explaining a sighting in `region` by this unseen token, or None if impossible."""
        if tok.region == region:
            return 0
        if self._links:
            hops = self._path(tok.region, region, tok.last_seen, t)
            floors = abs(self.regions[tok.region].floor - self.regions[region].floor)
            if hops is None or t - tok.last_seen < FLOOR_TRAVEL_S * floors or (tok.provisional and hops > 1):
                return None  # (someone just arrived is seen in the next room first)
            return 1 + hops
        floors = abs(self.regions[tok.region].floor - self.regions[region].floor)
        if t - tok.last_seen < FLOOR_TRAVEL_S * max(floors, 1):
            return None
        return 1 + floors

    def _door_used(self, door: str, t: float) -> bool:
        """Open now, or opened/closed within the last CROSS_WINDOW_S (people cross just before they show up)."""
        st = self._door_seen.get(door)
        return st is not None and (st[0] or t - CROSS_WINDOW_S <= st[1] <= t)

    def _path(self, a: str, b: str, since: float, t: float) -> int | None:
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

    def _match(self, region: str, t: float) -> Token | None:
        """The unseen person most likely to be a new track here: whoever was seen most recently and could have
        walked here. (A still person who reappears is re-found by the region's tracker near where they vanished, so
        a new track is usually someone on the move.) Ties go to the nearer region."""
        best: tuple[float, int, Token] | None = None
        for tok in self.tokens.values():
            if tok.visible is not None:
                continue
            cost = self._reach(tok, region, t)
            if cost is not None and (best is None or (-tok.last_seen, cost) < (-best[2].last_seen, best[1])):
                best = (tok.last_seen, cost, tok)
        return best[2] if best else None

    def _door_open(self, region: str, t: float) -> bool:
        if any(
            d.region == region and t >= d.opened - 5 and (d.closed is None or t - d.closed <= DOOR_WINDOW_S)
            for d in self._doors.values()
        ):
            return True
        # Coming out of an unobserved region (the garage) shortly after its exit door opened.
        for other, door in self._links.get(region, ()):
            if door is None or self.regions[other].observed or not self._door_used(door, t):
                continue
            if any(t - self._door_opened.get(e, float("-inf")) <= UNOBSERVED_ARRIVE_S for e in self.regions[other].exits):
                return True
        return False

    def _appear(self, region: str, tid: int, t: float, prefer: Token | None = None) -> None:
        tok = self._match(region, t)
        if prefer is not None and (tok is None or tok.last_seen <= prefer.last_seen):
            tok = prefer
        if tok is not None:
            self._bind(tok, region, tid, t)
        elif self._door_open(region, t):
            tok = self._new(region, t, "arrived")
            tok.provisional = not self._from_unobserved(region, t)
            self._bind(tok, region, tid, t)
        else:
            self._pending[(region, tid)] = _Pending(region, tid, t)

    def _from_unobserved(self, region: str, t: float) -> bool:
        return any(
            door is not None and not self.regions[other].observed and self._door_used(door, t)
            for other, door in self._links.get(region, ())
        )

    def _recheck(self, key: tuple[str, int], t: float) -> None:
        """An unexplained track: someone who went unseen meanwhile, or (after a while, apart from others) someone new."""
        region, tid = key
        p = self._pending[key]
        if (tok := self._match(region, t)) is not None:
            del self._pending[key]
            self._bind(tok, region, tid, t)
            return
        wait = BOOTSTRAP_CONFIRM_S if t < self._bootstrap_until else CONFIRM_S
        if t - p.first < wait:
            return
        x, y = self._pos[region][tid]
        others = [q for k, q in self._pos[region].items() if k != tid]
        if all(math.hypot(x - q[0], y - q[1]) >= SEPARATE_MM for q in others):
            del self._pending[key]
            tok = self._new(region, t, "bootstrap" if t < self._bootstrap_until else "unexplained")
            tok.provisional = t >= self._bootstrap_until
            self._bind(tok, region, tid, t)

    def _decide(self, entity_id: str, d: _Door, t: float) -> None:
        for tok_id in sorted(d.candidates):
            tok = self.tokens.get(tok_id)
            if tok is None or tok.visible is not None or tok.region != d.region:
                continue
            closed = d.closed if d.closed is not None else t
            before = DOOR_WINDOW_S if self.regions[d.region].observed else UNOBSERVED_STAY_S
            if d.opened - before <= tok.last_seen <= closed + DEPART_GRACE_S and t - tok.last_seen >= GONE_S:
                del self.tokens[tok_id]
                for key in [k for k, v in self._binding.items() if v == tok_id]:
                    del self._binding[key]
                self.changes.append(Change(t, "left", tok_id, d.region, entity_id))
        del self._doors[entity_id]

    def _settle(self, t: float) -> None:
        """Decide departures once every candidate has been gone GONE_S (at the latest SETTLE_MAX_S after closing)."""
        for e, d in list(self._doors.items()):
            if d.closed is None or t - d.closed < DOOR_WINDOW_S:
                continue
            waiting = False
            for tok_id in d.candidates:
                tok = self.tokens.get(tok_id)
                if tok is not None and tok.region == d.region and (tok.visible is not None or t - tok.last_seen < GONE_S):
                    waiting = True
            if not waiting or t - d.closed >= SETTLE_MAX_S:
                self._decide(e, d, t)
