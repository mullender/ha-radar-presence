"""Config flow: the home entry, with radars and zones as subentries."""

from __future__ import annotations

from typing import Any
from uuid import uuid4

import voluptuous as vol

from homeassistant.config_entries import (
    SOURCE_USER,
    ConfigEntry,
    ConfigFlow,
    ConfigFlowResult,
    ConfigSubentryFlow,
    FlowType,
    OptionsFlow,
    SubentryFlowContext,
    SubentryFlowResult,
)
from homeassistant.core import callback
from homeassistant.data_entry_flow import FlowResultType
from homeassistant.helpers import area_registry as ar, floor_registry as fr, selector

from .const import (
    CONF_DEVICE_ID,
    CONF_IMPORT_ZONES,
    CONF_PROFILE,
    CONF_RADAR,
    CONF_RECONNECT_GRACE,
    CONF_TARGETS,
    CONF_UNIT,
    CONF_ZONES,
    DOMAIN,
    SUBENTRY_RADAR,
    SUBENTRY_ZONE,
)
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
                    "filters": {"on_delay_s": 0, "off_delay_s": 0, "edge_margin_mm": 0, "hold_until_exit": False, "hold_max_s": 0},
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


DEFAULT_ZONE_POLYGON = [[-500.0, 1000.0], [500.0, 1000.0], [500.0, 2000.0], [-500.0, 2000.0]]


class RadarZonePresenceConfigFlow(ConfigFlow, domain=DOMAIN):
    """The home: one entry; radars and zones are added as subentries."""

    VERSION = 2

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        return self.async_create_entry(
            title=self.hass.config.location_name or "Home", data={}, options={CONF_RECONNECT_GRACE: 0}
        )

    async def async_on_create_entry(self, result: ConfigFlowResult) -> ConfigFlowResult:
        """Go straight on to adding the first radar."""
        sub = await self.hass.config_entries.subentries.async_init(
            (result["result"].entry_id, SUBENTRY_RADAR), context=SubentryFlowContext(source=SOURCE_USER)
        )
        if sub["type"] is FlowResultType.FORM:  # not when there is no radar to add
            result["next_flow"] = (FlowType.CONFIG_SUBENTRIES_FLOW, sub["flow_id"])
        return result

    @classmethod
    @callback
    def async_get_supported_subentry_types(cls, config_entry: ConfigEntry) -> dict[str, type[ConfigSubentryFlow]]:
        return {SUBENTRY_RADAR: RadarSubentryFlow, SUBENTRY_ZONE: ZoneSubentryFlow}

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> OptionsFlow:
        return RadarZonePresenceOptionsFlow()


class RadarSubentryFlow(ConfigSubentryFlow):
    """Add a radar: pick the device; optionally import hand-rolled polygons."""

    def __init__(self) -> None:
        self._radar: RadarDevice | None = None
        self._legacy: list[dict[str, Any]] = []

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> SubentryFlowResult:
        entry = self._get_entry()
        configured = {s.data.get(CONF_DEVICE_ID) for s in entry.subentries.values() if s.subentry_type == SUBENTRY_RADAR}
        radars = {r.device_id: r for r in async_find_radars(self.hass) if r.device_id not in configured}
        if not radars:
            return self.async_abort(reason="no_devices")

        if user_input is not None:
            self._radar = radars[user_input[CONF_DEVICE_ID]]
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

    async def async_step_import_legacy(self, user_input: dict[str, Any] | None = None) -> SubentryFlowResult:
        if user_input is not None:
            return self._create(self._legacy if user_input["import"] else [])
        return self.async_show_form(
            step_id="import_legacy",
            data_schema=vol.Schema({vol.Required("import", default=True): bool}),
            description_placeholders={"count": str(len(self._legacy))},
        )

    def _create(self, zones: list[dict[str, Any]]) -> SubentryFlowResult:
        assert self._radar is not None
        data: dict[str, Any] = {
            CONF_DEVICE_ID: self._radar.device_id,
            CONF_PROFILE: self._radar.profile,
            CONF_TARGETS: self._radar.as_entry_data(),
            CONF_UNIT: _radar_unit(self.hass, self._radar),
            CONF_ZONES: [],
        }
        if zones:
            data[CONF_IMPORT_ZONES] = zones  # become zone subentries when the home reloads
        return self.async_create_entry(title=self._radar.name, data=data, unique_id=self._radar.device_id)


def _zone_schema(hass, radars: dict[str, str], current: dict[str, Any] | None = None) -> vol.Schema:
    current = current or {}
    schema: dict[Any, Any] = {
        vol.Required("name", default=current.get("name", "")): selector.TextSelector(),
    }
    if not current:
        schema[vol.Required(CONF_RADAR)] = selector.SelectSelector(
            selector.SelectSelectorConfig(
                options=[selector.SelectOptionDict(value=k, label=v) for k, v in radars.items()],
                mode=selector.SelectSelectorMode.DROPDOWN,
            )
        )
    area_key = vol.Optional("area_id", description={"suggested_value": current.get("area_id")})
    schema[area_key] = selector.AreaSelector()
    return vol.Schema(schema)


class ZoneSubentryFlow(ConfigSubentryFlow):
    """Add or rename a zone. Its shape is drawn in the Radar Zones panel."""

    def _radars(self) -> dict[str, str]:
        entry = self._get_entry()
        return {sid: s.title for sid, s in entry.subentries.items() if s.subentry_type == SUBENTRY_RADAR}

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> SubentryFlowResult:
        radars = self._radars()
        if not radars:
            return self.async_abort(reason="no_radars")
        if user_input is not None:
            zone_id = f"z{uuid4().hex[:10]}"
            name = user_input["name"].strip() or "Zone"
            return self.async_create_entry(
                title=name,
                unique_id=zone_id,
                data={
                    "id": zone_id,
                    "name": name,
                    "polygon": DEFAULT_ZONE_POLYGON,
                    "filters": {"on_delay_s": 0, "off_delay_s": 0, "edge_margin_mm": 0, "hold_until_exit": False, "hold_max_s": 0},
                    "area_id": user_input.get("area_id"),
                    CONF_RADAR: user_input[CONF_RADAR],
                },
            )
        return self.async_show_form(step_id="user", data_schema=_zone_schema(self.hass, radars))

    async def async_step_reconfigure(self, user_input: dict[str, Any] | None = None) -> SubentryFlowResult:
        entry = self._get_entry()
        sub = self._get_reconfigure_subentry()
        if user_input is not None:
            name = user_input["name"].strip() or sub.data["name"]
            return self.async_update_and_abort(
                entry, sub, title=name, data={**sub.data, "name": name, "area_id": user_input.get("area_id")}
            )
        return self.async_show_form(step_id="reconfigure", data_schema=_zone_schema(self.hass, {}, dict(sub.data)))


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
