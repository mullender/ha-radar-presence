"""Import-only config flow so the simulator can own devices."""

from homeassistant.config_entries import ConfigFlow

from . import DOMAIN


class RadarSimConfigFlow(ConfigFlow, domain=DOMAIN):
    VERSION = 1

    async def async_step_import(self, data):
        await self.async_set_unique_id(DOMAIN)
        self._abort_if_unique_id_configured(updates=data)
        return self.async_create_entry(title="Radar simulator", data=data)
