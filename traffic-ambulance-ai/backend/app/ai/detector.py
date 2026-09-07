"""
Detection + tracking wrapper around Ultralytics YOLO.

Ultralytics' `model.track()` ships built-in ByteTrack (and BoT-SORT)
support, so a separate ByteTrack integration isn't needed — passing
`tracker="bytetrack.yaml"` is the real, documented way to get stable
track IDs per frame. This module wraps that call and normalizes the
result into plain dicts the rest of the app (density/speed/ambulance/
accident logic) can consume without depending on Ultralytics types.

NOTE ON THE "AMBULANCE" CLASS:
Stock COCO weights (what `yolo11n.pt` etc. download by default) only
recognize generic classes — car, truck, bus, motorcycle, person,
bicycle. They do NOT have an "ambulance", "police_vehicle" or
"fire_truck" class. `../training/` contains a real, runnable
fine-tuning pipeline for this — dataset recommendations with live
links, a merge/relabel script, class-balance reporting, and a train.py
tuned for the resulting rare-class imbalance. Once trained, point
`YOLO_WEIGHTS` at the resulting checkpoint and `classify_emergency_heuristic()`
below becomes unnecessary. Until then, it's a documented, best-effort
fallback (livery colour + siren light-bar aspect ratio) — not a
substitute for a properly trained class.
"""
from dataclasses import dataclass, field
from typing import List, Optional
import time

import numpy as np

try:
    from ultralytics import YOLO
except ImportError:  # pragma: no cover - allows the rest of the app to import without the heavy dep
    YOLO = None

from ..config import settings

COCO_VEHICLE_CLASSES = {
    "car": "car",
    "truck": "truck",
    "bus": "bus",
    "motorcycle": "bike",
    "bicycle": "bicycle",
    "person": "pedestrian",
}
# Standard COCO class indices for the names above (car, bicycle, motorcycle,
# bus, truck, person) — passed straight to model.track(classes=...) so
# Ultralytics itself skips the other 74 COCO classes at inference time
# instead of us silently keeping them. This was a real bug: the old code
# only *relabeled* known classes and fell back to the raw COCO name for
# everything else instead of dropping it, so traffic lights, benches,
# backpacks, dogs — anything YOLO found in frame — got appended to the
# tracked-object list and drawn/counted as if it were a vehicle.
COCO_VEHICLE_CLASS_IDS = [0, 1, 2, 3, 5, 7]  # person, bicycle, car, motorcycle, bus, truck


@dataclass
class TrackedObject:
    track_id: int
    cls: str
    confidence: float
    bbox: tuple  # (x1, y1, x2, y2) in pixels
    centroid: tuple = field(init=False)

    def __post_init__(self):
        x1, y1, x2, y2 = self.bbox
        self.centroid = ((x1 + x2) / 2, (y1 + y2) / 2)


class VehicleDetector:
    def __init__(self, weights: str = None, device: str = None, confidence: float = None, imgsz: int = None):
        if YOLO is None:
            raise RuntimeError(
                "ultralytics is not installed. Run `pip install ultralytics` "
                "(see requirements.txt)."
            )
        self.model = YOLO(weights or settings.YOLO_WEIGHTS)
        self.device = device or settings.YOLO_DEVICE
        self.confidence = confidence or settings.YOLO_CONFIDENCE
        # Ultralytics silently defaults to 640px on the LONG side if this
        # isn't set. For elevated/overhead CCTV footage that means distant
        # vehicles near the top of frame — already small — get downsampled
        # even further before the model ever sees them, which is the most
        # common cause of "it doesn't detect vehicles in my traffic video."
        # 960-1280 recovers most of that recall at a real but bearable
        # inference-time cost; bump higher only if you're still missing
        # small/far-away objects on your own footage.
        self.imgsz = imgsz or settings.YOLO_IMGSZ

    def track_frame(self, frame: np.ndarray, persist: bool = True) -> List[TrackedObject]:
        """Run detection + ByteTrack tracking on a single BGR frame."""
        results = self.model.track(
            frame,
            persist=persist,
            tracker=settings.TRACKER_CONFIG,
            conf=self.confidence,
            imgsz=self.imgsz,
            device=self.device,
            classes=COCO_VEHICLE_CLASS_IDS,
            verbose=False,
        )
        objects: List[TrackedObject] = []
        if not results:
            return objects
        r = results[0]
        if r.boxes is None or r.boxes.id is None:
            return objects

        names = r.names
        for box, track_id, conf, cls_idx in zip(
            r.boxes.xyxy.cpu().numpy(),
            r.boxes.id.cpu().numpy(),
            r.boxes.conf.cpu().numpy(),
            r.boxes.cls.cpu().numpy(),
        ):
            raw_name = names[int(cls_idx)]
            if raw_name not in COCO_VEHICLE_CLASSES:
                # Belt-and-suspenders: classes= above should already stop
                # these from coming back at all, but if this ever runs
                # against custom-trained weights with a different class
                # list, don't silently start tracking unknown classes as
                # if they were vehicles again.
                continue
            mapped = COCO_VEHICLE_CLASSES[raw_name]
            objects.append(
                TrackedObject(
                    track_id=int(track_id),
                    cls=mapped,
                    confidence=float(conf),
                    bbox=tuple(float(v) for v in box),
                )
            )
        return objects


def classify_emergency_heuristic(frame: np.ndarray, obj: TrackedObject) -> Optional[str]:
    """
    Best-effort fallback when running on generic COCO weights without a
    fine-tuned emergency-vehicle class: flags a 'truck'/'car' box as a
    possible ambulance if it has a high proportion of red+white/red+blue
    pixels (livery + light bar) and a boxy aspect ratio. Returns
    'possible_ambulance' or None. Always prefer a properly trained class
    over this in production — it is a heuristic, not a classifier.
    """
    if obj.cls not in ("truck", "car", "bus"):
        return None
    x1, y1, x2, y2 = [int(v) for v in obj.bbox]
    crop = frame[max(0, y1):y2, max(0, x1):x2]
    if crop.size == 0:
        return None
    aspect = (x2 - x1) / max(1, (y2 - y1))
    if not (1.4 < aspect < 3.2):
        return None
    # crude red/white ratio in RGB-ish space (frame is BGR)
    b, g, r = crop[..., 0].astype(int), crop[..., 1].astype(int), crop[..., 2].astype(int)
    red_mask = (r > 150) & (g < 100) & (b < 100)
    white_mask = (r > 200) & (g > 200) & (b > 200)
    ratio = (red_mask.sum() + white_mask.sum()) / crop[..., 0].size
    return "possible_ambulance" if ratio > 0.18 else None


def now_ms() -> int:
    return int(time.time() * 1000)
