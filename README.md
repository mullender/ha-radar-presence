# Radar Presence

Home Assistant custom integration that turns the target coordinates of
LD2450-style mmWave radar sensors (Everything Presence Lite / Pro, Screek
Human Sensor 2A, other ESPHome LD2450 firmwares) into **room and spot
occupancy** and an **occupant count** for the home, each floor and each
room. Mostly for automating lights and climate.

All logic runs in Home Assistant. The radar stays a dumb coordinate source;
nothing is written to the device.

## Features

- **One home, many radars.** The integration is set up once (the home);
  radars are added on its page (*Add radar*). A new radar's room has presence
  right away; spots, doorways and ignore areas are added in the panel.
- **Rooms and spots are occupancy devices** ("Living room Occupancy", "Desk
  Occupancy") in their own area, so area pages, dashboards and automations
  see them like any other occupancy sensor. A spot's own sensor is optional:
  without it a spot (bed, sofa, desk chair) still keeps its room occupied
  while someone sits still.
- **Occupants**: how many people are home, per floor and per room, from
  radars, doors to outside, activity hints (switches used by hand) and
  occupancy sensors (a bed sensor). While a door to outside is in use and it
  is not yet sure who went out, the count says *settling* (`2+`).
- **Radars that overlap work together.** Line a radar up with a neighbour
  (from simultaneous detections) and they share their shapes: the same person
  seen by two radars counts once, and walking from one view into the other is
  a hand-over.
- **Doorways** (doors, openings, stairs), with a door sensor and the door's
  swing: vanishing in one means someone left, appearing in one is someone new.
  Each doorway logs *arrived* / *left* events.
- **Presence panel** (sidebar):
  - **House**: floors and rooms with who is where, and **Activity** in plain
    sentences ("Someone came home through the garage door") with *How we
    know*, *Follow person A* and a jump to the radar at that moment. A floor
    whose rooms are drawn on one linked map can show as a **Plan**.
  - **Radars**: the map of what a radar sees (detections, trails, people) with
    a timeline and playhead — live, or back in time. Clicking a bar explains
    why a room was on and offers the fix (ignore that spot, turn on after
    3 s, remember people who sit still).
  - **Edit** (a separate mode): rooms, spots, doorways and ignore areas with
    polygon / rectangle tools, snapping, undo, and a preview of how often the
    edited shapes would have turned on over the loaded history.
  - **To do**: questions from the last day of each radar, one at a time —
    "Someone sits here: a seat or a fan?", "People appear and vanish here: a
    doorway?", "Short blips turn the hall on", door sensors that line up with
    a radar, rooms without a radar or a doorway. Each answer makes one change
    (with Undo) and shows what it would have changed yesterday. When a new
    radar has learned for a few days, a notification says how many
    suggestions are waiting.
  - **Settings**: outside doors, activity hints, occupancy sensors and robot
    vacuums, with likely entities suggested.
  - **Setting up a radar**: a mounting check with your live dot ("walk to
    your right") that flips or rotates the view, and the zones saved on the
    radar as a starting point.
  - **Report a problem**: one window, anonymized, as a file to attach to an
    issue (see `tools/load_report.py`).
  - People who aren't admins get the panel read-only.
- **Dashboard cards**: occupants (badge, tile, floors, floors + rooms, with +
  / − to correct) and a live radar card.
- **Blueprints**: lights follow occupancy, heat only occupied rooms, everyone
  left. Added to *Settings → Automations → Blueprints* on setup.
- **People tracking:** the radar's target numbers are not identities. The
  integration follows people by position: a reading only continues a person
  if they could have walked there.
- **Remember people who sit still** (per room): LD2450 radars lose a person
  who sits still. With this on, someone who vanishes inside keeps the room
  occupied until they are seen leaving, or a hold limit runs out.
- **Export / import** a radar's shapes as JSON.

## Entities

Per room or spot with an occupancy sensor (device model Room or Spot, in its
area):

| Entity | |
|---|---|
| `binary_sensor.<name>_occupancy` | Occupancy; attributes `target_count`, `held`. |
| `sensor.<name>_targets` | Target count (disabled by default). |
| `binary_sensor.<name>_seen_by_<radar>` | Diagnostic, only where several linked radars see the room: that radar sees someone. |

Entity ids made by earlier versions (`…_presence`) are kept.

Each room device also has *Occupants* (people counted there). A room the
count knows but no room shape covers (a bedroom without a radar, counted at
its doors) gets a device of its own with *Occupancy* and *Occupants*.

On the home device: *Occupants*, *<floor> occupants* and a *Nobody home*
button. Per doorway, on a small device linked to the radar:
`event.<radar>_<doorway>` (`arrived` / `left`).

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

1. Settings → Devices & services → Add integration → *Radar Presence*
   creates the home and asks for the first radar. More radars: *Add radar* on
   the integration's page.
2. Open **Presence** in the sidebar. It opens on the House; *Radars* shows
   what each radar sees, live or back in time.
3. A new radar opens with a short mounting check. Then let it learn for a
   few days and answer the questions in **To do**; **Edit** is for drawing
   by hand (open-plan splits, corrections). With overlapping radars, *Line
   up with…* (⋮) lets them share shapes.

Status: early development (v0.1). See [DESIGN.md](DESIGN.md),
[DEVELOPMENT.md](DEVELOPMENT.md) and [NOTES.md](NOTES.md).

## License

MIT — see [LICENSE](LICENSE).
