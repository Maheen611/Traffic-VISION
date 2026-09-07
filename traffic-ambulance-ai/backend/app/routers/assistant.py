from typing import Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..database import get_db
from ..services.rag_assistant import answer_question

router = APIRouter(prefix="/assistant", tags=["assistant"])


class AskIn(BaseModel):
    question: str
    video_id: Optional[str] = None  # scope retrieval to one video's events, or omit for system-wide
    image_base64: Optional[str] = None  # optional attached photo/frame, raw base64 (no data: prefix)


class AskOut(BaseModel):
    answer: str
    context_used: str  # the retrieved context actually sent to the LLM — useful for debugging/trust


@router.post("/ask", response_model=AskOut)
def ask(payload: AskIn, db: Session = Depends(get_db)):
    return answer_question(db, payload.question, payload.video_id, payload.image_base64)
