from datetime import datetime
from typing import Optional, List

from pydantic import BaseModel, ConfigDict


class VideoOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    filename: str
    status: str
    progress_pct: int
    duration_seconds: Optional[float] = None
    width: Optional[int] = None
    height: Optional[int] = None
    created_at: datetime
    error_message: Optional[str] = None


class DetectionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    track_id: int
    vehicle_class: str
    avg_confidence: float
    avg_speed_kmh: Optional[float]
    max_speed_kmh: Optional[float]
    is_emergency_vehicle: bool


class TrafficEventOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    event_type: str
    severity: str
    description: str
    created_at: datetime


class LiveFrameStats(BaseModel):
    """Broadcast to the frontend over WebSocket, once per processed frame batch."""
    video_id: str
    frame_number: int
    total: int
    counts: dict
    density: str
    avg_speed: float
    max_speed: float
    min_speed: float
    ambulance: Optional[dict] = None
    accident: Optional[dict] = None
    corridor_active: bool = False
    corridor_step: int = -1


class CameraCreate(BaseModel):
    name: str
    stream_url: Optional[str] = None
    location: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    pixels_per_metre: float = 8.0


class CameraOut(CameraCreate):
    model_config = ConfigDict(from_attributes=True)
    id: str
    is_online: bool
