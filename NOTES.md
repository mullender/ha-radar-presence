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

## 2026-11-14: entry doors vs radar (exploration, 7 days of production data)

- Entry radar (Screek) + three door contacts (coat closet, front door, garage
  entry door). Analysis scripts lived in /tmp; nothing committed.
- Every door open and close had a radar target at that moment; 40% of all
  radar appearances fall within 5 s before to 15 s after a door opening
  (chance: ~0.4%).
- The target position at open/close places each door tightly (IQR ~0.3-0.5 m):
  closet on one side, front and garage door on the other at different depths.
  Arrivals from the garage (entry empty before) are first seen in the doorway,
  further out than people leaving, who stand in front of the door.
- Ideas: door markers / door areas located automatically from a chosen door
  sensor; door events on the timeline; a door opening as the positive exit for
  "stay occupied until seen leaving" (vanish near a door right after it opens =
  left, not gone still).

## 2026-11-14: doors and entry/exit points (step 1)

- New zone kind `exit` (entry/exit point: doorway, top of the stairs) with an
  optional `door_entity_id`. No entity; the engines ignore exits for now.
  Draw one with the *Exit* tool, or add one from the *Doors* section.
- *Doors*: every door contact in HA (device class door / garage_door /
  opening) is checked against the loaded history: was a target in view when
  it opened or closed (frame within 1.5 s)? Those that line up (>= 50%, >= 2
  events) are listed, wherever their HA area is; *+ Exit* places the exit on
  the densest spot of those positions (0.7 m radius, hull + 150 mm).
  The first placement (median, 2.5x median distance) made a 4 m sliver on the
  entry: people walking up to the door spread out, the door itself does not.
- Door open intervals show as a row on the timeline; the exit on the map shows
  "open" (live, or at the replay cursor).
- Dev: the simulator replays door contacts (`attributes` in the export meta)
  and backfills entities added after the first backfill. The dev recorder had
  to be rebuilt: it still held radar data from an older export than the
  current files, so door events and radar frames were seconds to minutes apart.

## 2026-11-14: entry/exit points in the hold logic (step 2)

- Floor plans from the user: living radar on the west wall facing east
  (upside down: +X = north), stairs down to the entry just north of it, the
  kitchen opening between the stair wall and the island; no other exits.
  Entry radar on the north wall facing south, upright (Screek raw +X = sensor's
  right; matches the door clusters, so Screeks need no flip).
- Engine (Python + JS, shared vector "hold_exits"): with hold on, a target
  that vanishes while standing in an exit has left (no hold), and a target
  that appears in an exit is a new arrival (does not release a hold).
  Exits are radar-wide, like exclusions; no exits = unchanged behaviour.
- Living room, 48 h, one "Living room" zone up to the island line, hold +
  15 min max + 150 mm edge margin, exits Stairs + Kitchen opening:
  turn-ons 283 -> 97, occupied 14.9 h -> 21.8 h; on real timestamps the room
  is empty 22:00-06:00 and covered through the working day where the raw
  sensor had big holes (08:00: 4 min vs 65 of 120). Of 74 departures through
  an exit, 55 switch off within 5 s (45 without exits); rooms left on > 5 min
  6 (12 without).
- Lessons: the living radar sees past the opening into the kitchen, so the
  kitchen exit must include the strip on the room side of the opening (an
  overnight 9.5 h stuck hold came from someone lost right at the island line);
  without identities, counts drift when two people hold and one leaves unseen,
  so Max hold stays the safety net; holds are not started by ghosts here
  (2 of 204 at night, half tracked > 1.5 min).

## 2026-11-14: aligning one radar's view with another

- The living radar sees well into the kitchen, so moments when both radars
  see exactly one target (within 0.3 s) are almost always the same person.
  A RANSAC + least-squares rigid fit (both handednesses tried) over 48 h:
  5,803 pairs, 3,450 agree within 0.4 m (rms 211 mm); the kitchen radar is
  turned -155 deg relative to the living radar, ~2.3 m north / 5.4 m east of
  it, facing west and ~24 deg north: towards the stairs, as the user said.
  The mirrored fit is much worse (35%), so both report in the same handedness.
- *Align with* (Sensor settings) runs this in the panel against another radar's
  history and sets this radar's view rotation (and flip, if the handedness
  differs) so both maps show the house the same way. It stores the fit
  (`display.aligned_to`) with the zones. View only, our own setting: the EP
  Lite installation angle is not used (it is a tilt, and whether the firmware
  applies it to the coordinates is unknown).
- The fitted offset would also allow drawing two radars on one map, or
  handing a person over between radars; not built.

## 2026-11-14: door objects, three radars on one map

- b3b6c4 (Screek, west end of the island, facing north) aligns with both EP
  Lites (71-73% agree, rms ~190-200 mm), mirrored as expected (upright Screek
  vs upside-down EPLs). Chaining b3b6c4 -> kitchen EPL -> living agrees with
  b3b6c4 -> living within 2.6 deg and 10 mm.
- Door objects: an exit can carry `door: {swing: none|in|out, hinge_end}`;
  the threshold rectangle stays the polygon ("Make rectangle" squares up a
  hull). The map draws the leaf and its swing arc; "in" = towards the radar.
  With a door-sensor exit selected, the door-event positions show as dots.
  Entry garage door (swings into the entry): people stand 1.2-1.8 m back from
  the threshold, just outside the arc, as the user expected for pulling.
- Other radars: radars linked by saved alignments (either direction, chained)
  are drawn in the current view: field of view, zones (outlines), live
  targets (diamonds). Toolbar *Others*. Basis for shared zones and following
  people between radars; neither built yet.

## 2026-11-14: zones as presence devices (phase A of the home model)

- Every include zone is a device ("Desk Presence", model "Presence zone",
  connected via its radar, *Visit* opens the panel on that zone) in the zone's
  area or by default the radar's. Entities keep their unique ids, so existing
  entity ids survive; new zones get `binary_sensor.<zone>_presence`.
  Device class occupancy (presence showed Home / Away on the device page).
- Radar-level "any (not excluded)" and "excluded targets" entities removed.
- HA minimum raised to 2026.10 (DeviceInfo `via_device_id`).
- Panel deep links (#entry=..&zone=..) follow HA navigation: the panel element
  is recreated/reattached, so the hash is applied on location-changed.
- Testing note: zsh does not word-split `$VAR`; use separate variables.

## 2026-11-14: phase B (home entry, subentries, shared zones, exit events)

- One home entry; radars and zones are subentries (see DESIGN §9.6). Clean
  setup needed in production; dev was converted with
  `tools/dev_merge_entries.py` (radar subentries reuse the old entry ids so
  alignments keep working; our old entities are re-created with
  `<zone>_presence` ids).
- HA 2026.10: `async_get_device(identifiers=...)` is deprecated (identifiers
  are only unique per config entry); use `async_get_device_by_identifier(id,
  entry_id)`. `DeviceEntry.config_entries_subentries` is deprecated too.
- `async_call_later` with a plain lambda runs it in the executor: wrap in
  `@callback`.
- A config flow's `next_flow` must point at a flow still in progress: when
  the radar subentry flow aborts at once (no radars), do not chain it.
- Dev floors created for the picker: Ground (Entry, Garage, Laundry), First
  (Living, Kitchen), Second (Bedroom) — a guess, dev only.

## 2026-11-15: production on phase B (516c65b)

- Old v1 entry (living-room EPL only) backed up to `dev/data/prod-backup/`,
  deleted (nothing referenced its entities), new version installed through the
  Marketplace, HA restarted, Home entry created, radar 252dd0 added with its
  two legacy polygons, Desk restored with the same polygon and filters.
  Entities: `binary_sensor.desk_presence`, `polygon_1_presence`,
  `polygon_2_presence` (devices in Living Room, connected via the radar).
- Marketplace WS API (built-in HACS): `marketplace/repository/info`
  {repository_id}, `marketplace/repository/refresh` {repository} (needed
  before `update.radar_zone_presence` sees a new commit); install with
  `update.install`, then restart (repair `restart_required_*`).
- Bug found on the way: browsers kept the old `util.js` (relative imports had
  no version) and the new panel never registered. The frontend is now served
  under `/radar_zone_presence_static/<version>/`.
- After an HA restart, background CDP tabs don't reconnect their websocket
  until reloaded.

## 2026-11-15: people tracker, linger / transient spots

- Production 12:05: target renumbering (desk person dropped, kitchen person
  moved into slot 1) turned Desk off three times with the person sitting
  there. See DESIGN §9.7 for the tracker and the numbers.
- Writing a window of production coordinates into `tests/vectors` was
  blocked (household data in the public repo); the regression test is a
  synthetic reconstruction (`test_desk_stays_held_while_the_radar_renumbers_and_reuses_slots`).
- Comparison scripts lived in /tmp (old code from `git archive HEAD`, dev
  configs via `tools/dev_ws.mjs`, frames from `dev/data`).
- Dev sim radars expose no `max_distance` number, so dev shows the 8 m
  default for the EPLs too (production EPLs report 6 m).
- Panel "Revert" opens a confirm() dialog, which blocks CDP evaluation in the
  dev tab; close the tab through `/json/close/<id>`.

## Head count, 2026-11 (household specifics kept in dev/data/notes-private.md, gitignored)

Scored with `tools/headcount.py --truth <file>` against a private ground-truth file (exact counts where the household knows them, upper bounds per day): hours wrong, hours above bounds, count changes without an exit door. Development went from 13.7 h wrong (of 54 h exact) to 0 h on the replayed days; rules were tuned on those same days, so new days are needed to validate.

What made the difference, each found by tracing a wrong moment in the replay:
- Exit windows: while an exit door is used, everyone on its floor (or seen there in the last 2 min) is unknown; the count is unknown until 60 s after the doors close; re-established by a sighting on another floor (or still seen on the exit floor after LAG_S); gone after 10 min.
- Doorways (exit zones that say where they lead: a region, several, or outside) decide who a track is where it appears or vanishes. Without them the same engine was ~38 h wrong.
- Direction of a garage opening from the door order (house-to-garage door first = out).
- Door sensors miss events: a track walking out through the front-door zone and vanishing counts as the door opening.
- Overlapping radars: a track seen by one radar only, where another radar of the group looks, is a reflection until confirmed (removed all hours above bounds).
- Tracker track ids get reused: a re-found track keeps its person only within 2 m and (after 30 s) if they were not seen elsewhere since.
- Rooms without a radar behind a doorway hold their sleeper; a split or two-radar double sighting does not create or move people.
Not used yet: lock state changes and stair PIRs as exit / floor-crossing evidence.

## 2026-11-16: smart locks and robot vacuums

- A door contact with a lock on the same device (a smart lock's door sensor): locked means closed, whatever the
  contact says. One stayed "open" for a whole night after the door was locked, which kept an exit window open (all
  counts in doubt) and, once fixed naively, hid the next morning's departure (the contact never went open again).
  So: locking closes the door; an "open" while locked is ignored (logged); unlocking makes the contact count again,
  open already if it says so.
- A robot vacuum moves like a person to a radar (slow sweeps, ~10 cm/s, across a whole room). Robot vacuums are
  picked in the home options. While one cleans or returns, the radars in the room it reports (a `current_room`
  sensor on its device, matched to an area by name, case-insensitive) are ignored. It reports the room a minute or
  two after starting: until then the head count keeps a copy of itself and every input; new tracks wait. Once the
  room is known (or after 5 minutes, or when it stops) it goes back to the copy and replays the inputs with that
  room ignored. Log entries of the discarded branch are dropped (door/signal entries kept).
- Replay tool: `--door-locks '{contact: lock}'` and `--vacuums '{vacuum: room sensor}'` (rows in --doors); for
  the vacuum it looks ahead to the room it reports next, which is what the runtime ends up with.

## 2026-11-17: ghost spots by how tight they are
- An empty house for a day and a half: the only dwell spot any radar found was a heater fan seen through a wall.
  The walk-in rule got it wrong both ways: "not enough activity" when nobody was home (an hour-long run is one
  episode, two runs), "dwell spot" when people were home (walking past, they step into its polygon).
- What separates it is the point cloud. Fan: RMS spread 58-63 mm, ~77,000 detections/m². 24 real spots (desks,
  beds, couch, kitchen) over a day: 118-481 mm, 2,200-10,700 /m². So: >= 1000 detections within 90 mm RMS is a
  ghost, whatever the walk-ins (`classify`, from `trailStats().points/spread`). The test desk's jitter was
  widened to real-world values (it was ±75 mm, tighter than anyone in the data).
- Engine still_spots (only suggestions, SPOT_APPLY off) forget a spot 6 h after it was last active; the panel's
  prompt uses the frontend analysis over the loaded history instead. `tools/headcount.py --spots MIN_S` lists them.
- The radar side panel's guide asks, one at a time: "New hot spot: what is here?" (facts only: how tight, walk-ins,
  busiest time; answers: something fixed -> exclusion, a place people stay -> zone, nothing special -> stop asking,
  show me -> highlight and jump to its busiest quarter hour). Then tidy-up: an exclusion trails walk into (>= 10
  and >= one per 2 h of history: it may hide people), an exclusion with nothing inside in >= 6 days of history, a
  zone nobody was in for >= 6 days that no automation, script or scene uses (HA `search/related`). Answers are kept
  per browser (localStorage `rzp.guide.<radar>`).
- On real data the walk-through check found an exclusion drawn for "the neighbors" whose activity followed the
  household exactly (busy when home, silent while away): it hid the residents.
- Then the aligned radars showed it was mostly a reflection: of ~2,900 detections in the strip, 47 came while no
  other radar saw anyone; the rest while someone stood at the counter on the other side, which the radar also saw
  (a mirror image off a hard surface). Only the strip's edge nearest the radar was real people (58-97% confirmed by
  the counter radar). So the walk-through suggestion now asks aligned radars that see into the exclusion: < 20%
  confirmed -> a reflection, rightly excluded, no suggestion; 20-60% -> "part of it, probably an edge, is real:
  shrink it?"; >= 60% or no radar to ask -> as before.
