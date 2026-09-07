from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Detection, TrafficEvent, Video
from ..schemas import DetectionOut, TrafficEventOut

router = APIRouter(prefix="/analytics", tags=["analytics"])


@router.get("/{video_id}/detections", response_model=list[DetectionOut])
def detections_for_video(video_id: str, db: Session = Depends(get_db)):
    return db.query(Detection).filter(Detection.video_id == video_id).all()


@router.get("/{video_id}/events", response_model=list[TrafficEventOut])
def events_for_video(video_id: str, db: Session = Depends(get_db)):
    return (
        db.query(TrafficEvent)
        .filter(TrafficEvent.video_id == video_id)
        .order_by(TrafficEvent.created_at.desc())
        .all()
    )


@router.get("/summary")
def global_summary(db: Session = Depends(get_db)):
    total_videos = db.query(Video).count()
    total_detections = db.query(Detection).count()
    emergency_events = db.query(TrafficEvent).filter(TrafficEvent.event_type == "green_corridor").count()
    accident_events = db.query(TrafficEvent).filter(
        TrafficEvent.event_type.in_(["collision", "sudden_stop", "stationary"])
    ).count()
    return {
        "total_videos": total_videos,
        "total_detections": total_detections,
        "green_corridors": emergency_events,
        "accident_alerts": accident_events,
    }
