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
