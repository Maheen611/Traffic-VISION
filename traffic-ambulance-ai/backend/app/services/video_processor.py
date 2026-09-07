"""
End-to-end pipeline for one uploaded video:

  read frame -> YOLOv11 detect + ByteTrack track -> decision engine
  -> draw overlay -> write to output MP4 -> broadcast stats over WS
  -> persist aggregated detections/events to PostgreSQL on completion

Runs as a FastAPI BackgroundTask so the upload endpoint returns
immediately and the frontend polls / listens on the WebSocket for
progress, matching the Queued -> ... -> Completed pipeline the UI
expects.
"""
import asyncio
import base64
import cv2

from sqlalchemy.orm import Session

from ..ai.detector import VehicleDetector, classify_emergency_heuristic
from ..ai.roboflow_detector import build_detector
from ..ai.decision_engine import DecisionEngine
from ..config import settings
from ..models import Video, VideoStatus, Detection, TrafficEvent
from ..websocket_manager import manager

STAGE_PROGRESS = {
    VideoStatus.uploading: 10,
    VideoStatus.processing: 25,
    VideoStatus.detecting: 45,
    VideoStatus.tracking: 65,
    VideoStatus.analyzing: 85,
    VideoStatus.completed: 100,
}

_detector_singleton = None


def get_detector():
    # See ai/roboflow_detector.py's build_detector() and DETECTOR_BACKEND in
    # config.py for the local-YOLO-vs-Roboflow-Workflow switch this delegates
    # to. Cached as a singleton either way — constructing a YOLO or Roboflow
    # client per video would be wasteful.
    global _detector_singleton
    if _detector_singleton is None:
        _detector_singleton = build_detector()
    return _detector_singleton


async def process_video(video_id: str, db_factory):
    """Entry point scheduled by BackgroundTasks. The real work is CPU-bound
    (YOLO inference + OpenCV encode per frame) and MUST NOT run directly on
    the asyncio event loop — `await asyncio.sleep(0)` does not yield CPU time,
    it only yields control between awaits, so the loop still blocks solid for
    the whole video and every other request (uploads, WS, status polling)
    freezes until processing finishes. Running the sync pipeline in a worker
    thread via asyncio.to_thread keeps the event loop responsive."""
    loop = asyncio.get_running_loop()
    await asyncio.to_thread(_process_video_sync, video_id, db_factory, loop)


def _broadcast_threadsafe(loop: asyncio.AbstractEventLoop, payload: dict):
    """manager.broadcast() is a coroutine that must run on the event loop,
    but this function is called from a worker thread — schedule it there
    instead of awaiting it directly."""
    asyncio.run_coroutine_threadsafe(manager.broadcast(payload), loop)


def _process_video_sync(video_id: str, db_factory, loop: asyncio.AbstractEventLoop):
    """db_factory is a zero-arg callable returning a new Session (see database.SessionLocal).
    Runs entirely inside a worker thread (see process_video above)."""
    db: Session = db_factory()
    video = db.query(Video).filter(Video.id == video_id).first()
    if not video:
        db.close()
        return

    try:
        detector = get_detector()
        cap = cv2.VideoCapture(video.stored_path)
        if not cap.isOpened():
            raise RuntimeError(f"OpenCV could not open {video.stored_path} — unsupported codec or corrupt upload.")
        fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        video.width, video.height, video.fps = width, height, fps
        video.status = VideoStatus.processing
        db.commit()

        out_path = str(settings.OUTPUT_DIR / f"{video.id}_annotated.mp4")
        fourcc = cv2.VideoWriter_fourcc(*"mp4v")
        writer = cv2.VideoWriter(out_path, fourcc, fps, (width, height))

        engine = DecisionEngine(fps=fps)
        frame_idx = 0
        pending_events = []  # events since the last WS broadcast — see below
        video.status = VideoStatus.detecting
        db.commit()

        while True:
            ok, frame = cap.read()
            if not ok:
                break
            frame_idx += 1

            tracked = detector.track_frame(frame)
            emergency_ids = set()
            for obj in tracked:
                if obj.cls == "ambulance":
                    emergency_ids.add(obj.track_id)
                else:
                    heuristic = classify_emergency_heuristic(frame, obj)
                    if heuristic:
                        emergency_ids.add(obj.track_id)

            result = engine.process_frame(frame_idx, tracked, emergency_ids)
            pending_events.extend(result["events"])
            _draw_overlay(frame, tracked, emergency_ids, result)
            writer.write(frame)

            if frame_idx % 5 == 0:  # throttle stats broadcast to ~5x/sec at 25fps
                payload = {
                    "video_id": video.id,
                    "frame_number": frame_idx,
                    **result["stats"],
                    "corridor": result["corridor"],
                }
                if pending_events:
                    # Previously dropped on the floor here — the decision engine
                    # computed congestion/ambulance/accident alerts every frame,
                    # but the frontend's live alerts feed had nothing to render
                    # because these never left the backend. Accumulate across
                    # the throttle window too, so an event on a skipped frame
                    # (frame_idx % 5 != 0) doesn't just vanish.
                    payload["events"] = pending_events
                    pending_events = []
                # live preview: downscale + JPEG-encode the annotated frame so the
                # dashboard can show real detection happening, not just numbers.
                # Previously nested behind an additional `% 10 == 0` check, so the
                # image only updated ~2.5x/sec at 25fps source — visibly choppy,
                # which reads as "boxes lagging/misaligned" even though each
                # individual frame's boxes were correctly placed. Now sends on
                # every stats tick (~5x/sec) instead; still throttled/downscaled
                # deliberately — this is a simple low-fps preview over an
                # existing WS connection, not a low-latency streaming protocol
                # (that would be WebRTC/HLS territory).
                preview_h = int(480 * frame.shape[0] / frame.shape[1])
                preview = cv2.resize(frame, (480, preview_h))
                ok, buf = cv2.imencode(".jpg", preview, [cv2.IMWRITE_JPEG_QUALITY, 60])
                if ok:
                    payload["frame_jpeg"] = base64.b64encode(buf).decode("ascii")
                _broadcast_threadsafe(loop, payload)

        cap.release()
        writer.release()

        video.status = VideoStatus.analyzing
        db.commit()

        _persist_events(db, video, engine)

        video.output_path = out_path
        video.status = VideoStatus.completed
        video.progress_pct = 100
        db.commit()

        _broadcast_threadsafe(loop, {"video_id": video.id, "status": "completed"})

    except Exception as exc:  # pragma: no cover
        video.status = VideoStatus.failed
        video.error_message = str(exc)
        db.commit()
        _broadcast_threadsafe(loop, {"video_id": video.id, "status": "failed", "error": str(exc)})
    finally:
        db.close()


def _draw_overlay(frame, tracked_objects, emergency_ids, result):
    for obj in tracked_objects:
        x1, y1, x2, y2 = [int(v) for v in obj.bbox]
        is_emergency = obj.track_id in emergency_ids
        color = (0, 0, 255) if is_emergency else (46, 204, 113)
        cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)
        label = f"{'AMBULANCE' if is_emergency else obj.cls} {obj.confidence*100:.0f}% #{obj.track_id}"
        cv2.putText(frame, label, (x1, max(15, y1 - 8)), cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 2)

    stats = result["stats"]
    overlay_text = f"Total: {stats['total']}  Density: {stats['density']}  Avg Speed: {stats['avg_speed']} km/h"
    cv2.putText(frame, overlay_text, (12, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.65, (255, 255, 255), 2)

    if result["corridor"]["active"]:
        cv2.putText(frame, "GREEN CORRIDOR ACTIVE", (12, 56), cv2.FONT_HERSHEY_SIMPLEX, 0.65, (0, 255, 0), 2)


def _persist_events(db: Session, video: Video, engine: DecisionEngine):
    for event in engine.log:
        db.add(TrafficEvent(
            video_id=video.id,
            event_type=event.event_type,
            severity=event.severity,
            description=event.description,
            frame_number=event.frame_number,
        ))

    for track_id, history in engine.intelligence.tracks.items():
        db.add(Detection(
            video_id=video.id,
            track_id=track_id,
            vehicle_class=history.cls,
            first_seen_frame=history.positions[0][0] if history.positions else 0,
            last_seen_frame=history.positions[-1][0] if history.positions else 0,
            avg_confidence=0.0,  # wire through from detector if per-track confidence history is retained
            is_emergency_vehicle=track_id in engine.ambulance_tracks,
        ))
    db.commit()
