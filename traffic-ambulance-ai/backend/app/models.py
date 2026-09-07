import enum
import uuid

from sqlalchemy import (
    Column, String, Integer, Float, Boolean, DateTime, ForeignKey, Enum, Text, func
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship

from .database import Base


def gen_uuid():
    return str(uuid.uuid4())


class VideoStatus(str, enum.Enum):
    queued = "queued"
    uploading = "uploading"
    processing = "processing"
    detecting = "detecting"
    tracking = "tracking"
    analyzing = "analyzing"
    completed = "completed"
    failed = "failed"


class Video(Base):
    __tablename__ = "videos"

    id = Column(UUID(as_uuid=False), primary_key=True, default=gen_uuid)
    filename = Column(String, nullable=False)
    stored_path = Column(String, nullable=False)
    output_path = Column(String, nullable=True)
    duration_seconds = Column(Float, nullable=True)
    width = Column(Integer, nullable=True)
    height = Column(Integer, nullable=True)
    fps = Column(Float, nullable=True)
    status = Column(Enum(VideoStatus), default=VideoStatus.queued, nullable=False)
    progress_pct = Column(Integer, default=0)
    camera_id = Column(String, ForeignKey("cameras.id"), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    completed_at = Column(DateTime(timezone=True), nullable=True)
    error_message = Column(Text, nullable=True)

    detections = relationship("Detection", back_populates="video", cascade="all, delete-orphan")
    events = relationship("TrafficEvent", back_populates="video", cascade="all, delete-orphan")


class Detection(Base):
    """One row per tracked object, aggregated across its lifetime in a video."""
    __tablename__ = "detections"

    id = Column(Integer, primary_key=True, autoincrement=True)
    video_id = Column(UUID(as_uuid=False), ForeignKey("videos.id"), nullable=False)
    track_id = Column(Integer, nullable=False)
    vehicle_class = Column(String, nullable=False)  # car, bus, truck, ambulance, ...
    first_seen_frame = Column(Integer, nullable=False)
    last_seen_frame = Column(Integer, nullable=False)
    avg_confidence = Column(Float, nullable=False)
    avg_speed_kmh = Column(Float, nullable=True)
    max_speed_kmh = Column(Float, nullable=True)
    lane = Column(String, nullable=True)
    is_emergency_vehicle = Column(Boolean, default=False)

    video = relationship("Video", back_populates="detections")


class TrafficEvent(Base):
    """Discrete decisions/alerts: green corridor, accident, congestion warning, reroute."""
    __tablename__ = "traffic_events"

    id = Column(Integer, primary_key=True, autoincrement=True)
    video_id = Column(UUID(as_uuid=False), ForeignKey("videos.id"), nullable=True)
    event_type = Column(String, nullable=False)  # green_corridor | accident | congestion | reroute | signal_change
    severity = Column(String, default="info")     # info | warning | high | critical
    description = Column(Text, nullable=False)
    frame_number = Column(Integer, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    video = relationship("Video", back_populates="events")


class Camera(Base):
    __tablename__ = "cameras"

    id = Column(String, primary_key=True, default=gen_uuid)
    name = Column(String, nullable=False)
    stream_url = Column(String, nullable=True)  # RTSP / ESP32 / IP camera URL
    location = Column(String, nullable=True)
    latitude = Column(Float, nullable=True)
    longitude = Column(Float, nullable=True)
    pixels_per_metre = Column(Float, default=8.0)
    is_online = Column(Boolean, default=True)


class Hospital(Base):
    __tablename__ = "hospitals"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String, nullable=False)
    latitude = Column(Float, nullable=False)
    longitude = Column(Float, nullable=False)


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String, nullable=False)
    email = Column(String, unique=True, nullable=False)
    hashed_password = Column(String, nullable=False)
    role = Column(String, default="viewer")  # admin | manager | viewer
    is_active = Column(Boolean, default=True)
