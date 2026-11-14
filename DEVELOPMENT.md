# Development setup

How to run and debug the `radar_zone_presence` custom integration. Modelled
on [ha-tides](https://github.com/mullender/ha-tides/blob/main/DEVELOPMENT.md).

## 1. Prerequisites

- macOS 13+ or Linux.
- Docker Desktop, OrbStack, or Colima.
- Node.js 20+ (frontend build, CDP helper scripts).
- VS Code with the "Python" extension.

Python is not needed on the host; the HA container ships it.

## 2. HA in Docker with the component mounted

`docker-compose.yml` runs `ghcr.io/home-assistant/home-assistant:dev` as
`ha_radar_dev`, with `custom_components/` bind-mounted. Ports are offset from
ha-tides so both can run at once:

| Host | Container | Use |
|---|---|---|
| 8124 | 8123 | Home Assistant UI |
| 5679 | 5678 | debugpy |

First run:

```
mkdir -p ha_config && cp dev/configuration.yaml ha_config/
docker compose up -d
docker compose logs -f homeassistant
```

Open <http://localhost:8124> and complete onboarding.

`ha_config/` is gitignored; it holds the running HA config and storage.

## 3. Reload cadence

- **Engine or entity code** — Settings → Devices & Services → entry → ⋮ →
  *Reload*.
- **`manifest.json`, `config_flow.py`, new platforms** —
  `docker compose restart homeassistant`.
- **Frontend bundle** — rebuild, then hard-reload the browser with the
  Network panel's *Disable cache* on.

## 4. Debugging

`dev/configuration.yaml` enables `debugpy` and debug logging for the
integration. Attach with the *Attach to Home Assistant* config in
`.vscode/launch.json` (port 5679). Set `wait: true` under `debugpy:` to catch
startup code.

Logs: `docker compose logs -f homeassistant | grep radar_zone_presence`.

## 5. Realistic data without a radar

The dev container has no radar. Planned for M1 (see DESIGN.md §10):

1. Export target history from production through the CDP browser into
   `tests/fixtures/` (frames in mm, per sensor).
2. A dev-only simulator replays those fixtures into fake
   `sensor.*_target_<n>_x/_y` entities with the original timing (X first,
   then Y ~1–4 ms later), so the engine sees the same update pattern as real
   ESPHome devices.

## 6. Reading production HA

A Chrome tab with production HA is exposed over CDP on `localhost:9224`.
Evaluate JS in that tab and use `document.querySelector('home-assistant').hass`
for `.states` and `.callWS(...)` (registries, `history/history_during_period`).
Treat production as read-only: no service calls or config changes from
scripts.

## 7. HACS metadata

- `hacs.json` at the repo root, `content_in_root: false`.
- GitHub Actions run the HACS action and hassfest on push, PR and nightly.
  Both fail until the integration code lands in M1.

Publish: tag `vX.Y.Z`, push tags; users add the repo as a HACS custom
repository (category *Integration*).
