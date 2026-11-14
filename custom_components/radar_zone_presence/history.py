"""Rebuild frames and zone events from the recorder.

Uses the same FrameAssembler as the live engine, so the point cloud and the
replay show exactly what the engine would have seen.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from homeassistant.components.recorder import get_instance, history
from homeassistant.core import HomeAssistant, State

from .discovery import async_resolve_units
from .engine import FrameAssembler, TargetEntities, assemble
from .engine.frames import pack_frames

# Hard cap to keep websocket payloads sane (~48 h of a busy EP Lite is ~100k frames).
MAX_FRAMES = 400_000


def _state_rows(rows: list[State | dict[str, Any]]) -> list[tuple[float, str]]:
    out = []
    for r in rows:
        if isinstance(r, State):
            out.append((r.last_updated_timestamp, r.state))
        else:  # minimal_response dicts
            ts = r.get("last_updated") or r.get("last_changed")
            if isinstance(ts, str):
                ts = datetime.fromisoformat(ts).timestamp()
            elif isinstance(ts, datetime):
                ts = ts.timestamp()
            out.append((float(ts), r["state"]))
    return out


def _fetch(hass: HomeAssistant, start: datetime, end: datetime, entity_ids: list[str]) -> dict[str, list]:
    return history.get_significant_states(
        hass,
        start,
        end,
        entity_ids,
        include_start_time_state=True,
        significant_changes_only=False,
        minimal_response=False,
        no_attributes=True,
    )


async def async_history_frames(
    hass: HomeAssistant,
    targets: list[TargetEntities],
    start: datetime,
    end: datetime,
    unit_fallback: str | None = None,
) -> dict[str, Any]:
    """Packed frames: parallel arrays t (s since start), slot, x, y (mm, rounded)."""
    entity_ids = sorted({e for t in targets for e in (t.x, t.y)})
    raw = await get_instance(hass).async_add_executor_job(_fetch, hass, start, end, entity_ids)

    units = async_resolve_units(hass, entity_ids, unit_fallback)

    def build() -> dict[str, Any]:
        events: list[tuple[float, str, str]] = []
        for eid, rows in raw.items():
            events.extend((t, eid, s) for t, s in _state_rows(rows))
        events.sort(key=lambda e: e[0])
        asm = FrameAssembler(targets, units=units)
        packed = pack_frames(assemble(asm, events), start.timestamp(), MAX_FRAMES)
        packed["end"] = end.timestamp()
        return packed

    return await hass.async_add_executor_job(build)


async def async_zone_events(
    hass: HomeAssistant, entity_ids: list[str], start: datetime, end: datetime
) -> dict[str, list[tuple[float, str]]]:
    """Recorded on/off history of our own zone entities."""
    if not entity_ids:
        return {}
    raw = await get_instance(hass).async_add_executor_job(_fetch, hass, start, end, entity_ids)
    return {eid: _state_rows(rows) for eid, rows in raw.items()}
