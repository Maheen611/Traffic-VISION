"""
Adapter around a Roboflow Workflow (RF-DETR vehicle detection + ByteTrack +
SAM3 open-vocabulary "ambulance" detection) so it can be dropped in wherever
VehicleDetector (the local YOLOv11/ultralytics pipeline in detector.py) is
used today — same track_frame() signature, same TrackedObject output, so
decision_engine.py, video_processor.py's overlay drawing, and the WS
broadcast payload all need zero changes.

This is an ALTERNATIVE backend, not a replacement — detector.py keeps
running exactly as before and stays the default. Set DETECTOR_BACKEND=roboflow
in .env to use this one instead. See get_detector() in this file for the
switch.

WHY YOU MIGHT WANT THIS OVER THE LOCAL YOLO PIPELINE:
  - SAM3's `class_names=["ambulance"]` is genuine open-vocabulary detection —
    it was never trained on a fixed "ambulance" class, it's prompted with the
    word at inference time. That's a real, better answer to the exact gap
    documented at the top of detector.py (stock COCO weights have no
    ambulance class, so that file falls back to a livery-colour/aspect-ratio
    heuristic). This gives you a real classifier instead of a heuristic,
    with no fine-tuning required.
  - RF-DETR is a stronger base detector than yolo11n (nano) for the
    car/motorcycle/bus/truck classes.

REAL TRADEOFFS — please read before switching production traffic to this,
I can't verify any of this from this sandbox (no network/API key here):
  - This calls Roboflow's hosted Serverless API once per video frame over
    HTTP. For a live multi-camera CCTV pipeline processing thousands of
    frames, that's thousands of network round-trips per video — expect this
    to be substantially slower than the local in-process YOLO pipeline, and
    (per Roboflow's pricing) metered/billed per call once you're using an
    API key. Test on a short clip before pointing this at hours of footage.
  - Roboflow's docs are explicit that their Serverless Hosted API does NOT
    support their own video-streaming ingestion mode — only single-image
    calls. That's compatible with how this app already works (video_processor.py
    already pulls frames one at a time via OpenCV and calls the detector per
    frame), but it does mean each frame is an independent stateless HTTP call.
  - I could not confirm from documentation whether the `trackers_bytetrack@v1`
    block maintains track-ID continuity ACROSS separate stateless HTTP calls
    the way ByteTrack does when it's one continuous in-process tracker (as
    in detector.py, via `persist=True`). If track IDs reset or jump between
    frames when calling run_workflow() repeatedly like this, speed
    calculation and the "same vehicle across frames" logic in
    decision_engine.py will be unreliable. Verify this on your own footage
    before trusting speed/corridor numbers from this backend — if it's
    unreliable, self-hosting Roboflow's `inference` server (Docker, on your
    own GPU) and running the workflow as one continuous local process is
    the documented way to get real streaming/track continuity, at the cost
    of managing that infrastructure yourself.
  - SAM3 ambulance detections come from a separate, untracked branch of the
    workflow (no ByteTrack attached to them) — see the synthesized
    position-based ID below.
"""
import json
from pathlib import Path
from typing import List, Optional

import numpy as np

try:
    from inference_sdk import InferenceHTTPClient
except ImportError:  # pragma: no cover - allows the rest of the app to import without this optional dep
    InferenceHTTPClient = None

from ..config import settings
from .detector import TrackedObject

WORKFLOW_PATH = Path(__file__).parent / "workflows" / "traffic_ambulance_workflow.json"


class RoboflowVehicleDetector:
    def __init__(self, api_key: str = None, api_url: str = None):
        if InferenceHTTPClient is None:
            raise RuntimeError(
                "inference-sdk is not installed. Run `pip install inference-sdk` "
                "to use DETECTOR_BACKEND=roboflow."
            )
        api_key = api_key or settings.ROBOFLOW_API_KEY
        if not api_key:
            raise RuntimeError(
                "ROBOFLOW_API_KEY is not set. Get one from your Roboflow "
                "account settings (app.roboflow.com -> Settings -> API Keys) "
                "and add it to .env to use this backend."
            )
        self.client = InferenceHTTPClient(
            api_url=api_url or settings.ROBOFLOW_API_URL,
            api_key=api_key,
        )
        self.workflow_spec = json.loads(WORKFLOW_PATH.read_text())

    def track_frame(self, frame: np.ndarray, persist: bool = True) -> List[TrackedObject]:
        """
        Runs the full workflow (RF-DETR detect -> ByteTrack -> SAM3 ambulance
        detect) on a single BGR frame and normalizes both output branches
        into the same TrackedObject shape detector.py produces.
        """
        result = self.client.run_workflow(
            specification=self.workflow_spec,
            images={"image": frame},
        )
        # run_workflow returns a list (one dict per input image); we send one.
        outputs = result[0] if isinstance(result, list) else result

        objects: List[TrackedObject] = []

        for pred in outputs.get("tracked_vehicles", []) or []:
            obj = self._to_tracked_object(pred, fallback_cls="car")
            if obj:
                objects.append(obj)

        # SAM3's ambulance predictions aren't ByteTrack-tracked (separate
        # branch in the workflow), so they won't have a stable track_id
        # across frames the way vehicle detections do. Synthesize one from
        # rounded position so the same physical ambulance gets a roughly
        # consistent ID frame-to-frame instead of a random new one every
        # time — good enough for the emergency_ids set in video_processor.py,
        # not a real tracker. Don't rely on this for speed/corridor logic.
        for pred in outputs.get("ambulance_predictions", []) or []:
            obj = self._to_tracked_object(pred, fallback_cls="ambulance", force_cls="ambulance")
            if obj:
                objects.append(obj)

        return objects

    @staticmethod
    def _to_tracked_object(pred: dict, fallback_cls: str, force_cls: str = None) -> Optional[TrackedObject]:
        """
        Roboflow's standard prediction schema is center-x/y + width/height,
        NOT corner x1/y1/x2/y2 like Ultralytics — this is the most likely
        real bug spot if boxes come out offset/mis-sized, since it's easy to
        assume Ultralytics-style corners here by mistake.
        """
        try:
            cx, cy = float(pred["x"]), float(pred["y"])
            w, h = float(pred["width"]), float(pred["height"])
        except (KeyError, TypeError):
            return None
        x1, y1, x2, y2 = cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2

        track_id = pred.get("tracker_id")
        if track_id is None:
            track_id = abs(hash((round(cx / 20), round(cy / 20)))) % 100000

        return TrackedObject(
            track_id=int(track_id),
            cls=force_cls or pred.get("class", fallback_cls),
            confidence=float(pred.get("confidence", 0.0)),
            bbox=(x1, y1, x2, y2),
        )


def build_detector():
    """
    Single switch point for the whole app: video_processor.py's own
    get_detector() singleton wrapper calls this instead of constructing
    VehicleDetector directly, so DETECTOR_BACKEND in .env controls which
    pipeline actually runs without touching any other file.
    """
    if settings.DETECTOR_BACKEND == "roboflow":
        return RoboflowVehicleDetector()
    from .detector import VehicleDetector
    return VehicleDetector()
