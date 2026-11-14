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
- Display orientation is a per-sensor UI preference (default: sensor at the
  bottom facing up, like the kitchen analysis; optional rotate 90°/180°/270°
  and mirror). It never changes stored geometry.
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

### 8.4 Scrubber / replay

- Timeline under the plot with the loaded window, zone on/off bands per zone,
  and markers for every trigger.
- Play / pause / speed (1×, 4×, 16×), step frame-by-frame.
- Shows each target's current point plus a fading trail with timestamps, and
  a side table of frames around the cursor (`t, slot, x, y, inside?`) — the
  "kitchen ghost" analysis, generated on demand.
- Click a trigger marker or pick from the zone's history → jump there with
  the window zoomed to ±30 s.

## 9. Migration

A one-time import (options flow step and panel button) finds
`input_text.<device_slug>_zone_polygon_<n>`, converts its vertices from the
target sensors' unit to mm, and creates include zones named
`Polygon <n>`. Old helpers and the YAML package are left untouched; the user
removes them after checking the new entities.

## 10. Milestones

| | Scope |
|---|---|
| M0 | Repo scaffolding (this commit). |
| M1 | Backend: profiles + config flow, frame assembler, zone engine, entities, zones in options, websocket config/zones/frames, input_text import. Tests with recorded production frames (including the 04:05 kitchen ghost). A dev-only simulator that replays exported history into fake target entities, so the dev container has realistic data. |
| M2 | Panel: live view + polygon editor with snapping and readouts. |
| M3 | History point cloud (WebGL) + trigger preview. |
| M4 | Scrubber / replay + frame table + jump-to-trigger. |
| M5 | Ghost filters with preview comparison; reconnect grace. |
| Later | Floor-plan underlay image, live dashboard card, multi-sensor rooms. |

## 11. Open questions

- ~~Screek 2A stale slots above `all_target_counts`?~~ — no; see §5.1.
- ~~Entities on the ESPHome device vs. our own device~~ — decided: attach to the radar's existing device (§7).
- ~~Zone storage~~ — decided: config entry options.
- Keep the JS state machine (preview) and the Python engine in lock-step:
  shared JSON test vectors run by both test suites.
