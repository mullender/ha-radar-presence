"""Planar geometry for zone evaluation. Pure Python, no Home Assistant imports.

All coordinates are millimetres in the sensor frame: origin at the sensor,
+Y straight out from the sensor, +X as reported by the firmware.
"""

from __future__ import annotations

import math
from collections.abc import Sequence

Point = tuple[float, float]
Polygon = Sequence[Sequence[float]]


def point_in_polygon(x: float, y: float, polygon: Polygon) -> bool:
    """Ray-casting test (even-odd rule). Points exactly on an edge are unspecified."""
    inside = False
    n = len(polygon)
    j = n - 1
    for i in range(n):
        xi, yi = polygon[i][0], polygon[i][1]
        xj, yj = polygon[j][0], polygon[j][1]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def _dist_to_segment(px: float, py: float, ax: float, ay: float, bx: float, by: float) -> float:
    dx, dy = bx - ax, by - ay
    len2 = dx * dx + dy * dy
    if len2 == 0:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / len2))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def signed_distance(x: float, y: float, polygon: Polygon) -> float:
    """Distance to the polygon boundary; positive inside, negative outside."""
    n = len(polygon)
    d = min(
        _dist_to_segment(x, y, polygon[i - 1][0], polygon[i - 1][1], polygon[i][0], polygon[i][1])
        for i in range(n)
    )
    return d if point_in_polygon(x, y, polygon) else -d


def polygon_area(polygon: Polygon) -> float:
    """Signed shoelace area (positive for counter-clockwise)."""
    n = len(polygon)
    return 0.5 * sum(
        polygon[i - 1][0] * polygon[i][1] - polygon[i][0] * polygon[i - 1][1] for i in range(n)
    )


def _segments_intersect(p1: Point, p2: Point, p3: Point, p4: Point) -> bool:
    def orient(a: Point, b: Point, c: Point) -> float:
        return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])

    d1, d2 = orient(p3, p4, p1), orient(p3, p4, p2)
    d3, d4 = orient(p1, p2, p3), orient(p1, p2, p4)
    return (d1 * d2 < 0) and (d3 * d4 < 0)


def validate_polygon(polygon: Polygon) -> str | None:
    """Return an error string, or None if the polygon is usable."""
    if len(polygon) < 3:
        return "polygon needs at least 3 vertices"
    for p in polygon:
        if len(p) != 2 or not all(isinstance(v, (int, float)) and math.isfinite(v) for v in p):
            return "vertices must be [x, y] pairs of finite numbers"
    pts = [(float(p[0]), float(p[1])) for p in polygon]
    n = len(pts)
    for i in range(n):
        a1, a2 = pts[i], pts[(i + 1) % n]
        for j in range(i + 1, n):
            if j in (i, (i + 1) % n) or (j + 1) % n == i:
                continue  # adjacent edges share a vertex
            if _segments_intersect(a1, a2, pts[j], pts[(j + 1) % n]):
                return "polygon edges cross each other"
    if abs(polygon_area(polygon)) < 1.0:
        return "polygon has no area"
    return None


def fov_polygon(max_distance_mm: float, half_angle_deg: float = 60.0, segments: int = 24) -> list[list[float]]:
    """Wedge covering the sensor's field of view (LD2450: ±60°, ~6 m)."""
    pts = [[0.0, 0.0]]
    for k in range(segments + 1):
        a = math.radians(-half_angle_deg + 2 * half_angle_deg * k / segments)
        pts.append([round(max_distance_mm * math.sin(a), 1), round(max_distance_mm * math.cos(a), 1)])
    return pts
