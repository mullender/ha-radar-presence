"""'Learning finished': tell the user once when a radar has suggestions in To do.

A new radar learns for a few days: where things stay (a seat, a bed, a fan).
The panel's To do tab works out the suggestions from the recorded history; this
keeps a coarse live tally (30 cm cells, seconds a target spent in each) so the
server knows when there is something to look at without the panel open. When a
radar has learned for 3 days and has at least 2 places where something stays
that no spot or ignore area covers yet, or after a week with at least one, a
persistent notification links to To do. Once per radar.

The tally lives in the To do store's meta ("learning": {radar id: {...}}).
"""

from __future__ import annotations

import logging
import time
from datetime import timedelta
from typing import TYPE_CHECKING, Any

from homeassistant.components import persistent_notification
from homeassistant.core import CALLBACK_TYPE, HomeAssistant, callback
from homeassistant.helpers.event import async_track_time_interval

from .const import DOMAIN
from .engine.geometry import point_in_polygon, polygon_area
from .engine.zones import KIND_EXCLUDE, KIND_INCLUDE, KIND_LINGER

if TYPE_CHECKING:
    from .home import HomeRuntime
    from .todo import TodoAnswers

_LOGGER = logging.getLogger(__name__)

CELL_MM = 300
MAX_STEP_S = 30.0  # a radar reports on change; a target sitting very still may not change for a while
DAY = 86400
MIN_DAYS = 3
MAX_DAYS = 7
MIN_PLACES = 2
PLACE_S_PER_DAY = 15 * 60  # a place counts when something stays there 15 min a day on average
MAX_PLACES = 6
SAVE_EVERY_S = 600
CHECK_EVERY = timedelta(hours=1)
PANEL_URL = "/radar-zones#view=todo"
SPOT_MAX_MM2 = 6e6  # as the panel's To do: a room shape under 6 m² beside a bigger room is a spot in all but name


def spot_like(rooms: list[tuple[tuple[float, float], ...]]) -> list[tuple[tuple[float, float], ...]]:
    """Room shapes that are spots in all but name (older spots were drawn as rooms, "Desk"):
    inside another room shape, or small beside a much bigger one."""
    size = [abs(polygon_area(p)) for p in rooms]
    out = []
    for i, p in enumerate(rooms):
        nested = any(
            j != i and size[j] > size[i] and sum(point_in_polygon(x, y, q) for x, y in p) >= 0.75 * len(p)
            for j, q in enumerate(rooms)
        )
        if nested or (size[i] < SPOT_MAX_MM2 and any(sz > 2 * size[i] for sz in size)):
            out.append(p)
    return out


def places(grid: dict[str, float], days: float, covered: list[tuple[tuple[float, float], ...]]) -> list[dict[str, Any]]:
    """Clusters of neighbouring cells where something stayed, biggest first, not inside `covered` polygons."""
    cells = {tuple(int(v) for v in k.split(",")): s for k, s in grid.items()}
    floor = PLACE_S_PER_DAY * max(days, 1) / 9  # a cell needs a share of a place's time to be part of it
    hot = {c for c, s in cells.items() if s >= floor}
    out = []
    seen: set[tuple[int, int]] = set()
    for start in hot:
        if start in seen:
            continue
        stack, cluster = [start], []
        seen.add(start)
        while stack:
            i, j = stack.pop()
            cluster.append((i, j))
            for di in (-1, 0, 1):
                for dj in (-1, 0, 1):
                    n = (i + di, j + dj)
                    if n in hot and n not in seen:
                        seen.add(n)
                        stack.append(n)
        total = sum(cells[c] for c in cluster)
        if total < PLACE_S_PER_DAY * max(days, 1):
            continue
        cx = sum((i + 0.5) * CELL_MM * cells[(i, j)] for i, j in cluster) / total
        cy = sum((j + 0.5) * CELL_MM * cells[(i, j)] for i, j in cluster) / total
        if any(point_in_polygon(cx, cy, poly) for poly in covered):
            continue
        out.append({"x": round(cx), "y": round(cy), "s": round(total), "cells": len(cluster)})
    out.sort(key=lambda p: -p["s"])
    return out[:MAX_PLACES]


class Learning:
    def __init__(self, hass: HomeAssistant, runtime: HomeRuntime, store: TodoAnswers) -> None:
        self.hass = hass
        self.runtime = runtime
        self.store = store
        self.state: dict[str, dict[str, Any]] = store.meta.setdefault("learning", {})
        self._prev: dict[str, tuple[float, tuple[tuple[float, float], ...]]] = {}
        self._last_save = time.time()
        self._unsubs: list[CALLBACK_TYPE] = []

    def _radar(self, radar_id: str) -> dict[str, Any]:
        st = self.state.get(radar_id)
        if st is None:
            st = self.state[radar_id] = {"since": round(time.time()), "grid": {}, "notified": None}
        return st

    @callback
    def async_start(self) -> None:
        for rid in self.runtime.feeds:
            self._radar(rid)
        for rid in list(self.state):  # radars removed since
            if rid not in self.runtime.feeds:
                del self.state[rid]
        self._unsubs.append(async_track_time_interval(self.hass, self._check, CHECK_EVERY))

    @callback
    def async_stop(self) -> None:
        for unsub in self._unsubs:
            unsub()
        self._unsubs.clear()
        self._save()

    @callback
    def observe(self, radar_id: str, t: float, targets: tuple[Any, ...]) -> None:
        """A radar's kept targets at t: the previous frame's targets stayed where they were until now."""
        st = self._radar(radar_id)
        prev = self._prev.get(radar_id)
        self._prev[radar_id] = (t, tuple((tg.x, tg.y) for tg in targets))
        if st.get("notified") or prev is None:
            return
        dt = min(max(t - prev[0], 0.0), MAX_STEP_S)
        if not dt:
            return
        grid = st["grid"]
        for x, y in prev[1]:
            key = f"{int(x // CELL_MM)},{int(y // CELL_MM)}"
            grid[key] = round(grid.get(key, 0.0) + dt, 1)
        if t - self._last_save > SAVE_EVERY_S:
            self._save()

    def _save(self) -> None:
        self._last_save = time.time()
        self.store.set_meta("learning", self.state)

    def covered(self, radar_id: str) -> list[tuple[tuple[float, float], ...]]:
        """Spots and ignore areas of a radar (its own frame): places already answered."""
        feed = self.runtime.feeds[radar_id]
        polys = [z.polygon for z in feed.zones if z.kind in (KIND_EXCLUDE, KIND_LINGER)]
        polys += [zd.zone.polygon for zd in self.runtime.zones.values() if zd.radar_id == radar_id and zd.spot]
        rooms = [zd.zone.polygon for zd in self.runtime.zones.values() if zd.radar_id == radar_id and not zd.spot and zd.zone.kind == KIND_INCLUDE]
        return polys + spot_like(rooms)

    def places(self, radar_id: str, now: float | None = None) -> list[dict[str, Any]]:
        st = self._radar(radar_id)
        days = ((now or time.time()) - st["since"]) / DAY
        found = places(st["grid"], days, self.covered(radar_id))
        answers = self.store.answers  # "What is here?" answered in To do or the radar view
        return [p for p in found if f"{radar_id}:spot:{round(p['x'] / 300)},{round(p['y'] / 300)}" not in answers]

    @callback
    def _check(self, _now: Any = None) -> None:
        now = time.time()
        for rid in self.runtime.feeds:
            st = self._radar(rid)
            if st.get("notified"):
                continue
            days = (now - st["since"]) / DAY
            if days < MIN_DAYS:
                continue
            found = self.places(rid, now)
            if len(found) >= MIN_PLACES or (days >= MAX_DAYS and found):
                self._notify(rid, len(found))
                st["notified"] = round(now)
                st["grid"] = {}
            elif days >= MAX_DAYS:
                st["notified"] = round(now)  # nothing to suggest: done learning quietly
                st["grid"] = {}
        self._save()

    def _notify(self, radar_id: str, n: int) -> None:
        feed = self.runtime.feeds[radar_id]
        where = self._area_name(feed.device_id) or feed.title
        persistent_notification.async_create(
            self.hass,
            f"Radar Presence has {n} suggestion{'s' if n != 1 else ''} for the {where.lower()}: places where "
            f"someone or something stays. [Review]({PANEL_URL})",
            title="Learning finished",
            notification_id=f"{DOMAIN}_learned_{radar_id}",
        )

    def _area_name(self, device_id: str) -> str | None:
        from homeassistant.helpers import area_registry as ar, device_registry as dr

        dev = dr.async_get(self.hass).async_get(device_id)
        area = ar.async_get(self.hass).async_get_area(dev.area_id) if dev and dev.area_id else None
        return area.name if area else None


