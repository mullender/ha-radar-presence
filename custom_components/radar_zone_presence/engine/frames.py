"""Assemble per-entity state updates into consistent radar frames.

The ESPHome firmwares publish each target's X and Y as separate Home Assistant
state updates (X first, Y 0.5–4 ms later), and HA drops updates whose value
did not change. Evaluating zones on every update therefore pairs a new X with
an old Y. Instead we coalesce: the first update after a quiet period opens a
window of ``COALESCE_S``; everything that arrives inside it belongs to one frame.

Pure Python, no Home Assistant imports, so the live engine, the history replay
and the tests share this code.
"""

from __future__ import annotations

from collections.abc import Iterable, Iterator, Mapping
from dataclasses import dataclass, field

COALESCE_S = 0.05

UNIT_TO_MM: dict[str | None, float] = {
    "mm": 1.0,
    "cm": 10.0,
    "m": 1000.0,
    "in": 25.4,
    "ft": 304.8,
    None: 1.0,  # firmware native unit
    "": 1.0,
}


def to_mm(value: float, unit: str | None) -> float:
    try:
        return value * UNIT_TO_MM[unit]
    except KeyError as err:
        raise ValueError(f"unsupported unit {unit!r}") from err


@dataclass(frozen=True, slots=True)
class Target:
    slot: int  # 1-based target slot as reported by the firmware
    x: float  # mm
    y: float  # mm


@dataclass(frozen=True, slots=True)
class Frame:
    t: float  # epoch seconds of the newest update in the frame
    targets: tuple[Target, ...]
    available: bool = True  # False when every coordinate entity is unavailable
    # Slots that disappeared because they merged into another target
    # (multi-radar fusion), not because the person vanished.
    gone: tuple[int, ...] = ()


@dataclass(slots=True)
class TargetEntities:
    slot: int
    x: str
    y: str


def _parse(state: str | None) -> float | None:
    if state is None:
        return None
    try:
        return float(state)
    except (TypeError, ValueError):
        return None  # unavailable / unknown


@dataclass
class FrameAssembler:
    """Holds the latest value of every coordinate entity and builds frames."""

    targets: list[TargetEntities]
    units: Mapping[str, str | None] = field(default_factory=dict)
    _values: dict[str, float | None] = field(default_factory=dict, init=False)
    _pending_since: float | None = field(default=None, init=False)
    _last_update: float = field(default=0.0, init=False)

    def __post_init__(self) -> None:
        self._entity_ids = {e for t in self.targets for e in (t.x, t.y)}

    @property
    def entity_ids(self) -> set[str]:
        return set(self._entity_ids)

    def seed(self, entity_id: str, state: str | None) -> None:
        """Set a value without opening a frame window (initial state)."""
        if entity_id in self._entity_ids:
            self._values[entity_id] = _parse(state)

    def update(self, entity_id: str, state: str | None, t: float) -> bool:
        """Record an update. Returns True if this opened a new frame window."""
        if entity_id not in self._entity_ids:
            return False
        self._values[entity_id] = _parse(state)
        self._last_update = max(self._last_update, t)
        if self._pending_since is None:
            self._pending_since = t
            return True
        return False

    @property
    def pending_since(self) -> float | None:
        return self._pending_since

    def build_at(self, t: float) -> Frame:
        """Build a frame from the current values, stamped at ``t`` (initial state)."""
        self._last_update = t
        return self.build()

    def build(self) -> Frame:
        """Close the current window and return the frame."""
        self._pending_since = None
        targets = []
        any_available = False
        for te in self.targets:
            xv, yv = self._values.get(te.x), self._values.get(te.y)
            if xv is not None or yv is not None:
                any_available = True
            # Empty slot reads (0, 0); y is never 0 for a real target, while
            # x == 0 is a legitimate boresight reading.
            if xv is None or yv is None or yv == 0:
                continue
            targets.append(
                Target(te.slot, to_mm(xv, self.units.get(te.x)), to_mm(yv, self.units.get(te.y)))
            )
        return Frame(self._last_update, tuple(targets), any_available)


def assemble(
    assembler: FrameAssembler,
    events: Iterable[tuple[float, str, str | None]],
    window: float = COALESCE_S,
) -> Iterator[Frame]:
    """Offline equivalent of the live scheduler: events sorted by time."""
    for t, entity_id, state in events:
        pending = assembler.pending_since
        if pending is not None and t > pending + window:
            yield assembler.build()
        assembler.update(entity_id, state, t)
    if assembler.pending_since is not None:
        yield assembler.build()


def pack_frames(frames: Iterable[Frame], t0: float, max_frames: int | None = None) -> dict:
    """Columnar encoding used by the websocket API and the JS engine.

    frame_t: seconds since t0; frame_n: targets per frame; slot/x/y: flattened
    targets (mm, rounded); frame_available: 0/1.
    """
    ft: list[float] = []
    fn: list[int] = []
    avail: list[int] = []
    slot: list[int] = []
    xs: list[int] = []
    ys: list[int] = []
    truncated = False
    for frame in frames:
        if max_frames is not None and len(ft) >= max_frames:
            truncated = True
            break
        ft.append(round(max(frame.t, t0) - t0, 3))
        fn.append(len(frame.targets))
        avail.append(1 if frame.available else 0)
        for tg in frame.targets:
            slot.append(tg.slot)
            xs.append(round(tg.x))
            ys.append(round(tg.y))
    return {
        "start": t0,
        "frame_t": ft,
        "frame_n": fn,
        "frame_available": avail,
        "slot": slot,
        "x": xs,
        "y": ys,
        "truncated": truncated,
    }


def unpack_frames(packed: dict) -> list[Frame]:
    out = []
    p = 0
    for i, t in enumerate(packed["frame_t"]):
        n = packed["frame_n"][i]
        targets = tuple(
            Target(packed["slot"][k], float(packed["x"][k]), float(packed["y"][k])) for k in range(p, p + n)
        )
        p += n
        out.append(Frame(packed["start"] + t, targets, bool(packed["frame_available"][i])))
    return out
