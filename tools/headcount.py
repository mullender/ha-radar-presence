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
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tests"))

import fixtures_util as fu  # noqa: E402

from custom_components.radar_zone_presence.engine import Zone, assemble, point_in_polygon  # noqa: E402
from custom_components.radar_zone_presence.engine.align import alignment_groups, apply, invert  # noqa: E402
from custom_components.radar_zone_presence.engine.headcount import HeadCount, Portal, Region  # noqa: E402
from custom_components.radar_zone_presence.engine.tracker import Observation, Tracker  # noqa: E402

OPEN_STATES = {"on", "open", "opening", "closing"}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", type=Path, nargs="+", required=True, help="export directories, merged")
    ap.add_argument("--configs", type=Path, required=True)
    ap.add_argument("--doors", type=Path, required=True)
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
    ap.add_argument("--quiet", action="store_true", help="only print the score")
    a = ap.parse_args()
    tz = dt.timezone(dt.timedelta(hours=a.tz))

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
    for g in groups:
        area = cfgs[g.anchor].get("device_area_id")
        if area not in floors or area in unobserved:
            continue
        name = area if area not in [r.id for r in regions] else f"{area}_{g.anchor[-4:]}"
        portals = tuple(
            Portal(z["name"], tuple(apply(g.to_anchor[rid], *pt) for pt in z["polygon"]), () if to == "outside" else tuple(to if isinstance(to, list) else [to]))
            for rid in g.members
            for z in cfgs[rid]["zones"]
            if z["kind"] == "exit" and (to := portal_map.get(area, {}).get(z["name"])) is not None
        )
        regions.append(Region(name, floors[area], tuple(exits.get(area, ())), cfgs[g.anchor]["title"], portals=portals))
        spots = [
            Zone(f"{rid}:{z['id']}", z["name"], z["kind"], tuple(apply(g.to_anchor[rid], *p) for p in z["polygon"]))
            for rid in g.members
            for z in cfgs[rid]["zones"]
            if z["kind"] in ("exit", "linger", "transient")
        ]
        trackers[name] = (Tracker(spots, [invert(g.to_anchor[r]) for r in g.members]), {r: [] for r in g.members}, g)
        for k, rid in enumerate(g.members):
            region_of[rid], index_of[rid] = name, k
            exclusions[rid] = [z["polygon"] for z in cfgs[rid]["zones"] if z["kind"] == "exclude"]

    doors = json.loads(a.doors.read_text())
    t0 = min(f[0].t for f in frames.values() if f)
    hc = HeadCount(regions, bootstrap_until=t0 + a.bootstrap_h * 3600, connections=[tuple(c) for c in json.loads(a.connections)])
    events = [(fr.t, 0, rid, fr) for rid, fs in frames.items() if rid in region_of for fr in fs]
    events += [(t, 1, e, s) for e, rows in doors.items() for t, s in rows]
    events.sort(key=lambda e: (e[0], e[1]))
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
        if kind == 1:
            hc.door(key, payload in OPEN_STATES, t)
            record(timeline, hc, t)
            if (t_from is None or t >= t_from) and key in hc._door_region:
                say(f"{fmt(t)}  door {key.split('.')[-1]} -> {payload}")
            continue
        name = region_of[key]
        tr, kept, g = trackers[name]
        a_ = g.to_anchor[key]
        kept[key] = [
            Observation(index_of[key], tg.slot, *apply(a_, tg.x, tg.y))
            for tg in payload.targets
            if not any(point_in_polygon(tg.x, tg.y, p) for p in exclusions[key])
        ]
        out = tr.fuse([o for obs in kept.values() for o in obs], t)
        hc.frame(name, {tg.slot: (tg.x, tg.y) for tg in out.targets}, t)
        if name in a.dump and (t_from is None or t >= t_from):
            ids = {tg.slot: (round(tg.x), round(tg.y), hc._binding.get((name, tg.slot))) for tg in out.targets}
            key = {k: v[2] for k, v in ids.items()}
            if key != dumped.get(name):
                dumped[name] = key
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
    for a, b, n, u in segs:
        if u:
            continue
        cuts = sorted({a, b, *(x for lo, hi, _ in bounds for x in (lo, hi) if a < x < b)})
        for c0, c1 in zip(cuts, cuts[1:]):
            mx = min((m for lo, hi, m in bounds if lo <= c0 and c1 <= hi), default=None)
            if mx is not None and n > mx:
                total["over_h"] += (c1 - c0) / 3600
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
    return out


if __name__ == "__main__":
    main()
