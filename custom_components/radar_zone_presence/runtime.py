"""Live glue between Home Assistant state changes and the engine."""

from __future__ import annotations

import logging
import time
from collections.abc import Callable
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import ATTR_UNIT_OF_MEASUREMENT
from homeassistant.core import CALLBACK_TYPE, Event, EventStateChangedData, HomeAssistant, callback
from homeassistant.helpers.event import async_call_later, async_track_state_change_event

from .const import CONF_RECONNECT_GRACE, CONF_TARGETS, CONF_ZONES
from .discovery import async_resolve_units
from .engine import COALESCE_S, EngineSnapshot, Frame, FrameAssembler, TargetEntities, Zone, ZoneEngine

_LOGGER = logging.getLogger(__name__)

FrameListener = Callable[[Frame, EngineSnapshot], None]


def zones_from_options(options: dict[str, Any]) -> list[Zone]:
    return [Zone.from_dict(z) for z in options.get(CONF_ZONES, [])]


class RadarRuntime:
    """Owns the frame assembler + zone engine for one config entry."""

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        self.hass = hass
        self.entry = entry
        self.targets = [TargetEntities(t["slot"], t["x"], t["y"]) for t in entry.data[CONF_TARGETS]]
        self.zones = zones_from_options(dict(entry.options))
        self.units: dict[str, str | None] = {}
        self.assembler = FrameAssembler(self.targets, units=self.units)
        self.engine = ZoneEngine(self.zones, float(entry.options.get(CONF_RECONNECT_GRACE, 0) or 0))
        self.last_frame: Frame | None = None
        self.snapshot: EngineSnapshot = self.engine.snapshot()
        self._entity_listeners: list[CALLBACK_TYPE] = []
        self._frame_listeners: list[FrameListener] = []
        self._close_listeners: list[CALLBACK_TYPE] = []
        self._unsubs: list[CALLBACK_TYPE] = []
        self._flush_unsub: CALLBACK_TYPE | None = None
        self._deadline_unsub: CALLBACK_TYPE | None = None
        self._deadline = 0.0

    @property
    def entity_ids(self) -> list[str]:
        return sorted(self.assembler.entity_ids)

    @callback
    def async_start(self) -> None:
        self.units.update(async_resolve_units(self.hass, self.assembler.entity_ids))
        for entity_id in self.assembler.entity_ids:
            if (state := self.hass.states.get(entity_id)) is not None:
                self.assembler.seed(entity_id, state.state)
        self._evaluate(self.assembler.build_at(time.time()))
        self._unsubs.append(
            async_track_state_change_event(self.hass, list(self.assembler.entity_ids), self._on_state)
        )

    @callback
    def async_stop(self) -> None:
        for unsub in (*self._unsubs, self._flush_unsub, self._deadline_unsub):
            if unsub:
                unsub()
        self._unsubs.clear()
        self._flush_unsub = self._deadline_unsub = None
        for cb in list(self._close_listeners):
            cb()
        self._close_listeners.clear()
        self._frame_listeners.clear()

    # ------------------------------------------------------------- listeners

    @callback
    def async_add_entity_listener(self, cb: CALLBACK_TYPE) -> CALLBACK_TYPE:
        self._entity_listeners.append(cb)
        return lambda: self._entity_listeners.remove(cb)

    @callback
    def async_add_frame_listener(self, cb: FrameListener) -> CALLBACK_TYPE:
        self._frame_listeners.append(cb)

        def remove() -> None:
            if cb in self._frame_listeners:
                self._frame_listeners.remove(cb)

        return remove

    @callback
    def async_add_close_listener(self, cb: CALLBACK_TYPE) -> CALLBACK_TYPE:
        self._close_listeners.append(cb)

        def remove() -> None:
            if cb in self._close_listeners:
                self._close_listeners.remove(cb)

        return remove

    # ------------------------------------------------------------- internals

    @callback
    def _on_state(self, event: Event[EventStateChangedData]) -> None:
        new = event.data["new_state"]
        entity_id = event.data["entity_id"]
        if new is None:
            opened = self.assembler.update(entity_id, None, time.time())
        else:
            unit = new.attributes.get(ATTR_UNIT_OF_MEASUREMENT)
            if unit is not None and unit != self.units.get(entity_id):
                # Display unit changed (or first real state): re-resolve all siblings.
                self.units[entity_id] = unit
                self.units.update(async_resolve_units(self.hass, self.assembler.entity_ids))
            opened = self.assembler.update(entity_id, new.state, new.last_updated_timestamp)
        if opened:
            self._flush_unsub = async_call_later(self.hass, COALESCE_S, self._flush)

    @callback
    def _flush(self, _now: Any) -> None:
        self._flush_unsub = None
        self._evaluate(self.assembler.build())

    @callback
    def _evaluate(self, frame: Frame) -> None:
        self.last_frame = frame
        self.snapshot = self.engine.process(frame)
        self._publish(frame)
        self._schedule_deadline()

    @callback
    def _schedule_deadline(self) -> None:
        if self._deadline_unsub:
            self._deadline_unsub()
            self._deadline_unsub = None
        deadline = self.engine.next_deadline()
        if deadline is None:
            return
        self._deadline = deadline
        self._deadline_unsub = async_call_later(self.hass, max(0.0, deadline - time.time()), self._on_deadline)

    @callback
    def _on_deadline(self, _now: Any) -> None:
        self._deadline_unsub = None
        # The timer fired, so the deadline is due even if the clocks disagree slightly.
        self.engine.advance(max(time.time(), self._deadline))
        self.snapshot = self.engine.snapshot()
        if self.last_frame is not None:
            self._publish(self.last_frame)
        self._schedule_deadline()

    @callback
    def _publish(self, frame: Frame) -> None:
        for cb in list(self._entity_listeners):
            cb()
        for fl in list(self._frame_listeners):
            try:
                fl(frame, self.snapshot)
            except Exception:  # a broken websocket subscriber must not stop the engine
                _LOGGER.exception("frame listener failed")
