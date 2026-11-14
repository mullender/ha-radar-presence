"""Cut a time window out of an export from tools/export_history.mjs.

Usage:
  python3 tools/cut_fixture.py IN.json.gz OUT.json START END [--note TEXT]
  python3 tools/cut_fixture.py IN.json.gz OUT.json --busiest MINUTES [--note TEXT]

START/END are ISO-8601 timestamps (UTC, e.g. 2026-11-13T12:00:00Z).
--busiest picks the window of the given length with the most state changes.

Each entity keeps its last state before START as the first entry (timestamped
at START), so a replay starts from the correct device state.
"""

from __future__ import annotations

import argparse
import bisect
import gzip
import json
from datetime import datetime, timezone


def parse_ts(s: str) -> float:
    return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


def iso(t: float) -> str:
    return datetime.fromtimestamp(t, timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def busiest(history: dict[str, list], minutes: float) -> tuple[float, float]:
    times = sorted(t for v in history.values() for t, _ in v)
    span = minutes * 60
    best, best_i = 0, 0
    for i, t in enumerate(times):
        n = bisect.bisect_right(times, t + span) - i
        if n > best:
            best, best_i = n, i
    return times[best_i], times[best_i] + span


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("dst")
    ap.add_argument("start", nargs="?")
    ap.add_argument("end", nargs="?")
    ap.add_argument("--busiest", type=float)
    ap.add_argument("--note", default="")
    a = ap.parse_args()

    with gzip.open(a.src) as f:
        doc = json.load(f)
    history = doc["history"]
    start, end = busiest(history, a.busiest) if a.busiest else (parse_ts(a.start), parse_ts(a.end))

    out = {}
    for eid, states in history.items():
        before = [s for t, s in states if t < start]
        clipped = [[round(t, 6), s] for t, s in states if start <= t <= end]
        if before:
            clipped.insert(0, [round(start, 6), before[-1]])
        out[eid] = clipped

    meta = dict(doc["meta"], start=iso(start), end=iso(end), note=a.note)
    with open(a.dst, "w") as f:
        json.dump({"meta": meta, "history": out}, f, separators=(",", ":"))
    n = sum(len(v) for v in out.values())
    print(f"{a.dst}: {iso(start)} .. {iso(end)}, {n} state changes")


if __name__ == "__main__":
    main()
