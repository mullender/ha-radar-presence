"""Load a problem report (.rpreport.json.gz from the panel's "Report a problem").

  .venv/bin/python tools/load_report.py R                    # what is in it: symptom, window, radars, Activity
  .venv/bin/python tools/load_report.py R --replay           # run the engines over the window (tools/headcount.py)
  .venv/bin/python tools/load_report.py R --fixture NAME     # tests/fixtures/reports/NAME.rpreport.json.gz + a test stub

Times in a report are moved to 2000-01-01 (UTC); names and entity ids are
aliases (Room A, Radar 1, binary_sensor.door_1).
"""

from __future__ import annotations

import argparse
import datetime as dt
import gzip
import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: Path) -> dict:
    raw = path.read_bytes()
    doc = json.loads(gzip.decompress(raw) if raw[:2] == b"\x1f\x8b" else raw)
    if not str(doc.get("format", "")).startswith("radar-presence-report/"):
        sys.exit(f"{path}: not a Radar Presence problem report")
    return doc


def fmt(t: float) -> str:
    return dt.datetime.fromtimestamp(t, dt.UTC).strftime("%H:%M:%S")


def summary(doc: dict) -> None:
    m = doc["meta"]
    w = m["window"]
    print(f"Symptom:   {m['symptom']}")
    if m.get("expected"):
        print(f"Expected:  {m['expected']}")
    print(f"Window:    {fmt(w['start'])} – {fmt(w['end'])} ({w['seconds']} s){'' if m.get('time_of_day_kept') else ', time of day removed'}")
    print(f"Versions:  integration {m['versions']['integration']}, Home Assistant {m['versions']['home_assistant']}")
    for r in doc["radars"]:
        c = r["config"]
        n = sum(len(v) for v in r["export"]["history"].values())
        zones = ", ".join(f"{z['name']}" for z in c["zones"])
        print(f"  {c['title']} ({c.get('device_area_id')}): {n} readings · {zones or 'no shapes'}")
    print(f"Doors:     {', '.join(f'{d} ({len(rows)})' for d, rows in doc['doors'].items()) or 'none'}")
    seed = start_counts(doc)
    print(f"At start:  {', '.join(f'{a} {n}' for a, n in seed.items()) or 'nobody (or not known)'}")
    print("Activity:")
    for e in doc["activity"]:
        who = f" #{e['token']}" if e.get("token") else ""
        extra = f" · {e['answer']}" if e.get("answer") else ""
        print(f"  {fmt(e['t'])} {e['kind']}{who} {e.get('region') or e.get('entity') or ''} {e.get('detail') or ''}{extra}".rstrip())


def write_inputs(doc: dict, out: Path) -> list[str]:
    """The report as tools/headcount.py inputs (export files, radar configs, doors); returns its arguments."""
    data, cfgs = out / "data", out / "configs"
    data.mkdir(parents=True, exist_ok=True)
    cfgs.mkdir(exist_ok=True)
    for r in doc["radars"]:
        meta = r["export"]["meta"]
        meta.setdefault("units", {e: r["config"].get("target_unit") for e in meta["entities"]})
        (data / f"{r['export']['meta']['slug']}.json.gz").write_bytes(gzip.compress(json.dumps(r["export"]).encode()))
        (cfgs / f"{r['config']['radar_id']}.json").write_text(json.dumps(r["config"]))
    (out / "doors.json").write_text(json.dumps({**doc["doors"], **doc.get("vacuums", {})}))
    args = [
        "--data", str(data), "--configs", str(cfgs), "--doors", str(out / "doors.json"),
        "--floors", json.dumps(doc["floors"]), "--exits", "{}", "--from-leads-to",
        "--outside-doors", json.dumps(doc.get("outside_doors", {})), "--tz", "0", "--bootstrap-h", "0.01",
    ]
    if seed := start_counts(doc):
        args += ["--seed", json.dumps(seed)]
    if doc.get("occupancy"):
        (out / "occupancy.json").write_text(json.dumps(doc["occupancy"]))
        args += ["--occupancy", str(out / "occupancy.json"), "--occupancy-areas", json.dumps(doc.get("occupancy_areas", {}))]
    return args


def start_counts(doc: dict) -> dict[str, int]:
    """Who was believed where just before the window (the last Activity entry before it): area -> people."""
    before = doc.get("activity_before") or {}
    area_of = {sp["id"]: sp["area_id"] for sp in doc.get("spaces", [])}
    out: dict[str, int] = {}
    for _id, region, *_flags in before.get("tokens") or []:
        area = area_of.get(region, region)
        out[area] = out.get(area, 0) + 1
    return out


def replay(doc: dict, extra: list[str]) -> int:
    with tempfile.TemporaryDirectory() as tmp:
        args = write_inputs(doc, Path(tmp))
        return subprocess.call([sys.executable, str(ROOT / "tools" / "headcount.py"), *args, *extra], cwd=ROOT)


STUB = '''"""Problem report {name}: {symptom}. Expected: {expected}"""

from pathlib import Path

import pytest

REPORT = Path(__file__).parent / "fixtures" / "reports" / "{name}.rpreport.json.gz"


@pytest.mark.skip(reason="fill in the corrected outcome, then remove this mark")
def test_report_{ident}() -> None:
    import sys

    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
    from load_report import read

    doc = read(REPORT)
    assert doc["meta"]["symptom"] == "{symptom}"
    # Replay (tools/load_report.py REPORT --replay) and assert what should have happened, e.g. the home count at the end.
'''


def fixture(doc: dict, path: Path, name: str) -> None:
    dest = ROOT / "tests" / "fixtures" / "reports" / f"{name}.rpreport.json.gz"
    dest.parent.mkdir(parents=True, exist_ok=True)
    raw = path.read_bytes()
    dest.write_bytes(raw if raw[:2] == b"\x1f\x8b" else gzip.compress(raw))
    ident = "".join(c if c.isalnum() else "_" for c in name)
    test = ROOT / "tests" / f"test_report_{ident}.py"
    if not test.exists():
        m = doc["meta"]
        test.write_text(STUB.format(name=name, ident=ident, symptom=m["symptom"], expected=(m.get("expected") or "(not given)").replace('"', "'")))
    print(f"wrote {dest.relative_to(ROOT)} and {test.relative_to(ROOT)}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("report", type=Path)
    ap.add_argument("--replay", action="store_true", help="run the engines over the window and print what they decide")
    ap.add_argument("--fixture", metavar="NAME", help="copy into tests/fixtures/reports and write a test stub")
    a, extra = ap.parse_known_args()  # anything else goes to tools/headcount.py (e.g. --set LAG_S=60)
    doc = read(a.report)
    if a.fixture:
        fixture(doc, a.report, a.fixture)
    if a.replay:
        sys.exit(replay(doc, extra))
    if not a.fixture:
        summary(doc)


if __name__ == "__main__":
    main()
