# Radar Zone Presence

Home Assistant custom integration that turns the target coordinates of
LD2450-style mmWave radar sensors (Everything Presence Lite / Pro, Screek
Human Sensor 2A, other ESPHome LD2450 firmwares) into **named polygon presence
zones** — drawn in a dedicated editor, checked against a history point cloud,
and debuggable with a replay scrubber.

All logic runs in Home Assistant. The radar stays a dumb coordinate source;
nothing is written to the device.

## Features

- **Pick a radar, get zones.** The config flow lists devices with per-target
  X/Y sensors and discovers the entities. Existing
  `input_text.<device>_zone_polygon_N` helpers can be imported.
- **Radar Zones panel** (sidebar):
  - Draw polygons or rectangles; edges snap to 45°/90°, relative to the
    previous edge, and the closing corner squares up to the start. Vertex and
    grid snapping; Shift draws freely.
  - Drag vertices (snaps to both neighbouring edges), drag an edge to move it
    parallel, insert / delete vertices, numeric vertex table, undo / redo.
  - Live edge lengths and interior angles, a measure tool, the sensor's field
    of view and the device's own zones as context.
  - **Include and exclude zones.** Exclusions are sensor-wide and applied
    before any include zone — draw one around the plant or the fan.
- **History point cloud** (15 min … 7 days, WebGL) behind the editor, coloured
  by target, by age, or by "inside the selected zone / excluded".
- **Preview before saving:** how often and when the draft zone would have
  turned on over the loaded history, with and without filters, plus a
  clickable trigger list.
- **Replay scrubber:** timeline with activity, predicted vs recorded zone
  bands and trigger markers; play / step / speed; fading trails with
  timestamps; a frame table showing each target's position and every zone's
  inside/state per frame — "why did the lights come on?" in a minute.
- **Ghost filters** per zone: on delay, off delay, edge-margin hysteresis;
  reconnect grace per sensor.

## Entities

Per radar (all attached to the radar's existing device, so they inherit its
area; a zone can override the area):

| Entity | |
|---|---|
| `binary_sensor.<device>_<zone>` | Presence per include zone; attributes `target_count`, `targets`. |
| `binary_sensor.<device>_zone_presence_any` | Any target not inside an exclusion. |
| `sensor.<device>_<zone>_targets` | Target count per zone (disabled by default). |
| `sensor.<device>_excluded_targets` | Diagnostic: targets currently excluded. |

## Why not a template sensor?

The ESPHome firmwares publish X and Y as two separate state updates (X first,
Y 0.5–4 ms later), and Home Assistant drops updates whose value did not
change. A template that re-evaluates on each update pairs a new X with an old
Y, which makes zones flicker at their edges; triggering only on Y misses
frames where Y did not change. This integration coalesces updates into frames
(50 ms window) before evaluating zones, treats `y == 0` as an empty slot and
keeps legitimate `x == 0` readings. See [DESIGN.md](DESIGN.md) §4 for the
measurements.

## Install (HACS custom repository)

1. HACS → ⋮ → Custom repositories → `https://github.com/mullender/ha-radar-presence`, category *Integration*.
2. Download *Radar Zone Presence*, restart Home Assistant.
3. Settings → Devices & services → Add integration → *Radar Zone Presence*, pick a radar.
4. Open **Radar Zones** in the sidebar and draw zones.

Status: early development (v0.1). See [DESIGN.md](DESIGN.md),
[DEVELOPMENT.md](DEVELOPMENT.md) and [NOTES.md](NOTES.md).

## License

MIT — see [LICENSE](LICENSE).
