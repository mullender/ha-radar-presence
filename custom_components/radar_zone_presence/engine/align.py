"""Rigid transforms between radar frames and alignment groups.

A radar aligned to another stores ``aligned_to`` = {radar_id, angle_deg,
reflect, offset_mm}: the transform from its own frame into the reference
radar's frame (rotate, optionally after mirroring X, then translate). Radars
linked by alignments form a group that shares one map: the frame of the
group's anchor (the radar at the root of the alignment chain).

``frontend/util.js`` has the same maths (affineApply, alignmentAffine,
radarTransforms). Pure Python, no Home Assistant imports.
"""

from __future__ import annotations

import math
from collections import deque
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

Affine = tuple[tuple[float, float, float], tuple[float, float, float]]
IDENTITY: Affine = ((1.0, 0.0, 0.0), (0.0, 1.0, 0.0))


def apply(a: Affine, x: float, y: float) -> tuple[float, float]:
    return (a[0][0] * x + a[0][1] * y + a[0][2], a[1][0] * x + a[1][1] * y + a[1][2])


def mul(a: Affine, b: Affine) -> Affine:
    """``a`` after ``b``."""
    return (
        (
            a[0][0] * b[0][0] + a[0][1] * b[1][0],
            a[0][0] * b[0][1] + a[0][1] * b[1][1],
            a[0][0] * b[0][2] + a[0][1] * b[1][2] + a[0][2],
        ),
        (
            a[1][0] * b[0][0] + a[1][1] * b[1][0],
            a[1][0] * b[0][1] + a[1][1] * b[1][1],
            a[1][0] * b[0][2] + a[1][1] * b[1][2] + a[1][2],
        ),
    )


def invert(a: Affine) -> Affine:
    det = a[0][0] * a[1][1] - a[0][1] * a[1][0]
    p, q, r, s = a[1][1] / det, -a[0][1] / det, -a[1][0] / det, a[0][0] / det
    return ((p, q, -(p * a[0][2] + q * a[1][2])), (r, s, -(r * a[0][2] + s * a[1][2])))


def is_identity(a: Affine) -> bool:
    return all(abs(a[i][j] - IDENTITY[i][j]) < 1e-9 for i in range(2) for j in range(3))


def alignment_affine(al: Mapping[str, Any]) -> Affine:
    """A saved alignment as the transform from the aligned radar's frame to its reference's."""
    r = math.radians(float(al.get("angle_deg", 0)))
    c, s = math.cos(r), math.sin(r)
    f = -1.0 if al.get("reflect") else 1.0
    off = al.get("offset_mm") or (0, 0)
    return ((c * f, -s, float(off[0])), (s * f, c, float(off[1])))


def transform_polygon(a: Affine, polygon: Sequence[Sequence[float]]) -> tuple[tuple[float, float], ...]:
    return tuple(apply(a, p[0], p[1]) for p in polygon)


def _valid(al: Any) -> bool:
    return isinstance(al, Mapping) and bool(al.get("radar_id")) and al.get("offset_mm") is not None


@dataclass(frozen=True, slots=True)
class AlignmentGroup:
    anchor: str
    to_anchor: Mapping[str, Affine]  # radar id -> transform from its frame into the anchor's

    @property
    def members(self) -> list[str]:
        return list(self.to_anchor)


def alignment_groups(aligned_to: Mapping[str, Mapping[str, Any] | None]) -> list[AlignmentGroup]:
    """Split radars into groups connected by alignments.

    ``aligned_to``: radar id -> its saved alignment (or None), in a stable
    order. The anchor of a group is the radar that is not aligned to another
    member (the root of the chain); for a cycle, the first in order.
    """
    ids = list(aligned_to)
    edges: dict[str, list[tuple[str, Affine]]] = {i: [] for i in ids}
    parent: dict[str, str] = {}
    for rid in ids:
        al = aligned_to[rid]
        if not _valid(al) or al["radar_id"] not in edges or al["radar_id"] == rid:
            continue
        a = alignment_affine(al)  # rid -> ref
        edges[rid].append((al["radar_id"], a))
        edges[al["radar_id"]].append((rid, invert(a)))
        parent[rid] = al["radar_id"]

    seen: set[str] = set()
    groups = []
    for rid in ids:
        if rid in seen:
            continue
        # Collect the component, then pick its root.
        comp, queue = [], deque([rid])
        seen.add(rid)
        while queue:
            cur = queue.popleft()
            comp.append(cur)
            for nxt, _ in edges[cur]:
                if nxt not in seen:
                    seen.add(nxt)
                    queue.append(nxt)
        order = {i: n for n, i in enumerate(ids)}
        comp.sort(key=order.__getitem__)
        anchor = next((i for i in comp if i not in parent), comp[0])
        groups.append(AlignmentGroup(anchor, radar_transforms(anchor, edges)))
    return groups


def radar_transforms(anchor: str, edges: Mapping[str, list[tuple[str, Affine]]]) -> dict[str, Affine]:
    """BFS from ``anchor``: radar id -> transform from its frame into the anchor's (anchor included)."""
    out: dict[str, Affine] = {anchor: IDENTITY}
    queue = deque([anchor])
    while queue:
        cur = queue.popleft()
        for nxt, a in edges.get(cur, []):  # a maps cur -> nxt
            if nxt in out:
                continue
            out[nxt] = mul(out[cur], invert(a))
            queue.append(nxt)
    return out
