"""Replay the home's head count (engine/headcount.py) over exported history.

Every alignment group of radars is one region (named after its anchor's
area); each runs through its own tracker, and the head count combines them
with the true exit doors.

  .venv/bin/python tools/headcount.py --data dev/data dev/data/recent \
      --configs /tmp/devcfg --doors dev/data/doors.json \
      --floors '{"bedroom": 3, "laundry_room": 3, "living_room": 2, "kitchen": 2, "entry": 1, "garage": 1}' \
      --exits '{"entry": ["binary_sensor.front_door_lock_door"], "garage": ["cover.ratgdo32disco_313e18_door"]}' \
      --portals '{"entry": {"Front door": "outside", "Garage Entry Door": "garage", "Stairs": "living_room"}}' \
      --truth dev/data/truth.json --from 2026-11-14T07:30 --to 2026-11-14T10:15 --tz -8

--doors: {entity_id: [[epoch_s, state], ...]} (binary_sensor on/off, or cover
open/opening/closing/closed). Times are printed in --tz (hours from UTC).
"""

from __future__ import annotations

import argparse
import datetime as dt
import gzip
import heapq
import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tests"))

import fixtures_util as fu  # noqa: E402

from custom_components.radar_zone_presence.engine import Zone, assemble, point_in_polygon  # noqa: E402
from custom_components.radar_zone_presence.engine.align import alignment_groups, apply, invert  # noqa: E402
from custom_components.radar_zone_presence.engine.headcount import HeadCount, Portal, Region  # noqa: E402
from custom_components.radar_zone_presence.engine.rooms import RoomRadar, Rooms  # noqa: E402
from custom_components.radar_zone_presence.engine.tracker import Observation, Tracker, side_margin  # noqa: E402

OPEN_STATES = {"on", "open", "opening", "closing"}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", type=Path, nargs="+", required=True, help="export directories, merged")
    ap.add_argument("--configs", type=Path, required=True)
    ap.add_argument("--doors", type=Path, required=True)
    ap.add_argument("--vacuums", default="{}", help='JSON: robot vacuum -> its current room sensor (rows of both in --doors): while it cleans, the radars in that room are ignored')
    ap.add_argument("--door-locks", default="{}", help='JSON: door contact -> its lock (rows in --doors): locked means closed, as the integration pairs a lock on the same device')
    ap.add_argument("--floors", required=True, help="JSON: area id -> floor level")
    ap.add_argument("--exits", required=True, help="JSON: area id -> [true exit door entity ids]")
    ap.add_argument("--unobserved", default="{}", help='JSON: area -> floor of areas without a usable radar (their radar is ignored)')
    ap.add_argument("--connections", default="[]", help='JSON: [[area, area, door entity], ...] crossings that need that door')
    ap.add_argument("--from", dest="t_from")
    ap.add_argument("--to", dest="t_to")
    ap.add_argument("--tz", type=float, default=0.0)
    ap.add_argument("--trace", type=int, help="also print every change of this token")
    ap.add_argument("--bootstrap-h", type=float, default=2.0, help="hours at the start where new people need no door")
    ap.add_argument("--portals", default="{}", help='JSON: area -> {exit zone name: area it leads to, or "outside"}')
    ap.add_argument("--extra-zones", default="{}", help="JSON: radar title suffix -> [zone dicts] added to its config (try zones before drawing them)")
    ap.add_argument("--truth", type=Path, help="ground truth JSON (exact counts, upper bounds) to score against")
    ap.add_argument("--dump", nargs="*", default=[], help="print these regions' tracks (and their tokens) whenever they change")
    ap.add_argument("--set", nargs="*", default=[], help="override engine constants, e.g. VIRTUAL_EXITS=0 LAG_S=60")
    ap.add_argument("--no-cross-check", dest="cross_check", action="store_false", help="do not flag one-radar reflections")
    ap.add_argument("--from-leads-to", action="store_true",
                    help="build spaces, doorways, connections and exits from the exit zones' leads_to (as the integration does)")
    ap.add_argument("--outside-doors", default="{}", help='JSON: door entity -> area, doors to outside no radar sees (with --from-leads-to)')
    ap.add_argument("--evidence", type=Path, help="logbook JSON: entity -> [[t, state, by hand, origin], ...] (switches, contacts)")
    ap.add_argument("--evidence-areas", default="{}", help='JSON: entity -> [area, only switching on counts]')
    ap.add_argument("--quiet", action="store_true", help="only print the score")
    a = ap.parse_args()
    tz = dt.timezone(dt.timedelta(hours=a.tz))
    import custom_components.radar_zone_presence.engine.headcount as hc_mod

    for kv in a.set:
        k, v = kv.split("=")
        old = getattr(hc_mod, k)
        setattr(hc_mod, k, type(old)(float(v)) if not isinstance(old, bool) else v.lower() in ("1", "true", "yes"))

    def ts(s: str | None) -> float | None:
        return dt.datetime.fromisoformat(s).replace(tzinfo=tz).timestamp() if s else None

    def fmt(t: float) -> str:
        return dt.datetime.fromtimestamp(t, tz).strftime("%a %H:%M:%S")

    floors = json.loads(a.floors)
    exits = json.loads(a.exits)
    cfgs = {}
    for f in sorted(a.configs.glob("*.json")):
        x = json.loads(f.read_text())
        x = x[0] if isinstance(x, list) else x
        x = x.get("result", x)
        cfgs[x["radar_id"]] = x
    for suffix, zs in json.loads(a.extra_zones).items():
        c = next(c for c in cfgs.values() if c["title"].endswith(suffix))
        c["zones"] = [*c["zones"], *({"id": f"extra{k}", **z} for k, z in enumerate(zs))]
    portal_map = json.loads(a.portals)
    groups = alignment_groups({rid: (c["settings"].get("display") or {}).get("aligned_to") for rid, c in cfgs.items()})
    if a.from_leads_to:
        a.unobserved, a.connections, a.exits, portal_map = from_leads_to(cfgs, groups, floors, json.loads(a.outside_doors))
        exits = json.loads(a.exits)

    frames: dict[str, list] = {}
    for rid, c in cfgs.items():
        slug = c["targets"][0]["x"].split(".")[1].rsplit("_target", 1)[0]
        merged = {}
        for d in a.data:
            p = d / f"{slug}.json.gz"
            if p.exists():
                doc = json.loads(gzip.open(p).read())
                for fr in assemble(fu.assembler(doc), fu.events(doc)):
                    merged[round(fr.t, 3)] = fr
        frames[rid] = [merged[k] for k in sorted(merged)]

    unobserved = json.loads(a.unobserved)
    regions, trackers, region_of, index_of, exclusions = [], {}, {}, {}, {}
    for area, floor in unobserved.items():
        regions.append(Region(area, floor, tuple(exits.get(area, ())), area, observed=False))
    group_links = []
    for g in groups:
        parts = group_rooms(g, cfgs, floors, unobserved)
        if parts is None:
            continue
        feed_area, zone_rooms = parts
        region_of_area = {}
        for area in dict.fromkeys([*feed_area.values(), *(r for r, _ in zone_rooms)]):
            name = area if area not in [r.id for r in regions] else f"{area}_{g.anchor[-4:]}"
            portals = tuple(
                Portal(z["name"], tuple(apply(g.to_anchor[rid], *pt) for pt in z["polygon"]), () if to == "outside" else tuple(to if isinstance(to, list) else [to]))
                for rid in feed_area
                if feed_area[rid] == area
                for z in cfgs[rid]["zones"]
                if z["kind"] == "exit" and (to := portal_map.get(area, {}).get(z["name"])) is not None
            )
            regions.append(Region(name, floors[area], tuple(exits.get(area, ())), area, portals=portals))
            region_of_area[area] = name
        ids = list(region_of_area.values())
        group_links += [[x, y, None] for i, x in enumerate(ids) for y in ids[i + 1 :]]
        rooms = None
        if len(region_of_area) > 1:
            max_d = {rid: cfgs[rid]["fov"]["max_distance_mm"] for rid in g.members}
            rooms = Rooms([RoomRadar(area, rid, g.to_anchor[rid]) for rid, area in feed_area.items()], max_d.__getitem__, zone_rooms)
        spots = [
            Zone(f"{rid}:{z['id']}", z["name"], z["kind"], tuple(apply(g.to_anchor[rid], *p) for p in z["polygon"]))
            for rid in g.members
            for z in cfgs[rid]["zones"]
            if z["kind"] in ("exit", "linger", "transient")
        ]
        key = g.anchor
        trackers[key] = (Tracker(spots, [invert(g.to_anchor[r]) for r in g.members]), {r: [] for r in g.members}, g, rooms, region_of_area)
        for k, rid in enumerate(g.members):
            region_of[rid], index_of[rid] = key, k
            exclusions[rid] = [z["polygon"] for z in cfgs[rid]["zones"] if z["kind"] == "exclude"]

    doors = json.loads(a.doors.read_text())
    t0 = min(f[0].t for f in frames.values() if f)
    conns = json.loads(a.connections)
    have = {frozenset(c[:2]) for c in conns}
    same_area = {}
    for r in regions:
        same_area.setdefault(r.name, []).append(r.id)  # Region.name is the area
    for ids in same_area.values():
        group_links += [[x, y, None] for i, x in enumerate(ids) for y in ids[i + 1 :]]  # one room, two trackers
    conns += [c for c in group_links if frozenset(c[:2]) not in have]
    hc = HeadCount(regions, bootstrap_until=t0 + a.bootstrap_h * 3600, connections=[tuple(c) for c in conns])
    events = [(fr.t, 0, rid, fr) for rid, fs in frames.items() if rid in region_of for fr in fs]
    events += [(t, 1, e, s) for e, rows in doors.items() for t, s in rows]
    if a.evidence:
        ev_areas = json.loads(a.evidence_areas)
        area_region = {}
        for r in regions:
            area_region.setdefault(r.name, r.id)
        for e, rows in json.loads(a.evidence.read_text()).items():
            if e not in ev_areas or (region := area_region.get(ev_areas[e][0])) is None:
                continue
            prev = None
            rows = sorted(rows)
            flicker = set()  # door contacts open < 2 s (like the runtime): both edges ignored
            if e.startswith("binary_sensor."):
                for i in range(len(rows) - 1):
                    if rows[i][1] == "on" and rows[i + 1][1] == "off" and rows[i + 1][0] - rows[i][0] < 2.0:
                        flicker |= {i, i + 1}
            for i, (t, state, by_hand, _origin) in enumerate(rows):
                usable = i not in flicker and state not in ("unavailable", "unknown") and (e.startswith("event.") or (prev not in (None, "unavailable", "unknown") and prev != state))
                prev = state
                if usable and by_hand and (not ev_areas[e][1] or state == "on"):
                    off = state == "off" and e.split(".")[0] in ("light", "switch", "fan", "input_boolean")
                    events.append((t, 2, region, (e, not off)))
    door_locks = json.loads(a.door_locks)
    events.sort(key=lambda e: (e[0], e[1]))
    lock_state: dict[str, str] = {}
    door_state: dict[str, str] = {}  # contacts' own states (paired with a lock)
    vacuums = json.loads(a.vacuums)
    vac_watch = set(vacuums) | set(vacuums.values())
    vac_state: dict[str, str] = {}
    vacuumed: set[str] = set()

    def next_room(room: str, t: float) -> str:
        return next((s_ for t_, s_ in sorted(doors.get(room, [])) if t <= t_ <= t + 600 and s_ not in ("unknown", "unavailable", "")), "")
    area_of = {r.id: r.name.replace("_", " ").casefold() for r in regions}
    t_from, t_to = ts(a.t_from), ts(a.t_to)
    last_counts = None
    timeline: list[tuple[float, int, bool]] = []  # (t, home count, unknown)
    say = (lambda *_: None) if a.quiet else print
    dumped: dict[str, dict] = {}
    n_changes = 0
    tick = None
    for t, kind, key, payload in events:
        if t_to is not None and t > t_to:
            break
        # Departures are decided on a timer in HA; here a 5 s tick between events.
        tick = t if tick is None else tick
        while tick + 5 < t:
            tick += 5
            n_before = len(hc.changes)
            hc.advance(tick)
            record(timeline, hc, tick)
            for c in hc.changes[n_before:]:
                if c.kind in ("left", "back", "arrived", "not a person", "confirmed") and (t_from is None or tick >= t_from):
                    floors_s = "  ".join(f"F{fl}:{n}" for fl, n in sorted(hc.by_floor().items(), reverse=True))
                    say(f"{fmt(tick)}  home {hc.count()}  {floors_s}   {c.kind} #{c.token} {c.region} {c.detail}")
        n_changes = len(hc.changes) if tick + 5 >= t and n_changes < len(hc.changes) and hc.changes[-1].kind == "left" else n_changes
        if kind == 2:
            hc.evidence(key, t, payload[0], move=payload[1])
            record(timeline, hc, t)
            continue
        if kind == 1 and key in vac_watch:
            vac_state[key] = payload
            active = [room for vac, room in vacuums.items() if vac_state.get(vac) in ("cleaning", "returning")]
            # The room it reports a minute or two after starting is where it was all along (the integration
            # replays those minutes once it knows; here we can just look ahead).
            rooms_now = {(vac_state.get(room) if vac_state.get(room) not in (None, "unknown", "unavailable", "") else next_room(room, t)).casefold() for room in active}
            now = {rid for rid, area in area_of.items() if area in rooms_now}
            if now != vacuumed and (t_from is None or t >= t_from):
                say(f"{fmt(t)}  vacuum cleaning: {', '.join(sorted(now)) or 'done'}")
            vacuumed = now
            continue
        if kind == 1:
            if key.startswith("lock."):
                lock_state[key] = payload
                for door, lock in door_locks.items():
                    if lock == key and payload == "locked" and hc._door_seen.get(door, (False,))[0]:
                        hc.door(door, False, t)
                        record(timeline, hc, t)
                        if t_from is None or t >= t_from:
                            say(f"{fmt(t)}  door {door.split('.')[-1]} -> off (locked)")
                    if lock == key and payload != "locked" and door_state.get(door) in OPEN_STATES and not hc._door_seen.get(door, (False,))[0]:
                        hc.door(door, True, t)  # unlocked: the contact counts again, it may say open already
                        record(timeline, hc, t)
                        if t_from is None or t >= t_from:
                            say(f"{fmt(t)}  door {door.split('.')[-1]} -> {door_state[door]} (unlocked)")
                if key not in hc._door_region:
                    continue
            elif key in door_locks:
                door_state[key] = payload
                if payload in OPEN_STATES and lock_state.get(door_locks[key]) == "locked":
                    if t_from is None or t >= t_from:
                        say(f"{fmt(t)}  door {key.split('.')[-1]} -> {payload} ignored: locked")
                    continue
            hc.door(key, payload in OPEN_STATES, t)
            record(timeline, hc, t)
            if (t_from is None or t >= t_from) and key in hc._door_region:
                say(f"{fmt(t)}  door {key.split('.')[-1]} -> {payload}")
            continue
        tr, kept, g, rooms, region_of_area = trackers[region_of[key]]
        a_ = g.to_anchor[key]
        kept[key] = [
            Observation(index_of[key], tg.slot, *apply(a_, tg.x, tg.y))
            for tg in payload.targets
            if not any(point_in_polygon(tg.x, tg.y, p) for p in exclusions[key])
        ]
        out = tr.fuse([o for obs in kept.values() for o in obs], t)
        tracks = {tg.slot: (tg.x, tg.y) for tg in out.targets}
        flagged = unconfirmed(tr, out, g, cfgs) if a.cross_check else set()
        if rooms is None:
            region = next(iter(region_of_area.values()))
            hc.frame(region, {} if region in vacuumed else tracks, t, flagged)
        else:
            parts = {region_of_area[r]: part for r, part in rooms.split(tracks).items()}
            hc.frame_group({r: {} if r in vacuumed else part for r, part in parts.items()}, t, flagged)
        for name in region_of_area.values():
            if name in a.dump and (t_from is None or t >= t_from):
                ids = {s_: (round(x), round(y), hc._binding.get((name, s_))) for s_, (x, y) in hc._pos[name].items()}
                dkey = {k: v[2] for k, v in ids.items()}
                if dkey != dumped.get(name):
                    dumped[name] = dkey
                    say(f"{fmt(t)}    [{name}] " + "  ".join(f"t{k}@({x},{y})->#{tok}" for k, (x, y, tok) in sorted(ids.items())))
        record(timeline, hc, t)
        counts = (hc.count(), tuple(sorted(hc.by_floor().items(), reverse=True)))
        new_changes = hc.changes[n_changes:]
        n_changes = len(hc.changes)
        if counts != last_counts or any(c.kind not in ("moved", "not a person", "ghost") for c in new_changes) or (a.trace and any(f"#{a.trace}" == f"#{c.token}" for c in new_changes)):
            if t_from is None or t >= t_from:
                floors_s = "  ".join(f"F{fl}:{n}" for fl, n in counts[1])
                why = "; ".join(f"{c.kind} #{c.token} {c.region} {c.detail}".strip() for c in new_changes)
                say(f"{fmt(t)}  home {counts[0]}  {floors_s}   {why}")
            last_counts = counts

    if timeline:
        timeline.append((tick if tick is not None else timeline[-1][0], *timeline[-1][1:]))
    if a.truth:
        exits_all = {e for es in exits.values() for e in es}
        door_times = [(t, s) for e, rows in doors.items() if e in exits_all for t, s in rows]
        for line in score(timeline, json.loads(a.truth.read_text()), door_times, fmt):
            print(line)


def from_leads_to(cfgs: dict, groups: list, floors: dict, outside_doors: dict) -> tuple[str, str, str, dict]:
    """--unobserved / --connections / --exits / portal map from the exit zones' leads_to, like headcount_runtime."""
    observed = set()
    for g in groups:
        if (parts := group_rooms(g, cfgs, floors, {})) is not None:
            observed |= set(parts[0].values()) | {r for r, _ in parts[1]}
    unobserved: dict[str, int] = {}
    links: dict[frozenset, str | None] = {}
    exits: dict[str, list[str]] = {}
    portal_map: dict[str, dict[str, object]] = {}
    for g in groups:
        if (parts := group_rooms(g, cfgs, floors, {})) is None:
            continue
        for rid, area in parts[0].items():
            for z in cfgs[rid]["zones"]:
                if z["kind"] != "exit" or not z.get("leads_to"):
                    continue
                dests = [d for d in z["leads_to"] if d != "outside" and d != area]
                if "outside" in z["leads_to"] and z.get("door_entity_id"):
                    exits.setdefault(area, []).append(z["door_entity_id"])
                for d in dests:
                    if d not in observed:
                        unobserved[d] = floors.get(d, 0)
                    key = frozenset((area, d))
                    if links.get(key) is None:
                        links[key] = z.get("door_entity_id")
                portal_map.setdefault(area, {})[z["name"]] = dests if dests else "outside"
    for door, area in outside_doors.items():
        if area not in observed:
            unobserved[area] = floors.get(area, 0)
        exits.setdefault(area, []).append(door)
    connections = [[*sorted(k), door] for k, door in links.items()]
    return json.dumps(unobserved), json.dumps(connections), json.dumps(exits), portal_map


def group_rooms(g, cfgs: dict, floors: dict, unobserved: dict):
    """(radar id -> area, [(zone area, polygon in the anchor frame)]) of a group's head-count radars, like the runtime."""
    anchor_area = cfgs[g.anchor].get("device_area_id")
    feed_area = {}
    for rid in g.members:
        area = cfgs[rid].get("device_area_id") or anchor_area
        if cfgs[rid]["settings"].get("headcount", True) and area in floors and area not in unobserved:
            feed_area[rid] = area
    if not feed_area:
        return None
    zone_rooms = [
        (area, tuple(apply(g.to_anchor[rid], *pt) for pt in z["polygon"]))
        for rid in feed_area
        for z in cfgs[rid]["zones"]
        if z["kind"] == "include" and (area := z.get("area_id") or feed_area[rid]) in floors and area not in unobserved
    ]
    return feed_area, zone_rooms


def unconfirmed(tr, out, g, cfgs) -> set[int]:
    """Tracks seen by one radar only, at a spot another radar of the group covers (it would have seen them)."""
    if len(g.members) < 2:
        return set()
    flagged = set()
    for tg in out.targets:
        radars = {m[0] for m in tr._tracks[tg.slot].members} if tg.slot in tr._tracks else set()
        if len(radars) != 1:
            continue
        for k, rid in enumerate(g.members):
            if k in radars:
                continue
            x, y = apply(invert(g.to_anchor[rid]), tg.x, tg.y)
            if side_margin(x, y) >= 500 and math.hypot(x, y) <= cfgs[rid]["fov"]["max_distance_mm"] - 500:
                flagged.add(tg.slot)
                break
    return flagged


def record(timeline: list, hc: HeadCount, t: float) -> None:
    unknown = bool(getattr(hc, "unknown", lambda: False)())
    n = hc.count()
    if not timeline or timeline[-1][1:] != (n, unknown):
        timeline.append((t, n, unknown))


EXIT_SETTLE_S = 600.0  # a count may change up to this long after an exit door was used


def score(timeline: list, truth: dict, door_times: list, fmt) -> list[str]:
    """Hours wrong against exact intervals, hours above upper bounds, count changes without an exit door."""
    tz = dt.timezone(dt.timedelta(hours=truth.get("tz", 0)))

    def ts(s: str) -> float:
        return dt.datetime.fromisoformat(s).replace(tzinfo=tz).timestamp()

    t0, t_end = timeline[0][0], timeline[-1][0]
    segs = [(t, nxt[0] if (nxt := timeline[k + 1] if k + 1 < len(timeline) else None) else t_end, n, u)
            for k, (t, n, u) in enumerate(timeline)]
    out, total = [], {"wrong_h": 0.0, "exact_h": 0.0, "over_h": 0.0, "unknown_h": 0.0}
    for lo_s, hi_s, want, why in truth.get("exact", []):
        lo, hi = max(ts(lo_s), t0), min(ts(hi_s), t_end)
        if hi <= lo:
            continue
        wrong = unknown = 0.0
        seen: dict[int, float] = {}
        for a, b, n, u in segs:
            d = max(0.0, min(b, hi) - max(a, lo))
            if not d:
                continue
            if u:
                unknown += d
            elif n != want:
                wrong += d
            seen[n] = seen.get(n, 0.0) + d
        total["wrong_h"] += wrong / 3600
        total["unknown_h"] += unknown / 3600
        total["exact_h"] += (hi - lo) / 3600
        counts = ", ".join(f"{n}: {d / 3600:.1f}h" for n, d in sorted(seen.items()))
        out.append(f"  {fmt(lo)} - {fmt(hi)}  want {want}  wrong {wrong / 3600:.2f}h  ({counts})  {why}")
    bounds = [(ts(lo), ts(hi), n) for lo, hi, n, _ in truth.get("max", [])]
    over: list[tuple[float, float, int, int]] = []
    for a, b, n, u in segs:
        if u:
            continue
        cuts = sorted({a, b, *(x for lo, hi, _ in bounds for x in (lo, hi) if a < x < b)})
        for c0, c1 in zip(cuts, cuts[1:]):
            mx = min((m for lo, hi, m in bounds if lo <= c0 and c1 <= hi), default=None)
            if mx is not None and n > mx:
                total["over_h"] += (c1 - c0) / 3600
                over.append((c0, c1, n, mx))
    door_ts = sorted(t for t, _ in door_times)
    stray = []
    import bisect
    for k in range(1, len(timeline)):
        t, n, u = timeline[k]
        if u or timeline[k - 1][2] or n == timeline[k - 1][1]:
            continue
        i = bisect.bisect_right(door_ts, t)
        if i == 0 or t - door_ts[i - 1] > EXIT_SETTLE_S:
            stray.append((t, timeline[k - 1][1], n))
    changes = sum(1 for k in range(1, len(timeline)) if timeline[k][1] != timeline[k - 1][1])
    out.insert(0, (
        f"SCORE  wrong {total['wrong_h']:.2f}h of {total['exact_h']:.1f}h exact  over-bound {total['over_h']:.2f}h  "
        f"unknown {total['unknown_h']:.2f}h  changes {changes}  without a door {len(stray)}"
    ))
    out += [f"  no door: {fmt(t)} {a} -> {b}" for t, a, b in stray[:15]]
    out += [f"  over: {fmt(a)} - {fmt(b)} count {n} > {m}" for a, b, n, m in sorted(over, key=lambda o: o[0] - o[1])[:8]]
    return out


if __name__ == "__main__":
    main()
