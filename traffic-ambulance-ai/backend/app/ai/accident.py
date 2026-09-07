"""
Rule-based accident / anomaly detection over tracked-object history.

These are heuristics on top of the same TrackHistory objects used for
speed — no additional model is required, which keeps this module fast
enough to run every frame. Tune the thresholds per camera/site.
"""
from dataclasses import dataclass
from typing import Dict, List, Optional

STATIONARY_SPEED_KMH = 2.0
LONG_STATIONARY_SECONDS = 90
SUDDEN_STOP_DROP_KMH = 25.0
OVERTURN_ASPECT_FLIP = 0.6  # bbox aspect ratio below this vs. class baseline


@dataclass
class Incident:
    kind: str          # collision | sudden_stop | blockage | overturned | wrong_side | stationary
    track_ids: List[int]
    severity: str       # warning | high | critical
    description: str


class AccidentDetector:
    def __init__(self, fps: float = 25.0):
        self.fps = fps
        self._stationary_since: Dict[int, int] = {}
        self._last_speed: Dict[int, float] = {}

    def evaluate(self, frame_idx: int, tracks_speed: Dict[int, float],
                 tracks_bbox: Dict[int, tuple]) -> List[Incident]:
        incidents: List[Incident] = []

        for tid, speed in tracks_speed.items():
            prev = self._last_speed.get(tid)
            # sudden stop
            if prev is not None and prev - speed > SUDDEN_STOP_DROP_KMH:
                incidents.append(Incident(
                    kind="sudden_stop", track_ids=[tid], severity="high",
                    description=f"Vehicle #{tid} decelerated {prev - speed:.0f} km/h in one interval",
                ))
            # stationary tracking
            if speed <= STATIONARY_SPEED_KMH:
                start = self._stationary_since.setdefault(tid, frame_idx)
                stationary_secs = (frame_idx - start) / max(1e-6, self.fps)
                if stationary_secs >= LONG_STATIONARY_SECONDS:
                    incidents.append(Incident(
                        kind="stationary", track_ids=[tid], severity="warning",
                        description=f"Vehicle #{tid} stationary for {int(stationary_secs)}s — possible blockage",
                    ))
            else:
                self._stationary_since.pop(tid, None)
            self._last_speed[tid] = speed

        # collision: two boxes with high IoU + a track disappearing next frame is a
        # reasonable proxy in production; this simplified version flags overlapping
        # boxes above a tight IoU threshold as a possible collision.
        ids = list(tracks_bbox.keys())
        for i in range(len(ids)):
            for j in range(i + 1, len(ids)):
                iou = _iou(tracks_bbox[ids[i]], tracks_bbox[ids[j]])
                if iou > 0.55:
                    incidents.append(Incident(
                        kind="collision", track_ids=[ids[i], ids[j]], severity="critical",
                        description=f"Possible collision between vehicles #{ids[i]} and #{ids[j]}",
                    ))
        return incidents


def _iou(box_a: tuple, box_b: tuple) -> float:
    ax1, ay1, ax2, ay2 = box_a
    bx1, by1, bx2, by2 = box_b
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    iw, ih = max(0.0, ix2 - ix1), max(0.0, iy2 - iy1)
    inter = iw * ih
    area_a = max(0.0, ax2 - ax1) * max(0.0, ay2 - ay1)
    area_b = max(0.0, bx2 - bx1) * max(0.0, by2 - by1)
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0.0
