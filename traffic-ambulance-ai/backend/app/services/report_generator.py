"""CSV and PDF report generation for a processed video's session."""
import csv
from pathlib import Path

from sqlalchemy.orm import Session

from ..config import settings
from ..models import Video, Detection, TrafficEvent


def generate_csv(db: Session, video_id: str) -> Path:
    detections = db.query(Detection).filter(Detection.video_id == video_id).all()
    path = settings.REPORT_DIR / f"{video_id}_detections.csv"
    with open(path, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["track_id", "vehicle_class", "first_seen_frame", "last_seen_frame",
                          "avg_speed_kmh", "max_speed_kmh", "is_emergency_vehicle"])
        for d in detections:
            writer.writerow([d.track_id, d.vehicle_class, d.first_seen_frame, d.last_seen_frame,
                              d.avg_speed_kmh, d.max_speed_kmh, d.is_emergency_vehicle])
    return path


def generate_pdf(db: Session, video_id: str) -> Path:
    """Requires reportlab (see requirements.txt)."""
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfgen import canvas as pdf_canvas

    video = db.query(Video).filter(Video.id == video_id).first()
    events = db.query(TrafficEvent).filter(TrafficEvent.video_id == video_id).all()
    detections = db.query(Detection).filter(Detection.video_id == video_id).all()

    path = settings.REPORT_DIR / f"{video_id}_report.pdf"
    c = pdf_canvas.Canvas(str(path), pagesize=A4)
    width, height = A4
    y = height - 50

    c.setFont("Helvetica-Bold", 16)
    c.drawString(40, y, "TrafficVision AI — Session Report")
    y -= 24
    c.setFont("Helvetica", 10)
    c.drawString(40, y, f"Video: {video.filename if video else video_id}")
    y -= 30

    c.setFont("Helvetica-Bold", 12)
    c.drawString(40, y, f"Detections ({len(detections)})")
    y -= 18
    c.setFont("Helvetica", 9)
    for d in detections[:35]:
        c.drawString(40, y, f"#{d.track_id}  {d.vehicle_class}  avg {d.avg_speed_kmh or 0} km/h"
                             f"  {'EMERGENCY' if d.is_emergency_vehicle else ''}")
        y -= 13
        if y < 60:
            c.showPage()
            y = height - 50

    y -= 15
    c.setFont("Helvetica-Bold", 12)
    c.drawString(40, y, f"Events ({len(events)})")
    y -= 18
    c.setFont("Helvetica", 9)
    for e in events[:35]:
        c.drawString(40, y, f"[{e.severity.upper()}] {e.event_type}: {e.description[:90]}")
        y -= 13
        if y < 60:
            c.showPage()
            y = height - 50

    c.save()
    return path
