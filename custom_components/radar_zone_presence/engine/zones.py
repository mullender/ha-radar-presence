"""Zone evaluation: exclusion, inclusion, ghost filters.

Pure Python, no Home Assistant imports. Time is passed in explicitly so the
same engine runs live (driven by HA timers) and offline (history replay,
tests). ``frontend/engine.js`` is a line-by-line port used for the editor
preview; ``tests/vectors`` keeps the two in lock-step.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from .frames import Frame, Target
from .geometry import point_in_polygon, signed_distance

KIND_INCLUDE = "include"
KIND_EXCLUDE = "exclude"
KIND_EXIT = "exit"  # an entry/exit point (doorway, stairs); optionally tied to a door sensor


@dataclass(frozen=True, slots=True)
class ZoneFilters:
    on_delay_s: float = 0.0  # occupied must persist this long before turning on
    off_delay_s: float = 0.0  # unoccupied must persist this long before turning off
    edge_margin_mm: float = 0.0  # hysteresis band around the polygon edge
    # Stay occupied until someone is *seen* leaving: a target that vanishes
    # inside the zone (sitting still) is held as an occupant until a target
    # walks out across the edge or (re)appears outside the zone.
    hold_until_exit: bool = False
    # Safety net for hold_until_exit: a held occupant expires after this many
    # seconds (0 = never), in case they left without being seen.
    hold_max_s: float = 0.0

    @classmethod
    def from_dict(cls, d: Mapping[str, Any] | None) -> ZoneFilters:
        d = d or {}
        return cls(
            float(d.get("on_delay_s", 0) or 0),
            float(d.get("off_delay_s", 0) or 0),
            float(d.get("edge_margin_mm", 0) or 0),
            bool(d.get("hold_until_exit", False)),
            float(d.get("hold_max_s", 0) or 0),
        )

    def as_dict(self) -> dict[str, Any]:
        return {
            "on_delay_s": self.on_delay_s,
            "off_delay_s": self.off_delay_s,
            "edge_margin_mm": self.edge_margin_mm,
            "hold_until_exit": self.hold_until_exit,
            "hold_max_s": self.hold_max_s,
        }


@dataclass(frozen=True, slots=True)
class Zone:
    id: str
    name: str
    kind: str
    polygon: tuple[tuple[float, float], ...]
    filters: ZoneFilters = ZoneFilters()
    area_id: str | None = None
    door_entity_id: str | None = None  # exits: the door contact for this opening

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> Zone:
        return cls(
            id=str(d["id"]),
            name=str(d.get("name") or d["id"]),
            kind=d.get("kind", KIND_INCLUDE),
            polygon=tuple((float(p[0]), float(p[1])) for p in d["polygon"]),
            filters=ZoneFilters.from_dict(d.get("filters")),
            area_id=d.get("area_id"),
            door_entity_id=d.get("door_entity_id") or None,
        )

    def as_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "kind": self.kind,
            "polygon": [list(p) for p in self.polygon],
            "filters": self.filters.as_dict(),
            "area_id": self.area_id,
            **({"door_entity_id": self.door_entity_id} if self.door_entity_id else {}),
        }


@dataclass(slots=True)
class _ZoneRuntime:
    raw: bool = False  # occupancy after hysteresis, before delays
    state: bool = False  # published state, after delays
    since: float = 0.0  # when `raw` last changed
    count: int = 0
    slots: tuple[int, ...] = ()
    prev_inside: dict[int, bool] = field(default_factory=dict)  # slot -> inside, previous frame
    prev_exit: set[int] = field(default_factory=set)  # slots standing in an exit, previous frame
    held_since: list[float] = field(default_factory=list)  # vanish times of held occupants, oldest first

    @property
    def held(self) -> int:
        """Occupants that vanished inside and were not seen leaving."""
        return len(self.held_since)


@dataclass(frozen=True, slots=True)
class ZoneSnapshot:
    occupied: bool
    count: int  # targets inside, plus held occupants
    slots: tuple[int, ...]
    held: int = 0


@dataclass(frozen=True, slots=True)
class EngineSnapshot:
    t: float
    zones: Mapping[str, ZoneSnapshot]
    presence: bool
    target_count: int  # targets not excluded
    excluded_count: int
    suppressed: bool  # inside reconnect grace


@dataclass
class ZoneEngine:
    zones: Sequence[Zone]
    reconnect_grace_s: float = 0.0
    _rt: dict[str, _ZoneRuntime] = field(default_factory=dict, init=False)
    _presence: _ZoneRuntime = field(default_factory=_ZoneRuntime, init=False)
    _available: bool = field(default=True, init=False)
    _grace_until: float = field(default=float("-inf"), init=False)
    _last_t: float = field(default=0.0, init=False)
    _target_count: int = field(default=0, init=False)
    _excluded_count: int = field(default=0, init=False)

    def __post_init__(self) -> None:
        self.include = [z for z in self.zones if z.kind == KIND_INCLUDE]
        self.exclude = [z for z in self.zones if z.kind == KIND_EXCLUDE]
        self.exits = [z for z in self.zones if z.kind == KIND_EXIT]
        self._rt = {z.id: _ZoneRuntime() for z in self.include}

    # ------------------------------------------------------------------ input

    def excluded(self, target: Target) -> bool:
        return any(point_in_polygon(target.x, target.y, z.polygon) for z in self.exclude)

    def process(self, frame: Frame) -> EngineSnapshot:
        t = frame.t
        self.advance(t)
        if frame.available and not self._available:
            self._grace_until = t + self.reconnect_grace_s
        self._available = frame.available

        targets: Iterable[Target] = frame.targets
        if t < self._grace_until:
            targets = ()
        kept = [tg for tg in targets if not self.excluded(tg)]
        exit_slots = {tg.slot for tg in kept if any(point_in_polygon(tg.x, tg.y, e.polygon) for e in self.exits)}
        self._target_count = len(kept)
        self._excluded_count = len(frame.targets) - len(kept) if t >= self._grace_until else 0

        for zone in self.include:
            rt = self._rt[zone.id]
            m = zone.filters.edge_margin_mm
            if m > 0:
                # Entering needs to be m inside the edge; staying needs to be
                # no more than m outside it.
                threshold = -m if rt.raw else m
                inside = [tg for tg in kept if signed_distance(tg.x, tg.y, zone.polygon) >= threshold]
            else:
                inside = [tg for tg in kept if point_in_polygon(tg.x, tg.y, zone.polygon)]
            rt.slots = tuple(tg.slot for tg in inside)
            if zone.filters.hold_until_exit and t >= self._grace_until:
                self._update_hold(rt, kept, set(rt.slots), exit_slots, t)
            elif not zone.filters.hold_until_exit:
                rt.held_since.clear()
            rt.count = len(inside) + rt.held
            self._set_raw(rt, bool(inside) or rt.held > 0, t, zone.filters)

        self._set_raw(self._presence, bool(kept), t, ZoneFilters())
        self._presence.count = len(kept)
        self._last_t = t
        return self.snapshot()

    @staticmethod
    def _update_hold(rt: _ZoneRuntime, kept: list[Target], inside_slots: set[int], exit_slots: set[int], t: float) -> None:
        cur = {tg.slot: tg.slot in inside_slots for tg in kept}
        for slot, was_inside in rt.prev_inside.items():
            if was_inside and slot not in cur and slot not in rt.prev_exit:
                rt.held_since.append(t)  # vanished inside (not in an exit): still there, just not detected
        for slot in cur:
            if slot not in rt.prev_inside and rt.held_since and slot not in exit_slots:
                # A target (re)appeared: inside = the held person re-detected;
                # outside = they left without being seen crossing the edge.
                # Appearing in an exit is someone new coming in.
                rt.held_since.pop(0)
        rt.prev_inside = cur
        rt.prev_exit = exit_slots

    @staticmethod
    def _expire_holds(rt: _ZoneRuntime, t: float, f: ZoneFilters) -> None:
        if f.hold_max_s <= 0:
            return
        while rt.held_since and rt.held_since[0] + f.hold_max_s <= t + 1e-6:
            expired_at = rt.held_since.pop(0) + f.hold_max_s
            rt.count -= 1
            raw = bool(rt.slots) or bool(rt.held_since)
            if raw != rt.raw:
                rt.raw = raw
                rt.since = expired_at

    def advance(self, t: float) -> None:
        """Apply delayed transitions that are due at time ``t``."""
        for zone in self.include:
            rt = self._rt[zone.id]
            self._expire_holds(rt, t, zone.filters)
            self._apply_delay(rt, t, zone.filters)
        self._last_t = max(self._last_t, t)

    def next_deadline(self) -> float | None:
        """Earliest time at which a delayed transition becomes due."""
        best = None
        for zone in self.include:
            rt = self._rt[zone.id]
            if rt.raw != rt.state:
                delay = zone.filters.on_delay_s if rt.raw else zone.filters.off_delay_s
                d = rt.since + delay
                best = d if best is None else min(best, d)
            if rt.held_since and zone.filters.hold_max_s > 0:
                d = rt.held_since[0] + zone.filters.hold_max_s
                best = d if best is None else min(best, d)
        return best

    # --------------------------------------------------------------- internals

    def _set_raw(self, rt: _ZoneRuntime, raw: bool, t: float, f: ZoneFilters) -> None:
        if raw != rt.raw:
            rt.raw = raw
            rt.since = t
        self._apply_delay(rt, t, f)

    @staticmethod
    def _apply_delay(rt: _ZoneRuntime, t: float, f: ZoneFilters) -> None:
        if rt.raw == rt.state:
            return
        delay = f.on_delay_s if rt.raw else f.off_delay_s
        if t - rt.since >= delay - 1e-6:  # tolerance: deadlines are computed as since + delay
            rt.state = rt.raw

    # ----------------------------------------------------------------- output

    def snapshot(self) -> EngineSnapshot:
        return EngineSnapshot(
            t=self._last_t,
            zones={
                z.id: ZoneSnapshot(self._rt[z.id].state, self._rt[z.id].count, self._rt[z.id].slots, self._rt[z.id].held)
                for z in self.include
            },
            presence=self._presence.state,
            target_count=self._target_count,
            excluded_count=self._excluded_count,
            suppressed=self._last_t < self._grace_until,
        )


def replay(engine: ZoneEngine, frames: Iterable[Frame]) -> list[tuple[float, str, bool]]:
    """Run frames through the engine; return (t, zone_id | "presence", state) transitions."""
    out: list[tuple[float, str, bool]] = []
    prev: dict[str, bool] = {z.id: False for z in engine.include}
    prev["presence"] = False

    def emit(snap: EngineSnapshot, t: float) -> None:
        cur = {zid: zs.occupied for zid, zs in snap.zones.items()}
        cur["presence"] = snap.presence
        for k, v in cur.items():
            if v != prev[k]:
                out.append((t, k, v))
                prev[k] = v

    for frame in frames:
        # Fire any delayed transitions that fall between frames at their own time.
        while (d := engine.next_deadline()) is not None and d <= frame.t:
            engine.advance(d)
            emit(engine.snapshot(), d)
        emit(engine.process(frame), frame.t)
    while (d := engine.next_deadline()) is not None:
        engine.advance(d)
        emit(engine.snapshot(), d)
    return out
