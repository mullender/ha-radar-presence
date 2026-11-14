# Development setup

How to run and debug the `radar_zone_presence` custom integration. Modelled
on [ha-tides](https://github.com/mullender/ha-tides/blob/main/DEVELOPMENT.md).

## 1. Prerequisites

- macOS 13+ or Linux.
- Docker Desktop, OrbStack, or Colima.
- Node.js 20+ (frontend build, CDP helper scripts).
- VS Code with the "Python" extension.

Docker is optional: the venv route (2a) needs only Python 3.13+ and Node.

## 2a. HA from a local venv (what the Claude sessions use)

```
python3 -m venv .venv
.venv/bin/pip install pytest-homeassistant-custom-component
.venv/bin/pip install "$(grep -i '^home-assistant-frontend' .venv/lib/python3.*/site-packages/homeassistant/package_constraints.txt)"
node tools/export_history.mjs --hours 48      # needs the production CDP tab; writes dev/data/
dev/run.sh                                    # http://localhost:8124, user dev / password dev
```

`dev/run.sh` seeds `ha_config/` (minimal config, dev user, onboarding done),
symlinks `radar_zone_presence` and the dev-only `radar_sim` integration, and
confirms the pending HTTP port. `radar_sim` recreates the exported radars with
the same entity ids, backfills the recorder once (paced; takes ~6 min) and
then replays the data live in a loop.

Add radars via Settings → Integrations, or script it with
`tools/dev_ws.mjs` (websocket client logged in as dev/dev).

## 2b. HA in Docker with the component mounted

`docker-compose.yml` runs `ghcr.io/home-assistant/home-assistant:dev` as
`ha_radar_dev`, with `custom_components/` bind-mounted. Ports are offset from
ha-tides so both can run at once:

| Host | Container | Use |
|---|---|---|
| 8124 | 8124 | Home Assistant UI |
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

## 5. Tests

```
.venv/bin/pytest                 # engine, integration (HA test harness), history, parity vectors
node --test tests/js/            # frontend/engine.js against the same vectors
UPDATE_VECTORS=1 .venv/bin/pytest tests/test_vectors.py   # after changing engine semantics
```

`tests/fixtures/` are short windows cut from production exports
(`tools/cut_fixture.py`), including the 2026-11-13 kitchen ghost.

## 5b. Driving the panel

`tools/cdp_dev.mjs` opens the dev HA in its own window of the CDP Chrome on
:9224 (logged in, cache and service worker bypassed) and offers `eval`,
`shot`, `click`, `drag`, `mouse`, `key`, `wheel`, `close`.

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
