"""tools/load_report.py: what a replay starts from."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

from load_report import start_counts, write_inputs  # noqa: E402


def test_a_replay_starts_with_who_was_believed_where(tmp_path) -> None:
    doc = {
        "activity_before": {"t": 946684000, "tokens": [[1, "room_a", "v"], [2, "room_a_x1", ""], [3, "room_b", "u"]]},
        "spaces": [{"id": "room_a", "area_id": "room_a"}, {"id": "room_a_x1", "area_id": "room_a"}, {"id": "room_b", "area_id": "room_b"}],
        "radars": [], "doors": {}, "floors": {}, "outside_doors": {},
    }
    assert start_counts(doc) == {"room_a": 2, "room_b": 1}
    args = write_inputs(doc, tmp_path)
    assert args[args.index("--seed") + 1] == '{"room_a": 2, "room_b": 1}'
    assert start_counts({"activity_before": None}) == {}
