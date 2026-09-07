from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Camera
from ..schemas import CameraCreate, CameraOut
from ..auth import require_role

router = APIRouter(prefix="/cameras", tags=["cameras"])


@router.get("", response_model=list[CameraOut])
def list_cameras(db: Session = Depends(get_db)):
    return db.query(Camera).all()


@router.post("", response_model=CameraOut)
def add_camera(
    payload: CameraCreate,
    db: Session = Depends(get_db),
    _admin=Depends(require_role("admin", "manager")),
):
    camera = Camera(**payload.model_dump())
    db.add(camera)
    db.commit()
    db.refresh(camera)
    return camera


@router.delete("/{camera_id}")
def remove_camera(
    camera_id: str,
    db: Session = Depends(get_db),
    _admin=Depends(require_role("admin")),
):
    camera = db.query(Camera).filter(Camera.id == camera_id).first()
    if not camera:
        raise HTTPException(404, "Camera not found")
    db.delete(camera)
    db.commit()
    return {"deleted": True}
