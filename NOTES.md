# Work notes

Running log of decisions, findings and progress. Newest first within each
section. DESIGN.md is the spec; this file is the lab notebook.

## Decisions

- **2026-11-13 Working name** `radar_zone_presence` / "Radar Zone Presence".
  User is fine renaming later.
- **Server-side only.** Never write zones to device firmware (user preference;
  also why the EP Zone Configurator add-on is not used).
- **Exclusion zones are sensor-wide** and applied before include zones.
- **Catch-all:** automatic `binary_sensor.<radar>_presence` = any target not
  excluded, plus a "fill detection area" button in the editor.
- **Zones stored in config entry options**, in mm, with stable ids.
- **Zone entities attach to the radar's existing device** (inherit its area;
  per-zone area override).
- **Screek slots are not gated by `all_target_counts`** — data showed the
  count lagging a live slot-2 target for 8.5 s (laundry room, aef514).
- **Frontend: vanilla JS ES modules, no build step**, WebGL2 point layer +
  SVG vector layer. No Plotly.
- **Dev runtime: HA in a local venv (`.venv`, `hass -c ha_config`)** instead
  of Docker — Colima cannot start from this Claude session (macOS sandbox:
  `sandbox_extension_issue_generic_to_process failed`). docker-compose.yml is
  kept for use outside the session.

## Findings (production data, 48 h)

- X then Y are separate updates; X→Y gap 0.5 ms (EPL) / ~4 ms (Screek);
  frames every ~0.3 s / ~0.53 s. → 50 ms coalescing window.
- HA dedupes unchanged states: 1–3 % of X changes have no Y update. The
  legacy Y-triggered template misses those frames.
- Absent target ⇔ y == 0. `x == 0` happens legitimately on boresight
  crossings (legacy macro drops them).
- aef514 has firmware exclusion zone zout1 enabled (x 1016–2540 mm); it does
  not explain the count/slot-2 mismatch (22/80 points inside).

## Dev-environment gotchas (2026-11-13)

- **Docker/Colima and Playwright-style Chrome cannot start** from this Claude
  session (macOS sandbox `sandbox_extension_issue_*` / mach-port denials).
  HA runs from `.venv` via `dev/run.sh`; UI testing drives a *separate window*
  in the user's CDP Chrome (`tools/cdp_dev.mjs`), never the production tab.
- **HA 2026.10 HTTP config is "pending" until confirmed**: a YAML
  `server_port` change reverts after 5 min unless promoted
  (`http/config/promote`). `dev/run.sh` promotes it; if a trial already failed,
  fix `ha_config/.storage/http` (`stable.server_port`, `pending: null`).
- **Recorder stall on bulk backfill**: every recorded state references the
  entity's previous state; SQLAlchemy's flush topologically sorts those chains
  quadratically. Thousands of states per entity in one commit = flush never
  finishes (stack: `session.commit → flush → topological.sort_as_subsets`).
  The simulator paces the backfill (~800 states/s, `commit_interval: 1`).
  Production is unaffected (3 Hz real updates).
- **Background windows don't run requestAnimationFrame**: the plot only
  repaints when the dev window is visible or a screenshot forces a frame.
- **HA's service worker caches panel modules**; the URL version hash only
  changes on HA restart. `cdp_dev.mjs open` disables cache + service worker.
- Household presence data is never committed: `dev/data/` is gitignored,
  fixtures are short windows, no screenshots of real data in docs.

## Environment

- Production HA readable via CDP on localhost:9224 (`tools/cdp_eval.mjs`).
  Read-only by policy.
- `gh` and sibling repos (~/Development/ha-tides) are unreadable from this
  session (macOS TCC). ha-tides files are fetched from GitHub raw.
- Full 48 h export lives in `dev/data/` (gitignored — it is household
  presence data and the repo is public). Small windows are committed under
  `tests/fixtures/`.

## Progress

- M0 scaffolding, DESIGN.md, export + fixture tools, fixtures. (2f1fae8)
- M1 engine (216b4c4) + HA integration (c860ab4) + simulator & JS engine
  port with parity vectors (38ea221). 32 pytest + 17 node tests.
- M2–M4 panel (fea8957): editor, snapping, WebGL cloud, preview, timeline,
  replay, frame table. Verified in the dev instance against 48 h of
  production-shaped data (7 radars): drawing snaps rectangles square, edge
  drag keeps rectilinear zones rectilinear, save → entities created, entry
  reload → live subscription resumes, exclusion immediately reflected in
  `excluded_targets`.
- Observation from the dev data: a box over living-room target 1's parking
  spot would have triggered 1052× in 24 h — exactly the ghost case the
  preview is meant to expose.
- Debugging UX (ddd5107): recorded triggers (what HA actually did) listed
  per zone and marked on the timeline, click → replay; trail arrowheads.
- Hardening (44f3fda): zone entities unavailable while the radar is offline,
  diagnostics download, discovery tests (Screek naming, device rectangles).
- Dashboard card + area semantics (f1ca98d). 38 pytest + 17 node tests.

## Status vs. the original requirements (2026-11-13 night)

| Requirement | State |
|---|---|
| Pick a sensor, discover its target X/Y entities | done (EP Lite/Pro, Screek 2A, generic naming) |
| Draw include/exclude polygons, snapping to right angles, angle/length readouts, edit | done |
| Named presence entities per zone, inheriting the room | done (+ catch-all, counts, excluded diagnostic) |
| History point cloud 24/48 h, "how often / when would it have triggered", what it includes/excludes | done (15 min–7 d; colour by selected zone) |
| Time scrubber replaying movement and direction | done (trails, arrows, timestamps, frame table, recorded triggers) |
| Catch-all zone | automatic `…_zone_presence_any` + "Fill detection area" button |
| Server-side only, vendor-agnostic | done |

## Open items / ideas for next session

- Not pushed: commits are local only (user did not ask to push).
- Try on production: push, add as HACS custom repo, add each radar (accept
  the polygon import), run side by side with the YAML package for a day, then
  remove `packages/presence_polygons.yaml` and the `input_text` helpers.
- HACS action will want brand images (`custom_components/.../brand/`), repo
  topics and a release tag.
- 7-day history of a busy radar is a ~15 MB JSON payload; switch
  `frames/history` to a binary/base64 typed-array encoding if that is slow.
- Floor-plan underlay image, multi-sensor rooms, per-zone notes.
- The toolbar's colour dropdown doesn't reflect programmatic changes (cosmetic).
- Dev HA is left running on :8124 (dev/dev) with a window open on the panel;
  stop with `pkill -f "bin/hass -c"`.

## 2026-11-13 late: Docker available (user started Colima)

- Docker works from the session with `DOCKER_HOST=unix://$HOME/.colima/default/docker.sock`
  and `DOCKER_CONFIG=/tmp/dockercfg` (~/.docker/config.json is unreadable here).
- `dev/hassfest.sh`: hassfest passes (1 integration, 0 invalid).
- Compatibility: a throwaway `home-assistant:2026.11.1` container (production's
  version) loaded all 7 simulated radars, imported legacy polygons, served the
  panel and answered config/history/live websocket calls without errors.
  (Tests run against 2026.10.4, the latest pytest-homeassistant-custom-component.)
- ha-tides' `ha_dev` container auto-starts on :8123 with Colima; left alone.
