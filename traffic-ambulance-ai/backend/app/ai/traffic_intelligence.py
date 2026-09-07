"""
Density, speed and flow calculations from tracked-object history.

Speed is computed from centroid displacement between frames, converted
to km/h using the camera's pixels-per-metre calibration and the video's
FPS. Without calibration this still returns a value, but it should be
treated as relative (px/s scaled) rather than a certified reading.
"""
from collections import defaultdict, deque
from dataclasses import dataclass
from typing import Dict, List, Tuple

from ..config import settings


@dataclass
class TrackHistory:
    positions: deque  # of (frame_idx, x, y)
    cls: str
    max_len: int = 30

    def add(self, frame_idx: int, x: float, y: float):
        self.positions.append((frame_idx, x, y))
        if len(self.positions) > self.max_len:
            self.positions.popleft()

    def speed_kmh(self, fps: float, pixels_per_metre: float) -> float:
        if len(self.positions) < 2:
            return 0.0
        f0, x0, y0 = self.positions[0]
        f1, x1, y1 = self.positions[-1]
        frames_elapsed = max(1, f1 - f0)
        seconds = frames_elapsed / max(1e-6, fps)
        dist_px = ((x1 - x0) ** 2 + (y1 - y0) ** 2) ** 0.5
        dist_m = dist_px / max(1e-6, pixels_per_metre)
        mps = dist_m / seconds
        return round(mps * 3.6, 1)  # m/s -> km/h


class TrafficIntelligence:
    def __init__(self, fps: float = 25.0, pixels_per_metre: float = None):
        self.fps = fps
        self.pixels_per_metre = pixels_per_metre or settings.DEFAULT_PIXELS_PER_METRE
        self.tracks: Dict[int, TrackHistory] = {}

    def update(self, frame_idx: int, tracked_objects) -> dict:
        counts: Dict[str, int] = defaultdict(int)
        speeds: List[float] = []

        for obj in tracked_objects:
            counts[obj.cls] += 1
            th = self.tracks.setdefault(obj.track_id, TrackHistory(deque(), obj.cls))
            th.add(frame_idx, *obj.centroid)
            speed = th.speed_kmh(self.fps, self.pixels_per_metre)
            if speed > 0:
                speeds.append(speed)

        total = sum(counts.values())
        density_label = self._density_label(total)
        avg_speed = round(sum(speeds) / len(speeds), 1) if speeds else 0.0
        max_speed = round(max(speeds), 1) if speeds else 0.0
        min_speed = round(min(speeds), 1) if speeds else 0.0
        overspeed = [s for s in speeds if s > settings.SPEED_LIMIT_KMH]

        return {
            "counts": dict(counts),
            "total": total,
            "density": density_label,
            "avg_speed": avg_speed,
            "max_speed": max_speed,
            "min_speed": min_speed,
            "overspeed_count": len(overspeed),
        }

    @staticmethod
    def _density_label(total: int) -> str:
        t = settings.DENSITY_THRESHOLDS
        if total >= t["high"]:
            return "Critical"
        if total >= t["medium"]:
            return "High"
        if total >= t["low"]:
            return "Medium"
        return "Low"
