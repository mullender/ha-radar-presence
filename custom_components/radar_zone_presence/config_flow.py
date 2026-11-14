"""Config flow: pick a radar device; optionally import hand-rolled polygons."""

from __future__ import annotations

from typing import Any
from uuid import uuid4

import voluptuous as vol

from homeassistant.config_entries import ConfigEntry, ConfigFlow, ConfigFlowResult, OptionsFlow
from homeassistant.core import callback
from homeassistant.helpers import area_registry as ar, floor_registry as fr, selector

from .const import CONF_DEVICE_ID, CONF_PROFILE, CONF_RECONNECT_GRACE, CONF_TARGETS, CONF_UNIT, CONF_ZONES, DOMAIN
from .discovery import RadarDevice, async_find_radars, async_legacy_polygons, async_resolve_units, common_unit
from .engine import KIND_INCLUDE, validate_polygon


def _radar_unit(hass, radar: RadarDevice) -> str | None:
    return common_unit(async_resolve_units(hass, [e for t in radar.targets for e in (t.x, t.y)]))


def _legacy_zones(flow_hass, radar: RadarDevice) -> list[dict[str, Any]]:
    unit = _radar_unit(flow_hass, radar)
    zones = []
    for p in async_legacy_polygons(flow_hass, radar.slug, unit):
        if validate_polygon(p["polygon"]) is None:
            zones.append(
                {
                    "id": f"z{uuid4().hex[:10]}",
                    "name": f"Polygon {p['n']}",
                    "kind": KIND_INCLUDE,
                    "polygon": p["polygon"],
                    "filters": {"on_delay_s": 0, "off_delay_s": 0, "edge_margin_mm": 0},
                    "area_id": None,
                }
            )
    return zones


def _live_targets(hass, radar: RadarDevice) -> int | None:
    """Targets the radar reports right now (y != 0), or None when it is offline."""
    count = 0
    online = False
    for t in radar.targets:
        state = hass.states.get(t.y)
        try:
            y = float(state.state) if state else None
        except ValueError:
            y = None
        if y is None:
            continue
        online = True
        count += y != 0
    return count if online else None


def _radar_label(hass, radar: RadarDevice) -> str:
    """'Name — Area (Floor) · 1 target now' for the device picker."""
    parts = [radar.name]
    area = ar.async_get(hass).async_get_area(radar.area_id) if radar.area_id else None
    if area:
        floor = fr.async_get(hass).async_get_floor(area.floor_id) if area.floor_id else None
        parts.append(f"— {area.name}" + (f" ({floor.name})" if floor else ""))
    live = _live_targets(hass, radar)
    details = ["offline" if live is None else f"{live} target{'s' if live != 1 else ''} now"]
    return " ".join(parts) + " · " + " · ".join(details)


class RadarZonePresenceConfigFlow(ConfigFlow, domain=DOMAIN):
    VERSION = 1

    def __init__(self) -> None:
        self._radar: RadarDevice | None = None
        self._legacy: list[dict[str, Any]] = []

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        configured = {e.data[CONF_DEVICE_ID] for e in self._async_current_entries()}
        radars = {r.device_id: r for r in async_find_radars(self.hass) if r.device_id not in configured}
        if not radars:
            return self.async_abort(reason="no_devices")

        if user_input is not None:
            self._radar = radars[user_input[CONF_DEVICE_ID]]
            await self.async_set_unique_id(self._radar.device_id)
            self._abort_if_unique_id_configured()
            self._legacy = _legacy_zones(self.hass, self._radar)
            if self._legacy:
                return await self.async_step_import_legacy()
            return self._create([])

        options = [selector.SelectOptionDict(value=r.device_id, label=_radar_label(self.hass, r)) for r in radars.values()]
        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema(
                {
                    vol.Required(CONF_DEVICE_ID): selector.SelectSelector(
                        selector.SelectSelectorConfig(options=options, mode=selector.SelectSelectorMode.LIST)
                    )
                }
            ),
        )

    async def async_step_import_legacy(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        if user_input is not None:
            return self._create(self._legacy if user_input["import"] else [])
        return self.async_show_form(
            step_id="import_legacy",
            data_schema=vol.Schema({vol.Required("import", default=True): bool}),
            description_placeholders={"count": str(len(self._legacy))},
        )

    def _create(self, zones: list[dict[str, Any]]) -> ConfigFlowResult:
        assert self._radar is not None
        return self.async_create_entry(
            title=self._radar.name,
            data={
                CONF_DEVICE_ID: self._radar.device_id,
                CONF_PROFILE: self._radar.profile,
                CONF_TARGETS: self._radar.as_entry_data(),
                CONF_UNIT: _radar_unit(self.hass, self._radar),
            },
            options={CONF_ZONES: zones, CONF_RECONNECT_GRACE: 0},
        )

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> OptionsFlow:
        return RadarZonePresenceOptionsFlow()


class RadarZonePresenceOptionsFlow(OptionsFlow):
    """Engine-wide settings. Zones are edited in the Radar Zones panel."""

    async def async_step_init(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        if user_input is not None:
            return self.async_create_entry(data={**self.config_entry.options, **user_input})
        return self.async_show_form(
            step_id="init",
            data_schema=vol.Schema(
                {
                    vol.Required(
                        CONF_RECONNECT_GRACE,
                        default=self.config_entry.options.get(CONF_RECONNECT_GRACE, 0),
                    ): selector.NumberSelector(
                        selector.NumberSelectorConfig(
                            min=0, max=600, step=1, unit_of_measurement="s", mode=selector.NumberSelectorMode.BOX
                        )
                    )
                }
            ),
        )
