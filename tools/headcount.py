"""Replay the home's head count (engine/headcount.py) over exported history.

Every alignment group of radars is one region (named after its anchor's
area); each runs through its own tracker, and the head count combines them
with the true exit doors.

  .venv/bin/python tools/headcount.py --data dev/data dev/data/recent \
      --configs /tmp/devcfg --doors dev/data/doors.json \
      --floors '{"bedroom": 3, "laundry_room": 3, "living_room": 2, "kitchen": 2, "entry": 1, "garage": 1}' \
      --exits '{"entry": ["binary_sensor.front_door_lock_door"], "garage": ["cover.ratgdo32disco_313e18_door"]}' \
      --from 2026-11-14T07:30 --to 2026-11-14T10:15 --tz -8

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
from custom_components.radar_zone_presence.engine.headcount import HeadCount, Region  # noqa: E402
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
        regions.append(Region(name, floors[area], tuple(exits.get(area, ())), cfgs[g.anchor]["title"]))
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
            for c in hc.changes[n_before:]:
                if c.kind == "left" and (t_from is None or tick >= t_from):
                    floors_s = "  ".join(f"F{fl}:{n}" for fl, n in sorted(hc.by_floor().items(), reverse=True))
                    print(f"{fmt(tick)}  home {hc.count()}  {floors_s}   left #{c.token} {c.region} {c.detail.split()[0]}")
        n_changes = len(hc.changes) if tick + 5 >= t and n_changes < len(hc.changes) and hc.changes[-1].kind == "left" else n_changes
        if kind == 1:
            hc.door(key, payload in OPEN_STATES, t)
            if (t_from is None or t >= t_from) and key in hc._door_region:
                print(f"{fmt(t)}  door {key.split('.')[-1]} -> {payload}")
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
        counts = (hc.count(), tuple(sorted(hc.by_floor().items(), reverse=True)))
        new_changes = hc.changes[n_changes:]
        n_changes = len(hc.changes)
        if counts != last_counts or any(c.kind not in ("moved", "not a person", "ghost") for c in new_changes) or (a.trace and any(f"#{a.trace}" == f"#{c.token}" for c in new_changes)):
            if t_from is None or t >= t_from:
                floors_s = "  ".join(f"F{fl}:{n}" for fl, n in counts[1])
                why = "; ".join(f"{c.kind} #{c.token} {c.region} {c.detail}".strip() for c in new_changes)
                print(f"{fmt(t)}  home {counts[0]}  {floors_s}   {why}")
            last_counts = counts


if __name__ == "__main__":
    main()
