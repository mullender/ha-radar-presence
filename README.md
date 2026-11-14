# Radar Zone Presence

Home Assistant custom integration that turns the target coordinates of
LD2450-style mmWave radar sensors (Everything Presence Lite / Pro, Screek
Human Sensor 2A, other ESPHome LD2450 firmwares) into **named polygon presence
zones** — drawn in a dedicated editor, checked against a history point cloud,
and debuggable with a replay scrubber.

All logic runs in Home Assistant. The radar stays a dumb coordinate source;
nothing is written to the device.

## Features

- **One home, many radars.** The integration is set up once (the home);
  radars and zones are added on its page (*Add radar*, *Add zone*). Adding a
  radar lists devices with per-target X/Y sensors (with their area, floor and
  live target count) and discovers the entities.
- **Zones are presence devices** ("Desk Presence", "Kitchen Presence") in
  their own area, connected via the radar, so area pages and automations see
  them like any other occupancy sensor.
- **Radars that overlap work together.** Align a radar with a neighbour
  (from simultaneous detections, in the panel) and zones drawn on either are
  evaluated by both: the same person seen by two radars counts once, and
  walking from one radar's view into the other's is a hand-over, not someone
  vanishing.
- **Entry/exit points** (stairs, doorways, doors with swing and contact
  sensor): vanishing in one means someone left, appearing in one is someone
  new. Each exit logs *arrived* / *left* events.
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
- **Live playback** by default: the playhead follows now, with trails, zone
  states and the frame table updating in real time; pause to scrub back.
- **Replay scrubber:** timeline with activity, predicted vs recorded zone
  bands and trigger markers; play / step / speed; fading trails with
  timestamps; a frame table showing each target's position and every zone's
  inside/state per frame — "why did the lights come on?" in a minute.
- **Ghost filters** per zone: on delay, off delay, edge-margin hysteresis;
  reconnect grace per sensor.
- **Stay occupied until seen leaving** (per zone): LD2450 radars lose a
  person who sits still. With this on, a target that vanishes inside the zone
  keeps it occupied until someone is seen walking out (or a new target appears
  elsewhere, or *Max hold* runs out). No long off delay needed.
- **Suggested zones:** spots where targets dwell are found in the history and
  classified from their trails — a real spot (desk, couch) is walked into, a
  ghost (plant, fan, reflection) appears and vanishes in place. One click turns
  a spot into a zone or an exclusion, with a configurable outward / inward
  margin; *Fit to points* reshapes a rough zone around where people actually
  were. Zone edges that cut through a dwell spot are flagged.
- **Export / import** a radar's zones as JSON (backup, or move zones from a
  test instance to production). Import merges by name and is saved only when
  you press Save.

## Entities

Per zone, on its presence device (in the zone's area, or by default the
radar's):

| Entity | |
|---|---|
| `binary_sensor.<zone>_presence` | Occupancy; attributes `target_count`, `held`. |
| `sensor.<zone>_presence_targets` | Target count (disabled by default). |
| `binary_sensor.<zone>_presence_seen_by_<radar>` | Diagnostic, only for zones that several aligned radars cover: that radar sees someone in the zone. |

Per exit, on a small device of ours linked to the radar's device:

| Entity | |
|---|---|
| `event.<radar>_<exit>` | `arrived` / `left`. With a door sensor, only when the door moved within 30 s. |

The radar firmware already has its own occupancy and target count, so there
are no radar-level entities.

## Why not a template sensor?

The ESPHome firmwares publish X and Y as two separate state updates (X first,
Y 0.5–4 ms later), and Home Assistant drops updates whose value did not
change. A template that re-evaluates on each update pairs a new X with an old
Y, which makes zones flicker at their edges; triggering only on Y misses
frames where Y did not change. This integration coalesces updates into frames
(50 ms window) before evaluating zones, treats `y == 0` as an empty slot and
keeps legitimate `x == 0` readings. See [DESIGN.md](DESIGN.md) §4 for the
measurements.

## Install

**From the Marketplace** (Home Assistant's built-in replacement for HACS):

1. Settings → Marketplace → **Add from link** → `mullender/ha-radar-presence`
   (type *Integration* if asked; needs the Marketplace's GitHub connection).
2. Open the repository page, **Install**, and restart Home Assistant if asked.

The same repository also works as a HACS custom repository on older
installations.

**Manually:** copy `custom_components/radar_zone_presence/` from this
repository (Code → Download ZIP) into your Home Assistant's
`/config/custom_components/` (e.g. with the Samba share, SSH or Studio Code
Server add-on) and restart Home Assistant.

Then:

1. Settings → Devices & services → Add integration → *Radar Zone Presence*
   creates the home and asks for the first radar. More radars (and zones):
   *Add radar* / *Add zone* on the integration's page.
2. Open **Radar Zones** in the sidebar. It opens in live playback: what the
   radar sees right now, on top of the last 24 h. Zones exported from
   another instance load with *Import…*.
3. Draw or adjust zones and press **Save**; each include zone becomes a
   presence device. With overlapping radars, *Align with* (Sensor settings)
   lets them share zones.

Status: early development (v0.1). See [DESIGN.md](DESIGN.md),
[DEVELOPMENT.md](DEVELOPMENT.md) and [NOTES.md](NOTES.md).

## License

MIT — see [LICENSE](LICENSE).
