"""Dev only: turn per-radar config entries (v1) into one home entry with subentries (v2).

Run with Home Assistant stopped:  python3 tools/dev_merge_entries.py ha_config

Radar subentries reuse the old entry ids, so saved alignments (aligned_to)
keep pointing at the right radar. Include zones become zone subentries;
exclusions and exits stay on their radar. Our old entities and zone devices
are dropped from the registries and recreated on the next start.
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

DOMAIN = "radar_zone_presence"


def main(cfg: Path) -> None:
    store = cfg / ".storage"
    entries_path = store / "core.config_entries"
    doc = json.loads(entries_path.read_text())
    entries = doc["data"]["entries"]
    old = [e for e in entries if e["domain"] == DOMAIN]
    if not old or all(e["version"] >= 2 for e in old):
        print("nothing to convert")
        return
    subentries = []
    grace = 0
    for e in old:
        opts = e["options"]
        grace = max(grace, opts.get("reconnect_grace_s", 0) or 0)
        display = dict(opts.get("display") or {})
        if al := display.get("aligned_to"):
            al["radar_id"] = al.pop("entry_id", al.get("radar_id"))
        zones = opts.get("zones", [])
        subentries.append(
            {
                "subentry_id": e["entry_id"],
                "subentry_type": "radar",
                "title": e["title"],
                "unique_id": e["data"]["device_id"],
                "data": {**e["data"], "zones": [z for z in zones if z.get("kind", "include") != "include"], "display": display},
            }
        )
        for z in zones:
            if z.get("kind", "include") != "include":
                continue
            data = {k: v for k, v in z.items() if k not in ("kind", "door", "door_entity_id")} | {"radar": e["entry_id"]}
            subentries.append(
                {"subentry_id": f"s{z['id']}", "subentry_type": "zone", "title": z["name"], "unique_id": z["id"], "data": data}
            )
    now = time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime())
    home = {
        **old[0],
        "entry_id": "home" + old[0]["entry_id"][4:],
        "title": "Home",
        "version": 2,
        "minor_version": 1,
        "unique_id": None,
        "data": {},
        "options": {"reconnect_grace_s": grace},
        "subentries": subentries,
        "created_at": now,
        "modified_at": now,
    }
    doc["data"]["entries"] = [e for e in entries if e["domain"] != DOMAIN] + [home]
    entries_path.write_text(json.dumps(doc, indent=2))

    old_ids = {e["entry_id"] for e in old}
    ents = json.loads((store / "core.entity_registry").read_text())
    ents["data"]["entities"] = [x for x in ents["data"]["entities"] if x["platform"] != DOMAIN]
    ents["data"]["deleted_entities"] = [x for x in ents["data"].get("deleted_entities", []) if x["platform"] != DOMAIN]
    (store / "core.entity_registry").write_text(json.dumps(ents, indent=2))

    devs = json.loads((store / "core.device_registry").read_text())
    ours = lambda d: any(i[0] == DOMAIN for i in d.get("identifiers", []))  # noqa: E731
    devs["data"]["devices"] = [d for d in devs["data"]["devices"] if not ours(d)]
    devs["data"]["deleted_devices"] = [d for d in devs["data"].get("deleted_devices", []) if not ours(d)]
    devs["data"]["devices"] = [d for d in devs["data"]["devices"] if d.get("config_entry_id") not in old_ids]
    (store / "core.device_registry").write_text(json.dumps(devs, indent=2))
    print(f"merged {len(old)} radar entries into one home entry with {len(subentries)} subentries")


if __name__ == "__main__":
    main(Path(sys.argv[1] if len(sys.argv) > 1 else "ha_config"))
