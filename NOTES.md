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

## 2026-11-13 late: units bug found by the user (fixed)

- Symptom: a dense cluster right in front of the living-room sensor, and
  target 2 drawn at the sensor while the data had it ~3 m out.
- Cause: history (and the live seed) took each entity's unit from its
  *current* state. Right after an HA restart, targets that had not reported yet
  had restored/unavailable states without `unit_of_measurement`, so their whole
  history was read as mm instead of inches (25.4x too small → collapsed onto
  the sensor). Can happen in production after restarts or while a radar is
  offline.
- Fix: `discovery.async_resolve_units` — state attribute → entity registry
  (sensor options / suggested unit / registry unit) → most common unit among
  the radar's other coordinate entities. Used by runtime, history, websocket
  and config flow. Regression tests in test_history / test_integration fail
  without the fix.
- The kitchen 8519b4 analysis (real person at ~1.25 m: walked in every time,
  co-detected by the Screek, mealtimes) was computed from the export with
  correct units and stands.
- Timeline: replaced the hidden drag-to-window gesture with an Apple-Photos
  style trimmer (yellow handles at the ends of the loaded range). The trim
  windows the point cloud and bounds playback; "Zoom to trim" / "Clear trim".
- Dev panel times are shifted +2043 s vs production (simulator backfill
  anchors the export end to "now"); offered to switch to real timestamps.

## 2026-11-13 night: guided zones + hold until exit

User asked to experiment with: ghost vs real spots from trails, auto hulls
with margins, and zones that only end on a positive exit. All three built
(DESIGN §6.5, §8.3.1). Evidence and decisions:

- Desk (living room 252dd0, 48 h): 0 walk-outs without a preceding entry;
  161 vanishes inside → 145 reappeared inside, 16 outside; still periods p50
  44 s, p90 ~4 min, max ~25 min. Confirms the user's hypothesis.
- No real ghost exists in the current exports, so the ghost class is only
  covered by a synthetic test (tests/js/analysis.test.mjs). Revisit with a
  plant/fan case if one shows up.
- Hold alone flaps on edge jitter (68 off-gaps < 2 s in 48 h) → spot zones
  get a 150 mm edge margin with the hold. Consider making the edge margin a
  default whenever hold is turned on.
- "Appear outside releases a hold" is fragile if the radar spawns phantom
  secondary targets; on the desk it caused 15 releases in 48 h (vs 132 walk
  outs). Option later: only release on appearances > 1 m outside, or
  require the appearing target to persist.
- Fit to points / spot hulls are convex: an L-shaped cloud gets a convex
  hull. Fine for desks and chairs; concave hulls (alpha shape) later.
- The dev config's old "Ghost corner" exclusion (flagged as a real spot) was
  replaced by a saved "Desk" zone created from the suggestion (hold, 150 mm
  margin, max hold 25 min).
- Simulator: entities are seeded with their state at the replay position on
  start (they stayed unavailable for hours after a restart in quiet stretches);
  state file read moved off the event loop.
- Design discussion deferred (two modes, edit menu, time picker, default
  15 min): DESIGN §8.5.

- Flapping edges: the editor flags zone edges that targets cross out and
  back in within 3 s (red on the map). A box whose edge cuts the desk: 244
  flaps / 24 h on that edge.

Ideas not built yet:
- Doorway detection: checked the data (room empty → first appearance, and
  last position before empty). In the living room most room sessions start
  and end *at the desk*, not a door: the room goes 'empty' while the user sits
  still. Doors don't stand out in any radar's data, so auto doorways are not
  viable; a user-drawn 'exit area' for a whole-room hold zone could be
  (vanishing inside an exit area = left).
- Suggest on-delay from blip durations of likely-ghost visits.
- Multi-sensor fusion in one room (two radars agree → ghost unlikely).

## 2026-11-14: zone export / import, getting ready for production

- Zones are stored in the config entry options, so there was no way to move
  zones drawn in the dev instance to production. Added *Export…* / *Import…*
  to the panel (`frontend/transfer.js`, JSON format `radar_zone_presence/zones`
  v1, mm). Import merges: same id, else same name + kind, is replaced in place
  (keeps the entity); the rest is added; area overrides that do not exist on
  the target instance fall back to inherit. Nothing is saved until Save, and a
  file from a differently named radar asks first.
- Production has no HACS (HA OS 2026.11.1), so the README now documents a
  manual copy into `/config/custom_components/` next to HACS.
- Before the first push: history was rewritten (unpushed) to drop the
  production hostname from `tools/*.mjs` (now `PROD_HA_HOST`) and the dev
  config's home coordinates (now a city-centre location).
- Per-radar import files generated from the dev instance live in
  `dev/data/prod-import/` (gitignored: real room layout).
- Installed in production from the Marketplace (Add from link, commit
  86a4b04): no restart needed for the first install. Only the living-room
  radar (252dd0) is configured for now, with its two legacy polygons plus
  Desk (hold until exit, max 25 min, edge margin 150 mm). Desk went on for
  the person sitting there right after saving.
- HACS Action: brand icon (`brand/icon.png`, served by HA ≥ 2026.x from the
  integration folder) and manifest `categories` fixed; the repository
  description and topics have to be set on GitHub.

## 2026-11-14: live playback by default, a window that ends at "now"

- The panel opens in live playback: playhead at now, timeline zoomed to the
  last 15 min, trails / zone states / frame table update as frames arrive.
  Pause (or click the timeline, arrows, a trigger) drops into replay at that
  moment; *● Live* jumps back (keeping the zoom); *Point cloud* is the old
  full-cloud view for drawing.
- The loaded window ends at "now" (`windowEnd`; an absolute end, from the
  future time picker, will switch this off). A 1 s ticker grows it to the
  right in every mode, live frames are appended to the history (so live can
  be paused and scrubbed back), recorded bands are extended, and frames older
  than the range drop off the left in batches (max(60 s, range/100)), which
  re-indexes the preview. Timeline: a full-width view keeps showing the whole
  window; a zoomed view slides only while live; a trim that reaches the end
  keeps reaching it.
- Legacy `input_text` polygon helpers: only the one-time import in the setup
  flow remains (it only appears when such helpers exist); the panel button,
  picker hint and README claims are gone.

## 2026-11-14: mounting orientation

- The living-room map was mirrored (desk drawn left, actually right as seen
  from the sensor). Both EP Lites are mounted upside down
  (`switch.*_upside_down_mounting` on, installation angle 0). The server now
  reads those settings (`device_mounting` in the config), and the view's
  *Mounting* defaults to upside down = flipped left/right when the switch is
  on. Display settings saved before (no `v`) take the device default once.
- Screeks have no such switch and default to upright; if one is mounted
  upside down, pick it under Sensor settings (walk-right check in the help).
- Zones are not touched: they are stored in the sensor frame and flip with the
  points. Axis labels still show the sensor's own X values (so they count up
  to the left when flipped).
- The dev simulator recreates the mounting entities (`extra_states` in the
  export meta; `tools/export_history.mjs` now captures them).
