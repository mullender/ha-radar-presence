"""Answers to the To do questions, kept on the server so another browser does not ask again.

{key: {"answer": str, "t": epoch s}}. Keys are made by the panel, e.g.
"<radar id>:spot:<x>,<y>" for "What is here?" about a place, or
"layout:no-doorway:<area>" for a layout check. Not per user: the home's set-up
is shared.
"""

from __future__ import annotations

import time
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers.storage import Store

from .const import DOMAIN

STORE_VERSION = 1
MAX_ANSWERS = 2000


class TodoAnswers:
    def __init__(self, hass: HomeAssistant) -> None:
        self._store: Store[dict[str, Any]] = Store(hass, STORE_VERSION, f"{DOMAIN}.todo")
        self.answers: dict[str, dict[str, Any]] = {}
        self.meta: dict[str, Any] = {}
        self._loaded = False

    async def async_load(self) -> None:
        if self._loaded:
            return
        data = await self._store.async_load() or {}
        self.answers = dict(data.get("answers") or {})
        self.meta = dict(data.get("meta") or {})
        self._loaded = True

    def set(self, key: str, answer: str | None) -> None:
        if answer is None:
            self.answers.pop(key, None)
        else:
            self.answers[key] = {"answer": answer, "t": round(time.time(), 1)}
            if len(self.answers) > MAX_ANSWERS:  # oldest first out
                for k in sorted(self.answers, key=lambda k: self.answers[k]["t"])[: len(self.answers) - MAX_ANSWERS]:
                    del self.answers[k]
        self._store.async_delay_save(lambda: {"answers": self.answers, "meta": self.meta}, 1.0)

    def set_meta(self, key: str, value: Any) -> None:
        self.meta[key] = value
        self._store.async_delay_save(lambda: {"answers": self.answers, "meta": self.meta}, 1.0)


async def async_get_todo(hass: HomeAssistant) -> TodoAnswers:
    store: TodoAnswers | None = hass.data.setdefault(DOMAIN, {}).get("todo")
    if store is None:
        store = TodoAnswers(hass)
        hass.data[DOMAIN]["todo"] = store
    await store.async_load()
    return store
