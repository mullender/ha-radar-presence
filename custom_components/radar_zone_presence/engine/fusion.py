"""Fuse the targets of several aligned radars into one set of tracks.

Each radar reports up to three targets in numbered slots. Within a group of
aligned radars the same person is often seen by two of them at once, a few
hundred millimetres apart (alignment error, different reflection points).
Counting both would double the zone count, and when one radar loses the
person the zone engine would see a "vanish" and hold a phantom occupant.

The fuser turns per-radar observations (already transformed into the
group's frame) into tracks with stable integer ids, used as slots by the
zone engine:

- An observation keeps the track its (radar, slot) belonged to last frame,
  so each radar's own slot continuity is preserved.
- A new observation joins a nearby track (``MERGE_MM``) that has no
  observation from the same radar yet; otherwise it starts a new track.
- Two tracks from different radars that come within ``MERGE_MM`` merge into
  the older one; the other id is reported in ``gone`` so the engine does not
  treat it as a vanish.
- A radar slot that jumps far (``SPLIT_MM``) from the other observations of
  its track is split off into a new track.
- A track that loses one of its radars and lands far (``JUMP_MM``) from where
  it was is a different person on the remaining radar, not a hand-over: it
  becomes a new track.

Track ids are ``10 * radar_index + slot`` when free, so with a single radar
the fuser is the identity (slot in, same slot out). ``frontend/fusion.js`` is
a line-by-line port.
"""

from __future__ import annotations

import heapq
import math
from collections.abc import Sequence
from dataclasses import dataclass, field

from .align import IDENTITY, Affine, apply, transform_polygon
from .frames import Frame, Target
from .geometry import point_in_polygon
from .zones import KIND_EXCLUDE, KIND_EXIT, KIND_INCLUDE, Zone, ZoneEngine

MERGE_MM = 600.0
SPLIT_MM = 1200.0
JUMP_MM = 800.0
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


@dataclass(frozen=True, slots=True)
class FusedFrame:
    targets: tuple[Target, ...]  # slot = track id
    gone: tuple[int, ...]  # track ids merged away this frame
    radars: dict[int, frozenset[int]]  # track id -> radar indexes that see it


class Fuser:
    def __init__(self) -> None:
        self._tracks: dict[int, _Track] = {}
        self._seq = 0

    def _new_id(self, radar: int, slot: int, used: set[int]) -> int:
        tid = 10 * radar + slot
        if tid in used or tid >= _FIRST_FREE_ID:
            tid = _FIRST_FREE_ID
            while tid in used:
                tid += 1
        return tid

    def fuse(self, observations: Sequence[Observation]) -> FusedFrame:
        owner = {m: tr.id for tr in self._tracks.values() for m in tr.members}
        assigned: dict[int, list[Observation]] = {}
        unassigned: list[Observation] = []
        for o in observations:
            tid = owner.get((o.radar, o.slot))
            if tid is None:
                unassigned.append(o)
            else:
                assigned.setdefault(tid, []).append(o)

        # Split off observations that jumped away from their track's oldest member.
        for tid, obs in assigned.items():
            if len(obs) < 2:
                continue
            order = {m: i for i, m in enumerate(self._tracks[tid].members)}
            obs.sort(key=lambda o: order.get((o.radar, o.slot), len(order)))
            keep = [obs[0]]
            for o in obs[1:]:
                if math.hypot(o.x - obs[0].x, o.y - obs[0].y) > SPLIT_MM:
                    unassigned.append(o)
                else:
                    keep.append(o)
            assigned[tid] = keep

        # A track that lost a radar and whose remaining observations are far from
        # where it was did not hand over: the other radar's slot is someone else
        # (or it was reassigned). Start over so the engine sees the old one vanish.
        for tid in list(assigned):
            old, obs = self._tracks[tid], assigned[tid]
            lost = len({o.radar for o in obs}) < len({m[0] for m in old.members})
            if lost:
                x = sum(o.x for o in obs) / len(obs)
                y = sum(o.y for o in obs) / len(obs)
                if math.hypot(x - old.x, y - old.y) > JUMP_MM:
                    unassigned.extend(assigned.pop(tid))

        tracks: dict[int, _Track] = {}
        for tid, obs in assigned.items():
            old = self._tracks[tid]
            tracks[tid] = _Track(tid, old.seq, [m for m in old.members if any((o.radar, o.slot) == m for o in obs)])

        def place(tr: _Track, obs: list[Observation]) -> None:
            tr.x = sum(o.x for o in obs) / len(obs)
            tr.y = sum(o.y for o in obs) / len(obs)

        for tid, obs in assigned.items():
            place(tracks[tid], obs)

        # New observations: join a nearby track without this radar, else start one.
        unassigned.sort(key=lambda o: (o.radar, o.slot))
        for o in unassigned:
            best, best_d = None, MERGE_MM
            for tr in tracks.values():
                if any(m[0] == o.radar for m in tr.members):
                    continue
                d = math.hypot(tr.x - o.x, tr.y - o.y)
                if d <= best_d:
                    best, best_d = tr, d
            if best is not None:
                obs = assigned.setdefault(best.id, [])
                obs.append(o)
                best.members.append((o.radar, o.slot))
                place(best, obs)
            else:
                tid = self._new_id(o.radar, o.slot, set(tracks) | set(self._tracks))
                self._seq += 1
                tr = _Track(tid, self._seq, [(o.radar, o.slot)], o.x, o.y)
                tracks[tid] = tr
                assigned[tid] = [o]

        # Merge tracks of different radars that converged on the same person.
        gone: list[int] = []
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
                        place(a, assigned[a.id])
                        del tracks[b.id]
                        if b.id in self._tracks:
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
        )


def replay_group(
    own_frames: Sequence[Frame],
    own_zones: Sequence[Zone],
    peers: Sequence[tuple[Sequence[Frame], Sequence[Zone], Affine]] = (),
    reconnect_grace_s: float = 0.0,
) -> list[tuple[float, str, bool]]:
    """Offline equivalent of a group of radars (``home.GroupRuntime``), in the first radar's frame.

    Each radar applies its own exclusions and reconnect grace; the kept
    targets are transformed, fused and run through one engine with the first
    radar's include zones and every radar's exits. Returns transitions like
    ``replay`` (key "presence": the first radar sees anyone). The reference
    for ``frontend/fusion.js`` ``replayGroup``.
    """
    radars = [(own_frames, own_zones, IDENTITY), *peers]
    include = [z for z in own_zones if z.kind == KIND_INCLUDE]
    exits = [
        Zone(f"{k}:{z.id}", z.name, KIND_EXIT, transform_polygon(a, z.polygon))
        for k, (_, zones, a) in enumerate(radars)
        for z in zones
        if z.kind == KIND_EXIT
    ]
    engine = ZoneEngine([*include, *exits], 0.0)
    fuser = Fuser()
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
        while (d := engine.next_deadline()) is not None and d <= t:
            engine.advance(d)
            emit(d)
        fused = fuser.fuse([o for obs in kept for o in obs])
        engine.process(Frame(t, fused.targets, any(available), fused.gone))
        emit(t)
    while (d := engine.next_deadline()) is not None:
        engine.advance(d)
        emit(d)
    return out
