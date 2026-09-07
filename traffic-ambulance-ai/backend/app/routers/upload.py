import shutil
from pathlib import Path

from fastapi import APIRouter, UploadFile, File, HTTPException, BackgroundTasks, Depends
from sqlalchemy.orm import Session

from ..config import settings
from ..database import get_db, SessionLocal
from ..models import Video, VideoStatus
from ..schemas import VideoOut
from ..services.video_processor import process_video
from ..auth import require_role

router = APIRouter(prefix="/videos", tags=["upload"])


@router.post("/upload", response_model=list[VideoOut])
async def upload_videos(
    background_tasks: BackgroundTasks,
    files: list[UploadFile] = File(...),
    db: Session = Depends(get_db),
):
    if len(files) > settings.MAX_CONCURRENT_UPLOADS:
        raise HTTPException(400, f"Maximum {settings.MAX_CONCURRENT_UPLOADS} videos per batch")

    created = []
    for file in files:
        ext = Path(file.filename).suffix.lower()
        if ext not in settings.ALLOWED_VIDEO_EXTENSIONS:
            raise HTTPException(400, f"Unsupported file type: {ext}")

        dest = settings.UPLOAD_DIR / file.filename
        with open(dest, "wb") as out:
            shutil.copyfileobj(file.file, out)

        video = Video(filename=file.filename, stored_path=str(dest), status=VideoStatus.queued)
        db.add(video)
        db.commit()
        db.refresh(video)
        created.append(video)

        background_tasks.add_task(process_video, video.id, SessionLocal)

    return created


@router.get("", response_model=list[VideoOut])
def list_videos(db: Session = Depends(get_db)):
    return db.query(Video).order_by(Video.created_at.desc()).all()


@router.get("/{video_id}", response_model=VideoOut)
def get_video(video_id: str, db: Session = Depends(get_db)):
    video = db.query(Video).filter(Video.id == video_id).first()
    if not video:
        raise HTTPException(404, "Video not found")
    return video


@router.get("/{video_id}/download")
def download_processed(video_id: str, db: Session = Depends(get_db)):
    from fastapi.responses import FileResponse
    video = db.query(Video).filter(Video.id == video_id).first()
    if not video or not video.output_path:
        raise HTTPException(404, "Processed video not available yet")
    return FileResponse(video.output_path, media_type="video/mp4", filename=f"{video.filename}_annotated.mp4")


@router.delete("/{video_id}")
def cancel_or_delete(
    video_id: str,
    db: Session = Depends(get_db),
    _admin=Depends(require_role("admin", "manager")),
):
    video = db.query(Video).filter(Video.id == video_id).first()
    if not video:
        raise HTTPException(404, "Video not found")
    db.delete(video)
    db.commit()
    return {"deleted": True}
