"""
Central configuration for the TrafficVision AI backend.
All values are overridable via environment variables / .env file.
"""
import os
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

BASE_DIR = Path(__file__).resolve().parent.parent


class Settings:
    APP_NAME: str = "TrafficVision AI"
    API_V1_PREFIX: str = "/api/v1"

    DATABASE_URL: str = os.getenv(
        "DATABASE_URL",
        "postgresql+psycopg2://postgres:postgres@localhost:5432/trafficvision",
    )

    # Storage paths. These are read as settings.UPLOAD_DIR / settings.OUTPUT_DIR /
    # settings.REPORT_DIR throughout upload.py, video_processor.py and
    # report_generator.py — they must live on the Settings instance, not as
    # bare module-level names, or every one of those call sites raises
    # AttributeError the moment a real file hits them.
    UPLOAD_DIR: Path = BASE_DIR / "storage" / "uploads"
    OUTPUT_DIR: Path = BASE_DIR / "storage" / "processed"
    REPORT_DIR: Path = BASE_DIR / "storage" / "reports"

    # YOLO model weights. Use a fine-tuned checkpoint that includes an
    # "ambulance" / "police_vehicle" / "fire_truck" class for real emergency
    # detection — the stock COCO-pretrained yolov11 weights only cover
    # generic classes (car, bus, truck, motorcycle, person, bicycle, etc).
    YOLO_WEIGHTS: str = os.getenv("YOLO_WEIGHTS", "yolo11n.pt")
    YOLO_DEVICE: str = os.getenv("YOLO_DEVICE", "cpu")  # "cuda:0" if a GPU is available
    YOLO_CONFIDENCE: float = float(os.getenv("YOLO_CONFIDENCE", "0.35"))
    # Inference resolution — see the comment in ai/detector.py. Raise to 1280
    # if you're still missing small/distant vehicles on your own footage;
    # lower back toward 640 if you need more speed on CPU and your camera
    # is close/zoomed-in enough that objects are already large in frame.
    YOLO_IMGSZ: int = int(os.getenv("YOLO_IMGSZ", "960"))
    TRACKER_CONFIG: str = os.getenv("TRACKER_CONFIG", "bytetrack.yaml")

    # Which detector pipeline video_processor.py uses — see
    # ai/roboflow_detector.py's get_detector() for the switch point and a
    # detailed writeup of the tradeoffs before flipping this in production.
    #   "yolo"      (default) — local YOLOv11 + ByteTrack, runs in-process,
    #                no API key/network/billing needed.
    #   "roboflow"  — RF-DETR + ByteTrack + SAM3 open-vocabulary ambulance
    #                detection, via Roboflow's hosted Serverless API.
    #                Requires ROBOFLOW_API_KEY and `pip install inference-sdk`.
    DETECTOR_BACKEND: str = os.getenv("DETECTOR_BACKEND", "yolo")
    ROBOFLOW_API_KEY: str = os.getenv("ROBOFLOW_API_KEY", "")
    ROBOFLOW_API_URL: str = os.getenv("ROBOFLOW_API_URL", "https://serverless.roboflow.com")

    MAX_CONCURRENT_UPLOADS: int = 4
    ALLOWED_VIDEO_EXTENSIONS = {".mp4", ".avi", ".mov", ".mkv"}

    # Real-world calibration: pixels-per-metre at the camera plane.
    # Without this, speed is reported in relative px/s. Set per-camera
    # in the `cameras` table for accurate km/h output.
    DEFAULT_PIXELS_PER_METRE: float = float(os.getenv("DEFAULT_PIXELS_PER_METRE", "8.0"))
    SPEED_LIMIT_KMH: float = float(os.getenv("SPEED_LIMIT_KMH", "60.0"))

    DENSITY_THRESHOLDS = {"low": 15, "medium": 30, "high": 50}  # vehicles in frame

    CORS_ORIGINS = os.getenv("CORS_ORIGINS", "*").split(",")

    # AI Assistant (RAG-lite: real DB retrieval + Groq-hosted LLM generation).
    # Get a free key at console.groq.com/keys — never commit it, .env only.
    GROQ_API_KEY: str = os.getenv("GROQ_API_KEY", "")
    # Groq's model lineup changes often (they deprecated llama-3.3-70b-versatile
    # and llama-3.1-8b-instant in June 2026) — verify current names at
    # console.groq.com/docs/models if either of these ever starts erroring.
    GROQ_MODEL: str = os.getenv("GROQ_MODEL", "openai/gpt-oss-120b")
    GROQ_VISION_MODEL: str = os.getenv("GROQ_VISION_MODEL", "qwen/qwen3.6-27b")  # multimodal (text+image)


settings = Settings()

for _dir in (settings.UPLOAD_DIR, settings.OUTPUT_DIR, settings.REPORT_DIR):
    _dir.mkdir(parents=True, exist_ok=True)
