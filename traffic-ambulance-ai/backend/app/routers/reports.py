from fastapi import APIRouter, Depends
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from ..database import get_db
from ..services.report_generator import generate_csv, generate_pdf

router = APIRouter(prefix="/reports", tags=["reports"])


@router.get("/{video_id}/csv")
def download_csv(video_id: str, db: Session = Depends(get_db)):
    path = generate_csv(db, video_id)
    return FileResponse(path, media_type="text/csv", filename=path.name)


@router.get("/{video_id}/pdf")
def download_pdf(video_id: str, db: Session = Depends(get_db)):
    path = generate_pdf(db, video_id)
    return FileResponse(path, media_type="application/pdf", filename=path.name)
