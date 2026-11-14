# Radar Zone Presence — Design

Home Assistant custom integration that turns the raw target coordinates of
LD2450-style mmWave radar sensors (Everything Presence Lite, Screek Human
Sensor 2A, …) into named, polygon-shaped presence zones — with a purpose-built
editor, a history point cloud, a "what would this zone have done" preview, and
a time scrubber for debugging false triggers.

Domain: `radar_zone_presence` (working name; easy to rename before v1).

## 1. Goals

- Pick a radar sensor; the integration discovers its per-target X/Y entities.
- Draw **include** and **exclude** polygons per sensor in a dedicated UI, with
  drawing aids (right-angle snapping, angle/length readouts, numeric vertex
  edit, vertex insert/delete).
- One presence `binary_sensor` per named include zone, usable directly in
  automations ("reading chair occupied → reading light on").
- All logic runs **server-side** in Home Assistant. The radar is a dumb
  coordinate source; we never write zones into the device.
- History point cloud (24 h / 48 h / custom) behind the editor, with a
  preview of how often and when a draft polygon would have triggered.
- Time scrubber that replays target movement, with trails and timestamps, so
  "why did the lights come on?" can be answered in a minute.
- Vendor-agnostic: anything that exposes per-target X/Y sensors.

## 2. Non-goals (v1)

- Writing zones/masks to device firmware (the Everything Presence Zone
  Configurator add-on does that; we deliberately don't).
- 1-D (distance-only) radars such as the Screek L13 / LD2412S — no X/Y.
- Room-layout drawing (walls, furniture). A background image/underlay may come
  later; see §10.
- Fusing multiple sensors that see the same room into one coordinate frame.

## 3. Prior art and the setup this replaces

The current production setup (2026-11) is hand-rolled:

- `input_text.<device>_zone_polygon_<n>` holds a JSON vertex list in inches,
  e.g. `[[0, 35], [0, 250], [75, 250], [75, 125], [150, 125], [150, 35]]`.
  `input_text` is capped at 100 characters (~8 vertices).
- A YAML package of trigger-based template `binary_sensor`s
  (`unique_id: polygon_presence_<device>_<n>`) evaluates a ray-casting
  point-in-polygon Jinja macro (`custom_templates/polygon.jinja`) on every
  target **Y** update.
- A `custom:plotly-graph` card per sensor renders target 1 (1 s resampled,
  2 h) with up to three polygons.

The Everything Presence Zone Configurator add-on (v2.2.5, installed) has
polygon zones, heatmaps and trail recording, but only supports Everything
Presence devices and pushes zones into the device firmware.

## 4. What the data says (measured on production, 48 h, 7 sensors)

These findings drive the evaluation engine (§6).

| Finding | Evidence | Consequence |
|---|---|---|
| X and Y of a target are separate HA state updates, X always first. | 0 of ~150k frames had Y before X. Median X→Y gap 0.5 ms (EP Lite), 3.5–4 ms (Screek 2A). Frame period ~0.3 s (EP Lite "Normal"), ~0.53 s (Screek). | Evaluating on each update pairs new X with old Y → edge flicker. This caused the 2026-11-13 04:05 kitchen ghost trigger. Must assemble a **frame** first. |
| HA only records a state change when the value changes. | 1–3 % of X changes have no Y update within 50 ms (Y unchanged to the mm); 18–66 per sensor per 48 h moved > 2 in. | Triggering only on Y (current YAML) silently skips frames. Coalesce on *any* coordinate change instead. |
| Empty target slot reads `(0, 0)`. Y is never ≤ 0 for a real target. | `negY = 0`; at frame time `x≠0, y=0` never occurred. | **Absent ⇔ y == 0** (or unavailable). |
| `x == 0` with a real Y is a legitimate reading. | Every sampled case is a target crossing the boresight, e.g. x: −7.3 → 0 → 2.8. | Do **not** drop `x == 0` (the current macro does). |
| Entities report in the user's display unit (inches here), converted from native mm. | `unit_of_measurement: in` on all target sensors. | Normalise to mm on ingest using `unit_of_measurement`; store geometry in mm. |
| Recorder keeps every update. | ~54k updates/day/axis for a busy target 1. | Point cloud and replay can come straight from the recorder; no own storage needed. |
| Ghost targets exist. | Living-room target 1 parked near (−93, 187) in for 24 h; kitchen ghost lived 1.4 s, ~90 s after the sensor reconnected, right on a polygon edge. | Exclusion zones, optional dwell/hysteresis/reconnect-grace filters (§6.4), and replay tooling (§8.4). |

## 5. Architecture

```
radar device (ESPHome)          Home Assistant
  target_n_x / _y  ──state──►  ┌──────────────────────────────────────────┐
  (+ speed, resolution,        │ radar_zone_presence                      │
     angle, distance)          │                                          │
                               │  SensorProfile ── discovers entity map   │
                               │  FrameAssembler ── 50 ms coalescing      │
                               │  ZoneEngine ── exclude → include →       │
                               │                 filters → zone states    │
                               │  entities ── binary_sensor / sensor      │
                               │  websocket_api ── zones CRUD, live       │
                               │      frames, history frames, events      │
                               │  panel ── sidebar UI (bundled JS)        │
                               └──────────────────────────────────────────┘
```

One config entry per radar sensor.

### 5.1 Sensor profiles and discovery

At config-flow time the user picks a device. A profile matches that device's
entity registry entries:

| Profile | Match | Notes |
|---|---|---|
| Everything Presence Lite / Pro | `sensor.*_target_<n>_x` / `_y` | Up to 3 targets. Also reads `installation_angle`, `upside_down_mounting`, `max_distance`, device zone/mask numbers for display only. |
| Screek Human Sensor 2A | `sensor.*_target<n>_x` / `_y` | Up to 3 targets. Slots are **not** gated by `*_all_target_counts`: in production the count read 1 while slot 2 tracked a moving target for up to 8.5 s (fixture `screek_aef514_count_lags_slot2.json`), and no stale coordinates were seen above the count. The count is recorded for diagnostics only. |
| Generic | user maps X/Y entities per target by hand | Fallback for other LD2450 firmwares. |

The resolved map (`target → {x, y, speed?, resolution?}`) is stored in the
entry, so later firmware renames show up as a repairable issue rather than
silent breakage.

### 5.2 Coordinate frame

- Zones are stored in **millimetres in the sensor's reported frame**: origin at
  the sensor, +Y straight out, +X as the firmware reports it (after the
  firmware's own upside-down / installation-angle handling).
- Display orientation is a per-sensor setting (Sensor settings → Mounting /
  Rotate view): sensor at the bottom facing up, *upside down* swaps left and
  right, rotation is any angle (corner mounts). The mounting default follows
  the device's `upside_down_mounting` switch where it exists (EP Lite / Pro;
  both production EP Lites are mounted upside down and were drawn mirrored
  before this). It never changes stored geometry: zones live in the sensor
  frame and flip with the data.
- Units shown in the UI follow the HA unit system (in/ft or cm/m).

## 6. Evaluation engine

### 6.1 Frame assembly

- Subscribe (`async_track_state_change_event`) to all X/Y entities of the entry.
- On any change, if no evaluation is pending, schedule one 50 ms later
  (`async_call_later`). X→Y gaps are ≤ 4 ms median, frame periods ≥ 300 ms,
  so one evaluation per firmware frame with wide margins on both sides.
- At evaluation, read current X/Y for every target, convert to mm, and build a
  frame: `{t, targets: [{slot, x, y} | absent]}`. A target is absent when
  `y == 0`, unavailable, or unknown.
- The same assembler runs over recorder history (§8.2) so replay shows exactly
  what the live engine saw.

### 6.2 Zones

```jsonc
{
  "id": "z_7f3c…",            // stable; entity unique_id derives from it
  "name": "Reading chair",
  "kind": "include",          // include | exclude
  "polygon": [[x_mm, y_mm], …],   // ≥ 3 vertices, simple (non-self-intersecting)
  "area_id": null,            // null = inherit the radar device's area
  "filters": { "on_delay_s": 0, "off_delay_s": 0, "edge_margin_mm": 0 }
}
```

Stored in the config entry options (no `input_text`, no size cap). Saving from
the panel updates the entry and reloads it; zone ids keep entity ids stable
across renames and edits.

### 6.3 Per-frame logic

1. Drop absent targets.
2. **Exclude:** drop every target inside any exclude zone of this sensor.
   Exclusion applies sensor-wide, before any include zone is evaluated.
3. **Include:** for each include zone, count remaining targets inside
   (ray casting, with the edge margin from §6.4).
4. Feed counts through the zone's filters → zone state.

### 6.4 Ghost filters (optional, per zone, default off)

- **On delay** — target must be inside for N s before the zone turns on
  (the kitchen ghost lasted 1.4 s).
- **Off delay** — hold on for N s after the last target leaves.
- **Edge margin (hysteresis)** — entering requires being ≥ m mm inside the
  edge; leaving requires being ≥ m mm outside.
- **Reconnect grace** (sensor-wide) — ignore frames for N s after the radar
  entities return from `unavailable`.

The panel's preview (§8.3) shows how many triggers each filter would have
removed over the loaded history, so values are chosen from data, not guessed.

### 6.5 Stay occupied until seen leaving (per zone, default off)

LD2450-style radars drop a person who sits still (desk, sofa). Instead of a
long off delay (which delays every real exit), the zone tracks occupants:

- A target that **vanishes inside** the zone becomes a *held* occupant.
- A target that **appears inside** with someone held is that person
  re-detected (absorbs one hold).
- A target that **appears outside** with someone held means they left unseen
  (releases one hold).
- A target **walking out across the edge** ends occupancy as usual.
- Safety net `hold_max_s` (0 = never): a held occupant expires after that
  long. The editor pre-fills 1.5× the longest still period seen in the zone.

Measured on 48 h at the living-room desk: 145 of 161 vanishes were re-detected
inside (median still period 44 s, max ~25 min); no target ever walked out
without first entering. Turn-ons: no filters 309; off delay 5 min 28 (every
exit 5 min late); hold 149; hold + 150 mm edge margin 80, no exit lag.
The remaining short gaps are edge jitter, hence the margin.

## 7. Entities

Per configured radar:

| Entity | Type | Notes |
|---|---|---|
| `binary_sensor.<zone>` | presence | One per include zone. Attributes: `target_count`, `targets` (slots inside). |
| `sensor.<zone>_targets` | count | Optional per zone (disabled by default). |
| `binary_sensor.<radar>_presence` | presence | Sensor-wide "any target not excluded". This is the catch-all; it differs from the device's own occupancy because it honours our exclusion zones. |
| `sensor.<radar>_excluded_targets` | count, diagnostic | Helps spot the plant/fan/curtain. |

Entities attach to the radar's **existing device** (matched by its device
connections/identifiers), so they appear on the radar's device page and
inherit its area. A zone's `area_id` overrides that per entity. (Verify in M1
that HA accepts a second integration's entities on an ESPHome device without
side effects; fallback is our own device per radar with the same area.)

A "Fill detection area" button in the editor creates a polygon covering the
sensor's field of view (LD2450: ±60°, `max_distance`) for users who want an
explicit catch-all zone with its own name.

## 8. Frontend

### 8.1 Technology

- A sidebar **panel** (registered by the integration, admin-only) for editing
  and debugging; a small live card may follow later.
- Vanilla JS ES modules (custom elements, no framework, no build step), served
  from `custom_components/radar_zone_presence/frontend/`. Same trade-off as
  ha-tides: nothing to build for HACS users or contributors.
- **Point layer: WebGL2.** All history points are uploaded once as vertex
  buffers (x, y, t, slot). Scrubbing, the time window, fading by age and
  colouring by "inside draft polygon" are shader uniforms, so a 48 h cloud
  (~300k points) animates at 60 fps without re-uploading. No Plotly; three.js
  only if the raw WebGL layer gets unwieldy.
- **Vector layer: SVG** overlay for polygons, handles, guides, labels and
  axes — easy hit-testing and crisp lines at any zoom.

### 8.2 Data APIs (websocket)

| Command | Purpose |
|---|---|
| `radar_zone_presence/config` | Entry, entity map, zones, device geometry (FOV, device zones/masks for overlay). |
| `radar_zone_presence/zones/save` | Replace the zone list (validated server-side). |
| `radar_zone_presence/frames/subscribe` | Live frames from the engine plus zone states. |
| `radar_zone_presence/frames/history` | Assembled frames for `[start, end]` from the recorder, packed (typed arrays, mm as int16, t as float32 offsets). |
| `radar_zone_presence/zone_events` | On/off intervals of zone entities from the recorder, for "jump to this trigger". |

History is read in the recorder executor; retention is whatever the user's
recorder keeps (default 10 days).

### 8.3 Editor

- Draw: click to place vertices, click the first vertex (or Enter) to close.
- Edit: drag vertices, drag edge midpoints to insert, Delete to remove,
  drag a whole polygon, numeric vertex table.
- Aids: snap to 90° / 45° relative to the previous edge, snap to axes and an
  adjustable grid, live edge length + interior angle readouts, Shift to
  disable snapping, undo/redo.
- Context: sensor origin and FOV wedge, device-side zones and masks (dashed,
  read-only), zoom/pan, axis ticks in HA units.
- Preview: for the draft zone over the loaded history — number of on-triggers,
  timeline of on intervals, list of trigger times; exclude zones show how
  many points they remove. Filter settings update the preview live.

### 8.3.1 Guided zones (history analysis, `frontend/analysis.js`)

- **Dwell spots**: a 100 mm grid accumulates seconds of presence per cell
  (time to the next frame, capped at 5 s); cells above a threshold (scaled
  with the range, 3–30 s) form 8-connected spots; each gets a convex hull,
  simplified to ≤ 8 vertices by extending edges (still contains the cloud).
- **Signed margin**: hulls grow outward (e.g. +12 in) or shrink inward so only
  the core of a spot counts; inward shrinking drops edges that vanish and
  refuses when the polygon collapses.
- **Ghost vs spot**: per polygon, follow each slot frame to frame (100 mm
  hysteresis) and group activity into visits with the same vanish/reappear
  linking as §6.5. A person walks into a spot before sitting still in it; a
  ghost (plant, fan, reflection) appears and vanishes in place. ≥ 50 % of
  visits beginning with a walk-in → *dwell spot*; ≤ 15 % → *likely ghost*.
  On production data every dense cluster is a dwell spot — including the
  one first guessed to be a ghost (the desk: 502/515 visits walked in).
- Panel: "Suggested zones" lists spots with dwell time, walk-in share and
  class; one click creates a zone (with hold + edge margin when people go
  still there) or an exclusion. The zone editor offers "Fit to points"
  (hull of where targets dwelt inside the drawn polygon, ± margin, hover to
  preview) and a trail breakdown with warnings (an exclusion hiding a real
  spot, an include zone that looks like a ghost, hold suggestion).

### 8.4 Scrubber / replay

- Timeline under the plot with the loaded window, zone on/off bands per zone,
  and markers for every trigger.
- Play / pause / speed (1×, 4×, 16×), step frame-by-frame.
- Shows each target's current point plus a fading trail with timestamps, and
  a side table of frames around the cursor (`t, slot, x, y, inside?`) — the
  "kitchen ghost" analysis, generated on demand.
- Click a trigger marker or pick from the zone's history → jump there with
  the window zoomed to ±30 s.

### 8.5 Future UI direction (user, 2026-11-13; not started)

Two modes to simplify the panel:

- **Playback / debug** (default): bigger plot and timeline, easier time
  selection — a date/time picker besides the presets, default the last
  15 minutes rather than 24 h.
- **Edit**: polygon/rectangle/measure tools, include/exclude, snapping,
  angles and the vertex table live in an edit menu that only appears here.

## 9. Migration

A one-time import (options flow step and panel button) finds
`input_text.<device_slug>_zone_polygon_<n>`, converts its vertices from the
target sensors' unit to mm, and creates include zones named
`Polygon <n>`. Old helpers and the YAML package are left untouched; the user
removes them after checking the new entities.

## 10. Milestones

| | Scope |
|---|---|
| M0 | Repo scaffolding. **Done.** |
| M1 | Backend: profiles + config flow, frame assembler, zone engine, entities, zones in options, websocket config/zones/frames, input_text import. Tests with recorded production frames (including the 04:05 kitchen ghost). A dev-only simulator that replays exported history into fake target entities, so the dev container has realistic data. **Done.** |
| M2 | Panel: live view + polygon editor with snapping and readouts. **Done.** |
| M3 | History point cloud (WebGL) + trigger preview. **Done.** |
| M4 | Scrubber / replay + frame table + jump-to-trigger. **Done.** |
| M5 | Ghost filters with preview comparison; reconnect grace. **Done** (filters editable per zone; preview shows with/without). |
| Later | Floor-plan underlay image, multi-sensor rooms. (Live dashboard card: done.) |

## 11. Open questions

- ~~Screek 2A stale slots above `all_target_counts`?~~ — no; see §5.1.
- ~~Entities on the ESPHome device vs. our own device~~ — decided: attach to the radar's existing device (§7).
- ~~Zone storage~~ — decided: config entry options.
- Keep the JS state machine (preview) and the Python engine in lock-step:
  shared JSON test vectors run by both test suites.

## 9. Proposal: a home of radars and virtual presence devices (under discussion)

Goal: the integration should feel native in HA. Rooms show presence; radars
are hardware that feeds it. Today zones are entities on the radar's device,
which reads as "the living-room radar has a Kitchen sensor" and breaks down
once one zone is seen by several radars.

### 9.1 Model

| HA concept | What it is here |
|---|---|
| Config entry (one) | **The home**: the shared map, alignments, exits/doors, zones. |
| Subentry `radar` | One physical radar (picks the ESPHome device). Holds mounting, its exclusions (the fan in front of *this* radar) and its alignment to the home map. Adds a few diagnostic entities to the existing radar device (anyone in view, target count, excluded targets). No new device. |
| Subentry `zone` -> **device** | A virtual presence device, e.g. "Kitchen" or "Desk": own device, assigned to an area, model "Room" or "Spot", connected via its main radar. Entities: Occupancy (binary_sensor, device class occupancy), People (count), diagnostics (held, contributing radars). |
| Exits / doors | Home geometry (stairs, doorways, doors with swing and contact sensor), not owned by a radar. |

A single-radar home is the same model: the home map is that radar's frame
and nothing needs aligning.

### 9.2 How it looks in HA

- Devices: "Kitchen · Radar zone · Kitchen", "Desk · Radar zone · Living room".
- Area pages / area dashboards: the zone's Occupancy sensor makes the room
  show as occupied, like any other presence device in that area.
- Integration page: one entry with "Radars (3)" and "Zones (6)"; add or
  rename from there (subentry flows) or from the panel.
- Radar (ESPHome) device pages: a few diagnostic entities, nothing else.
- Automations target "Kitchen occupancy", not "8519b4 polygon 2".

### 9.3 Logic

- Zones are drawn once on the home map; every aligned radar that covers part
  of a zone evaluates its share (polygon transformed into its frame).
  Occupied = any radar sees someone inside.
- Hold until seen leaving works per zone across radars: a target lost by one
  radar but picked up by another nearby within ~2 s is a hand-over, not a
  vanish; leaving through an exit (or a door that just moved) releases.
- Exclusions stay per radar (ghosts are a property of one sensor's view).

### 9.4 Migration

Production has one radar entry (living room) with three zone entities.
Convert it into the home entry with one radar subentry and three zone
subentries, keeping entity ids (unique-id migration), so automations keep
working.

### 9.5 Open decisions

1. Zones as their own devices (proposed) vs entities on the radar device.
2. One home entry with radar subentries (proposed) vs one entry per radar
   plus a separate entry for shared zones.
3. Device naming: "Kitchen" vs "Kitchen presence" (entity becomes
   `binary_sensor.kitchen_occupancy` either way with has_entity_name).
4. Keep the radar-level "anyone in view" sensor (proposed: diagnostic).
