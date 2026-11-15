"""Home-Assistant-free core: geometry, frame assembly, zone evaluation."""

from .frames import COALESCE_S, Frame, FrameAssembler, Target, TargetEntities, assemble, to_mm
from .geometry import fov_polygon, point_in_polygon, signed_distance, validate_polygon
from .zones import KIND_EXCLUDE, KIND_EXIT, KIND_INCLUDE, KIND_LINGER, KIND_TRANSIENT, EngineSnapshot, Zone, ZoneEngine, ZoneFilters, replay

__all__ = [
    "COALESCE_S",
    "KIND_EXCLUDE",
    "KIND_EXIT",
    "KIND_INCLUDE",
    "KIND_LINGER",
    "KIND_TRANSIENT",
    "EngineSnapshot",
    "Frame",
    "FrameAssembler",
    "Target",
    "TargetEntities",
    "Zone",
    "ZoneEngine",
    "ZoneFilters",
    "assemble",
    "fov_polygon",
    "point_in_polygon",
    "replay",
    "signed_distance",
    "to_mm",
    "validate_polygon",
]
