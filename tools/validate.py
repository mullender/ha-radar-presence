"""Score single-radar detection against what overlapping radars saw.

Most homes have one radar per room, so detection has to work on one radar's
data. Where radars overlap (aligned in the panel), the other radars are an
independent witness: this tool runs one radar *alone* through the home's
pipeline (exclusions, tracker, zone engine) and compares a zone's state with
"truth" from the other radars of its group: one of them currently reports a
target inside the part of the zone it covers (inside its field of view, away
from the edges).

Truth is incomplete (radars miss still people), so the useful numbers are:
  missed     zone off while a witness sees someone in the zone (bad)
  supported  zone on and a witness sees someone (good)
  unwitnessed zone on, no witness sees anyone (a held still person, or a phantom)
  flicker    zone off for < 5 min, then on again
plus turn-ons and occupied hours.

Inputs: exported histories (tools/export_history.mjs) and the radars' panel
config as returned by the `radar_zone_presence/config` websocket command, one
JSON file per radar (e.g. from tools/dev_ws.mjs).

  .venv/bin/python tools/validate.py --data dev/data --configs /tmp/devcfg \
      --radar 252dd0 --zone "Polygon 2" [--set hold_max_s=3600 off_delay_s=120] [--auto]

--auto scores an automatic zone instead: the part of the radar's view that a
witness covers (hull of covered cells), with hold until exit.
"""

from __future__ import annotations

import argparse
import bisect
import gzip
import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tests"))

import fixtures_util as fu  # noqa: E402

from custom_components.radar_zone_presence.engine import Zone, assemble  # noqa: E402
from custom_components.radar_zone_presence.engine.align import alignment_groups, apply, invert, mul  # noqa: E402
from custom_components.radar_zone_presence.engine.geometry import point_in_polygon  # noqa: E402
from custom_components.radar_zone_presence.engine.tracker import replay_group, side_margin  # noqa: E402

LD2450_RANGE_MM = 8000.0
COVER_MARGIN_MM = 500.0
FLICKER_S = 300.0


def load_configs(path: Path) -> dict[str, dict]:
    out = {}
    for f in sorted(path.glob("*.json")):
        x = json.loads(f.read_text())
        x = x[0] if isinstance(x, list) else x
        x = x.get("result", x)
        out[x["radar_id"]] = x
    return out


def load_frames(data: Path, cfg: dict):
    slug = cfg["targets"][0]["x"].split(".")[1].rsplit("_target", 1)[0]
    doc = json.loads(gzip.open(data / f"{slug}.json.gz").read())
    return list(assemble(fu.assembler(doc), fu.events(doc)))


def covers(to_peer, max_distance: float, x: float, y: float) -> bool:
    rx, ry = apply(to_peer, x, y)
    return side_margin(rx, ry) >= COVER_MARGIN_MM and math.hypot(rx, ry) <= max_distance - COVER_MARGIN_MM


def intervals(transitions: list[tuple[float, bool]], end: float) -> list[tuple[float, float]]:
    out, on = [], None
    for t, v in transitions:
        if v and on is None:
            on = t
        elif not v and on is not None:
            out.append((on, t))
            on = None
    if on is not None:
        out.append((on, end))
    return out


def overlap(a: list[tuple[float, float]], b: list[tuple[float, float]]) -> float:
    i = j = 0
    total = 0.0
    while i < len(a) and j < len(b):
        lo, hi = max(a[i][0], b[j][0]), min(a[i][1], b[j][1])
        total += max(0.0, hi - lo)
        if a[i][1] < b[j][1]:
            i += 1
        else:
            j += 1
    return total


def length(a: list[tuple[float, float]]) -> float:
    return sum(hi - lo for lo, hi in a)


def clip(a: list[tuple[float, float]], t0: float, t1: float) -> list[tuple[float, float]]:
    return [(max(lo, t0), min(hi, t1)) for lo, hi in a if hi > t0 and lo < t1]


def auto_zone(cfg: dict, witnesses: list[tuple], cell: float = 250.0) -> list[list[float]]:
    """Hull of the cells of the radar's view that a witness covers."""
    pts = []
    r = LD2450_RANGE_MM
    for ix in range(int(-r // cell), int(r // cell) + 1):
        for iy in range(0, int(r // cell) + 1):
            x, y = (ix + 0.5) * cell, (iy + 0.5) * cell
            if side_margin(x, y) < COVER_MARGIN_MM or math.hypot(x, y) > cfg["fov"]["max_distance_mm"] - COVER_MARGIN_MM:
                continue
            if any(covers(t, d, x, y) for _, t, d, _ in witnesses):
                pts.append((x, y))
    # Monotone chain hull.
    pts = sorted(set(pts))
    if len(pts) < 3:
        raise SystemExit("no part of this radar's view is covered by another radar")

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower, upper = [], []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    return [list(p) for p in lower[:-1] + upper[:-1]]


def truth_intervals(zone_poly, witnesses, end: float) -> list[tuple[float, float]]:
    """Times at which some witness's latest frame has a target inside the zone, where it covers it."""
    changes: list[tuple[float, int, bool]] = []
    for k, (frames, to_peer, max_d, to_test) in enumerate(witnesses):
        prev = False
        for f in frames:
            seen = False
            for tg in f.targets:
                x, y = apply(to_test, tg.x, tg.y)  # witness frame -> tested radar's frame
                if point_in_polygon(x, y, zone_poly) and covers(to_peer, max_d, x, y):
                    seen = True
                    break
            if seen != prev:
                changes.append((f.t, k, seen))
                prev = seen
    changes.sort()
    active: set[int] = set()
    trans = []
    for t, k, seen in changes:
        was = bool(active)
        (active.add if seen else active.discard)(k)
        if bool(active) != was:
            trans.append((t, bool(active)))
    return intervals(trans, end)


def score(zone_iv, truth_iv, t0: float, t1: float) -> dict:
    zone_iv, truth_iv = clip(zone_iv, t0, t1), clip(truth_iv, t0, t1)
    flicker = sum(1 for a, b in zip(zone_iv, zone_iv[1:]) if b[0] - a[1] < FLICKER_S)
    both = overlap(zone_iv, truth_iv)
    return {
        "turn_ons": len(zone_iv),
        "flicker": flicker,
        "occupied_h": length(zone_iv) / 3600,
        "truth_h": length(truth_iv) / 3600,
        "missed_h": (length(truth_iv) - both) / 3600,
        "supported_h": both / 3600,
        "unwitnessed_h": (length(zone_iv) - both) / 3600,
        "missed_episodes": sum(1 for lo, hi in truth_iv if overlap([(lo, hi)], zone_iv) < 0.5 * (hi - lo) and hi - lo > 10),
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", type=Path, required=True)
    ap.add_argument("--configs", type=Path, required=True)
    ap.add_argument("--radar", required=True, help="suffix of the tested radar's title, e.g. 252dd0")
    ap.add_argument("--zone", help="include zone of the tested radar to score")
    ap.add_argument("--auto", action="store_true", help="score the part of the view another radar covers")
    ap.add_argument("--set", nargs="*", default=[], help="zone filter overrides, e.g. hold_max_s=3600")
    a = ap.parse_args()

    cfgs = load_configs(a.configs)
    tested = next(c for c in cfgs.values() if c["title"].endswith(a.radar))
    groups = alignment_groups({rid: (c["settings"].get("display") or {}).get("aligned_to") for rid, c in cfgs.items()})
    group = next(g for g in groups if tested["radar_id"] in g.members)
    if len(group.members) < 2:
        raise SystemExit("the radar is not aligned with any other radar: nothing to compare with")
    to_test = invert(group.to_anchor[tested["radar_id"]])  # anchor -> tested
    witnesses = []
    for rid in group.members:
        if rid == tested["radar_id"]:
            continue
        c = cfgs[rid]
        w_to_test = mul(to_test, group.to_anchor[rid])  # witness -> tested
        to_peer = invert(w_to_test)  # tested -> witness
        witnesses.append((load_frames(a.data, c), to_peer, c["fov"]["max_distance_mm"], w_to_test))
    frames = load_frames(a.data, tested)
    t0 = max(frames[0].t, *(w[0][0].t for w in witnesses))
    t1 = min(frames[-1].t, *(w[0][-1].t for w in witnesses))

    zones = [Zone.from_dict(z) for z in tested["zones"] if z["kind"] != "include"]
    if a.auto:
        poly = auto_zone(tested, witnesses)
        zd = {"id": "auto", "name": "Covered part", "kind": "include", "polygon": poly,
              "filters": {"hold_until_exit": True, "hold_max_s": 3600, "edge_margin_mm": 150}}
    else:
        zd = dict(next(z for z in tested["zones"] if z["name"] == a.zone))
    filters = dict(zd.get("filters") or {})
    for kv in a.set:
        k, v = kv.split("=")
        filters[k] = v.lower() == "true" if v.lower() in ("true", "false") else float(v)
    zd["filters"] = filters
    zone = Zone.from_dict(zd)

    out = replay_group(frames, [zone, *zones])
    zone_iv = intervals([(t, v) for t, k, v in out if k == zone.id], t1)
    truth_iv = truth_intervals(zone.polygon, witnesses, t1)
    s = score(zone_iv, truth_iv, t0, t1)
    print(f"{tested['title']} alone, zone {zone.name!r} {filters}, {(t1 - t0) / 3600:.1f} h with witnesses")
    print("  " + "  ".join(f"{k} {v:.2f}" if isinstance(v, float) else f"{k} {v}" for k, v in s.items()))


if __name__ == "__main__":
    main()
