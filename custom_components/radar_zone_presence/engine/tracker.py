"""Track people across frames (and across aligned radars) by position.

The radar's target slots are not identities. When the LD2450 loses a target
(a person sitting still is often dropped) the remaining ones are renumbered:
the person in slot 2 becomes slot 1, a 5 m "jump" in one frame. A person who
reappears gets whatever slot is free. Zone logic that follows slots then sees
the person at the desk walk out (and a held occupant released by someone
appearing on the other side of the room).

The tracker turns observations (already transformed into the group's frame)
into tracks with stable integer ids, used as slots by the zone engine:

- An observation continues the track its (radar, slot) belonged to only if
  a person could have walked there: within ``NOISE_MM`` plus ``VMAX_MM_S``
  times the time since the track was last seen (the speed term capped at
  ``MAX_STEP_MM``). Otherwise the slot was renumbered or reused.
- Observations left over are matched, nearest first, to tracks of the same
  radar that lost their slot (renumbering), to tracks of other radars within
  ``MERGE_MM`` (the same person seen twice), and then to recently lost tracks
  within the same reach (speed term capped at ``REVIVE_MM``): a person
  re-detected near where they vanished keeps their id. The rest are new.
- A track that loses its observations becomes *lost*, remembered at its last
  position. The radar keeps seeing people who walk and drops people who sit
  or lie still, so someone who vanishes in the middle of the room is still
  there (*settled*, remembered for ``SETTLED_TTL_S``). Someone who vanishes in
  an exit, a ``transient`` spot or within ``EDGE_MM`` of the side of every
  field of view that saw them most likely left (the far end of the range is
  usually the far wall, with a bed or a desk against it, so it does not
  count), and is forgotten after
  ``TRANSIENT_TTL_S``. ``linger`` spots are always settled. Forgotten ids are
  reported in ``dropped`` so the zone engine can release their holds.
- Two tracks from different radars that come within ``MERGE_MM`` merge into
  the older one; the other id is reported in ``gone``. A radar slot that
  drifts more than ``SPLIT_MM`` from the rest of its track is split off.

Track ids are ``10 * radar_index + slot`` when free. ``frontend/tracker.js``
is a line-by-line port.
"""

from __future__ import annotations

import heapq
import math
from collections.abc import Sequence
from dataclasses import dataclass, field

from .align import IDENTITY, Affine, apply, invert, transform_polygon
from .frames import Frame, Target
from .geometry import point_in_polygon
from .zones import KIND_EXCLUDE, KIND_EXIT, KIND_INCLUDE, KIND_LINGER, KIND_TRANSIENT, Zone, ZoneEngine

NOISE_MM = 500.0  # measurement jitter plus alignment error between radars
VMAX_MM_S = 2500.0  # a brisk walk
MAX_STEP_MM = 1500.0  # cap on the speed term while a track is seen
REVIVE_MM = 1500.0  # cap on the speed term when re-finding a lost person
MERGE_MM = 600.0
SPLIT_MM = 1200.0
EDGE_MM = 600.0  # this close to the side of the field of view = leaving it
FOV_HALF_ANGLE_DEG = 60.0
MAX_LOST = 32
TRANSIENT_TTL_S = 20.0
SETTLED_TTL_S = 12 * 3600.0
_FIRST_FREE_ID = 1000


@dataclass(frozen=True, slots=True)
class Observation:
    radar: int  # index of the radar in the group
    slot: int
    x: float  # mm, group frame
    y: float


@dataclass(slots=True)
class _Track:
    id: int
    seq: int  # creation order; the older track wins a merge
    members: list[tuple[int, int]] = field(default_factory=list)  # (radar, slot), oldest first
    x: float = 0.0
    y: float = 0.0
    t: float = 0.0  # last seen


@dataclass(slots=True)
class _Lost:
    id: int
    seq: int
    x: float
    y: float
    t: float  # last seen
    settled: bool

    @property
    def expires(self) -> float:
        return self.t + (SETTLED_TTL_S if self.settled else TRANSIENT_TTL_S)


@dataclass(frozen=True, slots=True)
class FusedFrame:
    targets: tuple[Target, ...]  # slot = track id
    gone: tuple[int, ...]  # track ids merged away this frame
    radars: dict[int, frozenset[int]]  # track id -> radar indexes that see it
    born: tuple[int, ...] = ()  # new tracks (not continued, not re-found)
    dropped: tuple[int, ...] = ()  # lost tracks forgotten


def _reach(cap: float, dt: float) -> float:
    return NOISE_MM + min(VMAX_MM_S * max(dt, 0.0), cap)


def _mean(obs: list[Observation]) -> tuple[float, float]:
    return sum(o.x for o in obs) / len(obs), sum(o.y for o in obs) / len(obs)


def side_margin(x: float, y: float) -> float:
    """Distance (mm, radar frame) to the nearer side (±60°) of the field of view; negative outside."""
    a = abs(math.atan2(x, y))
    half = math.radians(FOV_HALF_ANGLE_DEG)
    return math.hypot(x, y) * math.sin(half - a) if a < half else -1.0


class Tracker:
    def __init__(self, spots: Sequence[Zone] = (), to_radar: Sequence[Affine] = ()) -> None:
        """``spots``: exits, linger and transient zones (group frame). ``to_radar``: per
        radar index, the transform from the group frame into the radar's (for the
        sides of its field of view; none given: never at a side)."""
        self._tracks: dict[int, _Track] = {}
        self._lost: dict[int, _Lost] = {}
        self._seq = 0
        self._linger = [z.polygon for z in spots if z.kind == KIND_LINGER]
        self._transient = [z.polygon for z in spots if z.kind in (KIND_TRANSIENT, KIND_EXIT)]
        self._to_radar = list(to_radar)

    @property
    def lost(self) -> list[tuple[int, float, float, bool]]:
        """(id, x, y, settled) of people lost but not forgotten."""
        return [(lo.id, lo.x, lo.y, lo.settled) for lo in self._lost.values()]

    def next_deadline(self) -> float | None:
        return min((lo.expires for lo in self._lost.values()), default=None)

    def expire(self, t: float) -> tuple[int, ...]:
        """Forget lost tracks whose memory ran out; returns their ids."""
        out = sorted(i for i, lo in self._lost.items() if lo.expires <= t + 1e-6)
        for i in out:
            del self._lost[i]
        return tuple(out)

    def _settled(self, tr: _Track) -> bool:
        if any(point_in_polygon(tr.x, tr.y, p) for p in self._transient):
            return False
        if any(point_in_polygon(tr.x, tr.y, p) for p in self._linger):
            return True
        views = [self._to_radar[k] for k in sorted({m[0] for m in tr.members}) if k < len(self._to_radar)]
        return not views or any(side_margin(*apply(a, tr.x, tr.y)) >= EDGE_MM for a in views)

    def _new_id(self, radar: int, slot: int, used: set[int]) -> int:
        tid = 10 * radar + slot
        if tid in used or tid >= _FIRST_FREE_ID:
            tid = _FIRST_FREE_ID
            while tid in used:
                tid += 1
        return tid

    def fuse(self, observations: Sequence[Observation], t: float) -> FusedFrame:
        dropped = self.expire(t)
        prev = self._tracks
        owner = {m: tr.id for tr in prev.values() for m in tr.members}
        assigned: dict[int, list[Observation]] = {}
        unassigned: list[Observation] = []
        for o in observations:
            tid = owner.get((o.radar, o.slot))
            if tid is not None and math.hypot(o.x - prev[tid].x, o.y - prev[tid].y) <= _reach(MAX_STEP_MM, t - prev[tid].t):
                assigned.setdefault(tid, []).append(o)
            else:
                unassigned.append(o)

        # Split off observations that drifted away from their track's oldest member.
        for tid, obs in assigned.items():
            if len(obs) < 2:
                continue
            order = {m: i for i, m in enumerate(prev[tid].members)}
            obs.sort(key=lambda o: order.get((o.radar, o.slot), len(order)))
            keep = [obs[0]]
            for o in obs[1:]:
                if math.hypot(o.x - obs[0].x, o.y - obs[0].y) > SPLIT_MM:
                    unassigned.append(o)
                else:
                    keep.append(o)
            assigned[tid] = keep

        # Leftovers, nearest pairs first: a previous track that has no observation
        # from their radar yet (same radar within reach: a renumbered slot; other
        # radars only within MERGE_MM), or a lost person re-found near where they
        # vanished.
        pairs = []
        for i, o in enumerate(unassigned):
            for tr in prev.values():
                had = any(m[0] == o.radar for m in tr.members)
                limit = _reach(MAX_STEP_MM, t - tr.t) if had else MERGE_MM
                d = math.hypot(o.x - tr.x, o.y - tr.y)
                if d <= limit:
                    pairs.append((d, o.radar, o.slot, 0, tr.id, i))
            for lo in self._lost.values():
                d = math.hypot(o.x - lo.x, o.y - lo.y)
                if d <= _reach(REVIVE_MM, t - lo.t):
                    pairs.append((d, o.radar, o.slot, 1, lo.id, i))
        pairs.sort()
        taken: set[int] = set()
        revive: dict[int, Observation] = {}
        for _, radar, _, lost, tid, i in pairs:
            if i in taken:
                continue
            if lost:
                if tid in revive:
                    continue
                revive[tid] = unassigned[i]
            elif any(o.radar == radar for o in assigned.get(tid, ())):
                continue
            else:
                assigned.setdefault(tid, []).append(unassigned[i])
            taken.add(i)
        unassigned = [o for i, o in enumerate(unassigned) if i not in taken]

        tracks: dict[int, _Track] = {}
        for tid, obs in assigned.items():
            old = prev[tid]
            members = [m for m in old.members if any((o.radar, o.slot) == m for o in obs)]
            members += [(o.radar, o.slot) for o in obs if (o.radar, o.slot) not in members]
            x, y = _mean(obs)
            tracks[tid] = _Track(tid, old.seq, members, x, y, t)
        for tid, o in revive.items():
            lo = self._lost.pop(tid)
            tracks[tid] = _Track(tid, lo.seq, [(o.radar, o.slot)], o.x, o.y, t)
            assigned[tid] = [o]
        revived = set(revive)

        # People who vanished are remembered where they were last seen.
        for tid, tr in prev.items():
            if tid not in tracks:
                self._lost[tid] = _Lost(tid, tr.seq, tr.x, tr.y, tr.t, self._settled(tr))
        while len(self._lost) > MAX_LOST:  # oldest first
            oldest = min(self._lost.values(), key=lambda lo: (lo.t, lo.id))
            del self._lost[oldest.id]
            dropped = (*dropped, oldest.id)

        # The rest join a track of another radar seen this frame, else they are new.
        unassigned.sort(key=lambda o: (o.radar, o.slot))
        born: list[int] = []
        for o in unassigned:
            best, best_d = None, MERGE_MM
            for tr in tracks.values():
                if any(m[0] == o.radar for m in tr.members):
                    continue
                d = math.hypot(tr.x - o.x, tr.y - o.y)
                if d <= best_d:
                    best, best_d = tr, d
            if best is not None:
                obs = assigned[best.id]
                obs.append(o)
                best.members.append((o.radar, o.slot))
                best.x, best.y = _mean(obs)
                continue
            tid = self._new_id(o.radar, o.slot, set(tracks) | set(prev) | set(self._lost))
            self._seq += 1
            tracks[tid] = _Track(tid, self._seq, [(o.radar, o.slot)], o.x, o.y, t)
            assigned[tid] = [o]
            born.append(tid)

        # Merge tracks of different radars that converged on the same person.
        gone: list[int] = []
        released = list(dropped)
        merged = True
        while merged:
            merged = False
            live = sorted(tracks.values(), key=lambda tr: tr.seq)
            for i, a in enumerate(live):
                ra = {m[0] for m in a.members}
                for b in live[i + 1 :]:
                    if ra & {m[0] for m in b.members}:
                        continue
                    if math.hypot(a.x - b.x, a.y - b.y) <= MERGE_MM:
                        a.members.extend(b.members)
                        assigned[a.id].extend(assigned.pop(b.id))
                        a.x, a.y = _mean(assigned[a.id])
                        del tracks[b.id]
                        if b.id in born:
                            born.remove(b.id)
                        elif b.id in revived:
                            released.append(b.id)  # its hold (if any) is now a's
                        else:
                            gone.append(b.id)
                        merged = True
                        break
                if merged:
                    break

        self._tracks = tracks
        ordered = sorted(tracks.values(), key=lambda tr: tr.id)
        return FusedFrame(
            targets=tuple(Target(tr.id, tr.x, tr.y) for tr in ordered),
            gone=tuple(sorted(gone)),
            radars={tr.id: frozenset(m[0] for m in tr.members) for tr in ordered},
            born=tuple(sorted(born)),
            dropped=tuple(sorted(released)),
        )


def replay_group(
    own_frames: Sequence[Frame],
    own_zones: Sequence[Zone],
    peers: Sequence[tuple[Sequence[Frame], Sequence[Zone], Affine]] = (),
    reconnect_grace_s: float = 0.0,
) -> list[tuple[float, str, bool]]:
    """Offline equivalent of a group of radars (``home.GroupRuntime``), in the first radar's frame.

    Each radar applies its own exclusions and reconnect grace; the kept
    targets are transformed, tracked and run through one engine with the
    first radar's include zones and every radar's exits and spots. Works for
    a single radar (no peers). Returns transitions like ``replay`` (key
    "presence": the first radar sees anyone). The reference for
    ``frontend/tracker.js`` ``replayGroup``.
    """
    radars = [(own_frames, own_zones, IDENTITY), *peers]
    include = [z for z in own_zones if z.kind == KIND_INCLUDE]
    group_zones = [
        Zone(f"{k}:{z.id}", z.name, z.kind, transform_polygon(a, z.polygon))
        for k, (_, zones, a) in enumerate(radars)
        for z in zones
        if z.kind in (KIND_EXIT, KIND_LINGER, KIND_TRANSIENT)
    ]
    engine = ZoneEngine([*include, *(z for z in group_zones if z.kind == KIND_EXIT)], 0.0)
    tracker = Tracker(group_zones, [invert(a) for _, _, a in radars])
    kept: list[list[Observation]] = [[] for _ in radars]
    available = [True] * len(radars)
    grace_until = [-math.inf] * len(radars)
    exclude = [[z for z in zones if z.kind == KIND_EXCLUDE] for _, zones, _ in radars]
    out: list[tuple[float, str, bool]] = []
    prev = {z.id: False for z in include} | {"presence": False}
    presence = False

    def emit(t: float) -> None:
        cur = {zid: zs.occupied for zid, zs in engine.snapshot().zones.items()} | {"presence": presence}
        for k in prev:
            if cur[k] != prev[k]:
                out.append((t, k, cur[k]))
                prev[k] = cur[k]

    def catch_up(t: float) -> None:
        while (d := _next(engine, tracker)) is not None and d <= t:
            _advance(engine, tracker, d)
            emit(d)

    events = heapq.merge(*([(f.t, k, f) for f in frames] for k, (frames, _, _) in enumerate(radars)), key=lambda e: (e[0], e[1]))
    for t, k, frame in events:
        if frame.available and not available[k]:
            grace_until[k] = t + reconnect_grace_s
        available[k] = frame.available
        a = radars[k][2]
        kept[k] = []
        if t >= grace_until[k]:
            for tg in frame.targets:
                if any(point_in_polygon(tg.x, tg.y, z.polygon) for z in exclude[k]):
                    continue
                x, y = apply(a, tg.x, tg.y)
                kept[k].append(Observation(k, tg.slot, x, y))
        if k == 0:
            presence = bool(kept[0])
        catch_up(t)
        fused = tracker.fuse([o for obs in kept for o in obs], t)
        engine.process(Frame(t, fused.targets, any(available), fused.gone, fused.dropped))
        emit(t)
    catch_up(math.inf)
    return out


def _next(engine: ZoneEngine, tracker: Tracker) -> float | None:
    ds = [d for d in (engine.next_deadline(), tracker.next_deadline()) if d is not None]
    return min(ds) if ds else None


def _advance(engine: ZoneEngine, tracker: Tracker, t: float) -> None:
    """Due deadlines at ``t``: forget lost tracks (releasing their holds), apply delays."""
    dropped = tracker.expire(t)
    if dropped:
        engine.release(t, dropped)
    engine.advance(t)
