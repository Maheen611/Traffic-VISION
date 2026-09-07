"""
RAG-lite AI assistant: retrieves relevant recent traffic events and
detections from Postgres, builds a grounding context block, and asks
Groq's hosted LLM to answer the operator's question using only that
context.

This uses keyword + recency retrieval over real rows rather than a
vector database — zero extra infrastructure, and just as valid a form
of "retrieval augmented generation." To upgrade to embedding-based
semantic search (e.g. ChromaDB, matching the original brief), swap
`retrieve_context()` for a vector query. Worth knowing before you do:
ChromaDB's default embedding function downloads a ~90MB model from
Hugging Face the first time it runs, so that upgrade needs one-time
internet access on whichever machine runs the backend.
"""
from typing import Optional, List

from sqlalchemy.orm import Session
from sqlalchemy import desc

from ..models import TrafficEvent, Detection
from ..config import settings

SYSTEM_PROMPT = (
    "You are the AI assistant embedded in TrafficVision AI, a traffic-signal "
    "management dashboard for a live intersection network. Answer the "
    "operator's question using ONLY the CONTEXT block below — real events, "
    "detections and signal decisions from the system's own database. If the "
    "context doesn't contain the answer, say so plainly rather than "
    "guessing. Keep answers short (2-4 sentences), operational, and "
    "specific — cite vehicle/track IDs, timestamps or counts from the "
    "context when relevant."
)


def retrieve_context(db: Session, question: str, video_id: Optional[str] = None, limit: int = 20) -> str:
    """Keyword + recency retrieval over real event/detection rows — no vector DB required."""
    q = db.query(TrafficEvent)
    if video_id:
        q = q.filter(TrafficEvent.video_id == video_id)
    events: List[TrafficEvent] = q.order_by(desc(TrafficEvent.created_at)).limit(200).all()

    keywords = [w.lower().strip("?.,!") for w in question.split() if len(w) > 3]
    if keywords and events:
        scored = sorted(
            events,
            key=lambda e: sum(1 for k in keywords if k in e.description.lower()),
            reverse=True,
        )
        matched = [e for e in scored if any(k in e.description.lower() for k in keywords)]
        events = (matched or events)[:limit]
    else:
        events = events[:limit]

    lines = [f"[{e.created_at}] ({e.severity}) {e.event_type}: {e.description}" for e in events]

    det_q = db.query(Detection).filter(Detection.is_emergency_vehicle.is_(True))
    if video_id:
        det_q = det_q.filter(Detection.video_id == video_id)
    for d in det_q.limit(10).all():
        lines.append(
            f"[detection] track #{d.track_id} ({d.vehicle_class}) flagged as emergency vehicle, "
            f"avg speed {d.avg_speed_kmh if d.avg_speed_kmh is not None else 'unknown'} km/h"
        )

    return "\n".join(lines) if lines else "No matching events found in the database yet."


def answer_question(db: Session, question: str, video_id: Optional[str] = None,
                     image_base64: Optional[str] = None) -> dict:
    if not settings.GROQ_API_KEY:
        return {
            "answer": (
                "GROQ_API_KEY isn't set on the backend. Add it to your .env file "
                "(see .env.example — get a free key at console.groq.com/keys) and "
                "restart the server to enable the AI assistant."
            ),
            "context_used": "",
        }

    context = retrieve_context(db, question, video_id)

    from groq import Groq  # imported lazily so the app still boots without the package installed
    client = Groq(api_key=settings.GROQ_API_KEY)

    if image_base64:
        # Vision request: image + question go in one user message, OpenAI-compatible
        # content-list format (Groq's vision models use the same shape). Retrieved
        # DB context still goes in as a separate text block so the model can ground
        # its answer in both the picture and real system state.
        model = settings.GROQ_VISION_MODEL
        user_content = [
            {"type": "text", "text": f"CONTEXT:\n{context}\n\nQUESTION: {question}"},
            {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{image_base64}"}},
        ]
    else:
        model = settings.GROQ_MODEL
        user_content = f"CONTEXT:\n{context}\n\nQUESTION: {question}"

    try:
        completion = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_content},
            ],
            temperature=0.3,
            max_tokens=300,
        )
        answer = completion.choices[0].message.content
    except Exception as exc:  # noqa: BLE001 — surface any Groq/network error to the operator, don't 500
        hint = " (check GROQ_VISION_MODEL is a currently-valid vision model name)" if image_base64 else ""
        answer = f"Couldn't reach Groq ({exc}){hint}. Check GROQ_API_KEY and network access on the backend."

    return {"answer": answer, "context_used": context}
