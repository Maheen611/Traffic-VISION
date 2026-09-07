# TrafficVision AI
### Intelligent Emergency Vehicle Priority System Using AI-Based Traffic Signal Management

This repo has two parts:

- **`frontend/`** — the command-center UI, split into separate files (Tailwind + vanilla JS + Chart.js + Leaflet): `index.html` (markup), `styles.css` (custom styles + precompiled Tailwind), `app.js` (all application logic), `vendor/` (Leaflet + Chart.js, bundled locally — no CDN calls, works fully offline). Open `index.html` directly, no build step, no backend required — every panel runs off an in-browser simulation until you connect a real backend (see below). Navigation is a top bar, not a sidebar.
- **`backend/`** — a real FastAPI service implementing the actual perception pipeline: YOLOv11 detection, ByteTrack tracking (via Ultralytics' built-in tracker), density/speed calculation, ambulance priority + green corridor state machine, accident heuristics, PostgreSQL persistence, WebSocket broadcast, and CSV/PDF report generation.

Point the frontend's **backend connect panel** (top-right pill, click to expand) at your running backend:
- WebSocket URL (`ws://localhost:8000/ws`) → live dashboard stats, same as before
- REST API URL (`http://localhost:8000/api/v1`) → **real video uploads**. Once set, both the Video Intelligence page and the Live CCTV Grid's per-tile upload button actually `POST` to `/videos/upload`, poll `/videos/{id}` for status, and swap in the real annotated output once the backend finishes — not simulated. If the backend is unreachable at any point, it falls back to the client-side simulation automatically rather than getting stuck.

---

## Why it's split this way

YOLOv11 inference needs a Python process (ideally with a GPU) — it can't run inside a static web page. Rather than fake that with a broken "AI" that isn't real, the frontend is honest about being in simulation mode until it's wired up, and the backend is real, runnable code you can point a GPU box at.

---

## Quick start

### 1. Frontend only (no install)
Just open `frontend/index.html` in a browser. That's it — everything on screen is live and interactive.

### 2. Full stack with Docker
```bash
docker compose up --build
```
- Frontend: http://localhost:8080
- Backend API: http://localhost:8000 (docs at `/docs`)
- Postgres: localhost:5432

### 3. Backend without Docker
```bash
python -m venv .venv && source .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env                                     # edit DATABASE_URL etc.
# start a local Postgres instance, then:
cd backend
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```
First run downloads the YOLO weights specified by `YOLO_WEIGHTS` (default `yolo11n.pt`, a small COCO-pretrained checkpoint) automatically via Ultralytics.

**On a GPU machine**, set `YOLO_DEVICE=cuda:0` in `.env` — inference on CPU works but is slow for real-time video.

---

## Important: the "ambulance" class

Stock COCO-pretrained YOLO weights (`yolo11n.pt`, `yolo11s.pt`, ...) know `car`, `bus`, `truck`, `motorcycle`, `bicycle`, `person` — **not** `ambulance`, `police_vehicle`, or `fire_truck`. To genuinely detect those:

1. Collect/annotate an emergency-vehicle dataset (Roboflow Universe has several public ones to start from).
2. Fine-tune YOLOv11 on it (`yolo train data=emergency.yaml model=yolo11n.pt`).
3. Point `YOLO_WEIGHTS` at the resulting checkpoint.

Until then, `backend/app/ai/detector.py` includes `classify_emergency_heuristic()` — a documented, best-effort livery-colour/aspect-ratio heuristic — so the pipeline still runs end-to-end, but treat it as a placeholder, not a real classifier.

---

## Folder structure

```
traffic-ambulance-ai/
├── frontend/
│   ├── index.html                 # markup only — top nav, no sidebar
│   ├── styles.css                 # custom styles + precompiled Tailwind
│   ├── app.js                     # all application logic (state, charts, map, upload, CCTV grid...)
│   └── vendor/
│       ├── leaflet.js / leaflet.css
│       └── chart.js
├── backend/
│   └── app/
│       ├── main.py                # FastAPI app + router wiring
│       ├── config.py               # env-driven settings
│       ├── database.py             # SQLAlchemy engine/session
│       ├── models.py               # Video, Detection, TrafficEvent, Camera, Hospital, User
│       ├── schemas.py              # Pydantic request/response models
│       ├── websocket_manager.py    # live broadcast to connected dashboards
│       ├── ai/
│       │   ├── detector.py         # YOLOv11 + ByteTrack wrapper
│       │   ├── traffic_intelligence.py  # density / speed / flow
│       │   ├── ambulance.py        # ambulance confirmation + green corridor FSM
│       │   ├── accident.py         # collision / stop / blockage heuristics
│       │   └── decision_engine.py  # ties it all together, logs every decision
│       ├── services/
│       │   ├── video_processor.py  # end-to-end pipeline per uploaded video
│       │   └── report_generator.py # CSV + PDF export
│       ├── auth.py                 # bcrypt password hashing + JWT + role-based access
│       ├── routers/
│       │   ├── auth.py             # POST /auth/register, /auth/login, GET /auth/me
│       │   ├── upload.py           # POST /videos/upload, list/get/download/delete
│       │   ├── analytics.py        # per-video detections/events + summary
│       │   ├── reports.py          # /reports/{id}/csv, /reports/{id}/pdf
│       │   ├── cameras.py          # camera CRUD (RTSP/IP/ESP32 URLs) — admin/manager only
│       │   └── ws.py                # /ws — live dashboard stream
│       └── training/               # real YOLO fine-tuning pipeline for ambulance/police/fire-truck
│           ├── README.md           # dataset options (with live links), full workflow
│           ├── data.yaml           # unified 10-class taxonomy
│           ├── download_dataset.py # pull a dataset from Roboflow Universe
│           ├── merge_datasets.py   # unify differing class taxonomies into one dataset
│           ├── class_balance_report.py  # per-class instance counts before you train
│           ├── train.py            # fine-tune + rare-class oversampling
│           └── evaluate.py         # per-class AP, not just overall mAP
├── requirements.txt
├── Dockerfile
├── docker-compose.yml
├── .env.example
└── README.md
```

---

## API summary

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/v1/videos/upload` | Upload up to 4 videos, kicks off background processing |
| GET | `/api/v1/videos` | List videos + status |
| GET | `/api/v1/videos/{id}` | Single video status/progress |
| GET | `/api/v1/videos/{id}/download` | Download the annotated MP4 |
| GET | `/api/v1/analytics/{id}/detections` | Per-track detection summary |
| GET | `/api/v1/analytics/{id}/events` | Decision engine event log |
| GET | `/api/v1/analytics/summary` | Global counters |
| GET | `/api/v1/reports/{id}/csv` \| `/pdf` | Downloadable reports |
| GET/POST/DELETE | `/api/v1/cameras` | Camera (RTSP/IP/ESP32) management — POST/DELETE require `admin`/`manager` role |
| POST | `/api/v1/auth/register` \| `/login` | Real JWT auth (bcrypt password hashing, role-based access) |
| GET | `/api/v1/auth/me` | Current authenticated user |
| POST | `/api/v1/assistant/ask` | RAG-lite AI assistant — real DB retrieval + Groq LLM generation (needs `GROQ_API_KEY`) |
| WS | `/ws` | Live per-frame stats **and** a throttled JPEG preview frame for the dashboard |

Full interactive docs at `/docs` once the backend is running (FastAPI's built-in Swagger UI).

---

## What's genuinely implemented vs. what's scaffolded

**Real, working logic:** density/speed calculation from tracked centroids, the green-corridor state machine, accident heuristics (sudden stop, stationary, IoU-based collision), ByteTrack integration via Ultralytics' `.track()`, CSV/PDF report generation, the full REST + WebSocket API, Postgres schema, JWT authentication with bcrypt password hashing and role-based access control (tested end-to-end: register → login → protected route → wrong-password rejection → role-based 403), a full YOLO fine-tuning pipeline for real ambulance/police/fire-truck detection (`backend/training/`), `backend/scripts/local_test_detect.py` (run end-to-end against a real downloaded YOLO checkpoint), **a real AI assistant** (`/assistant/ask` — retrieves real rows from `traffic_events`/`detections`, sends them as grounding context to a Groq-hosted LLM; tested end-to-end with the network call mocked and everything else — retrieval, error handling for a missing/bad key — exercised for real), and **a live detection preview during processing** — every 10 frames the backend downscales and JPEG-encodes the actual annotated frame and pushes it over the WebSocket, so the dashboard shows real detection happening while a video is still processing, not just a progress bar. Verified end-to-end: ran a real video through the pipeline, decoded the broadcast JPEG back out, confirmed it's a valid, correctly annotated frame.

**Scaffolded / needs your input to be production-grade:**
- Per-camera pixel-to-metre calibration (defaults to a placeholder constant — measure this per install for accurate km/h)
- Live CCTV/RTSP ingestion — `Camera.stream_url` is modeled, but the processing loop currently reads uploaded files; point `cv2.VideoCapture()` at an RTSP URL to extend it
- Actually running `backend/training/` against a real dataset (needs a GPU + a few hours — you clearly have working GPU inference locally already given your `yolo11l.pt` notebook, so this is very within reach)
- Upgrading the AI assistant's retrieval from keyword/recency (what's implemented) to embedding-based semantic search (e.g. ChromaDB, matching the original brief) — architecturally a small swap (see the docstring in `rag_assistant.py`), but ChromaDB's default embedding function downloads a ~90MB model from Hugging Face on first use, which needs one-time internet access on whichever machine runs the backend

**A dependency `pip install -r requirements.txt` alone won't catch:** Ultralytics' `.track(tracker="bytetrack.yaml")` needs the `lap` package at runtime — it auto-installs itself the first time you call `.track()` if missing (you'll see an "AutoUpdate" message), but it's now pinned in `requirements.txt` too so a fresh install doesn't depend on that happening silently mid-run.

---

## A note on a real bug that was caught and fixed here

**The frontend's WebSocket handler was silently ignoring most of what the backend sent it.** It did `Object.assign(state, data)` directly — but the backend broadcasts snake_case fields (`avg_speed`, `max_speed`) and a nested `corridor: {active, current_step}` object, while the frontend's own state uses camelCase (`avgSpeed`, `maxSpeed`) and flat fields (`corridorActive`, `corridorStep`). The blind assign created harmless-looking *new* dead fields (`state.avg_speed`) sitting right next to the real ones the UI actually reads (`state.avgSpeed`), which never updated. Nothing crashed or logged an error — the dashboard just quietly kept showing stale speed/corridor numbers once connected to a live backend. Fixed by explicitly mapping each incoming field onto the correct state property instead of assuming the shapes matched.

**This one broke every upload — worth reading if anything here ever silently 500s again.** `config.py` originally defined `UPLOAD_DIR`, `OUTPUT_DIR`, and `REPORT_DIR` as bare module-level variables, but `upload.py`, `video_processor.py`, and `report_generator.py` all referenced them as `settings.UPLOAD_DIR` / `settings.OUTPUT_DIR` / `settings.REPORT_DIR` — attributes that didn't exist on the `Settings` instance. Every single video upload crashed immediately with `AttributeError: 'Settings' object has no attribute 'UPLOAD_DIR'`, and report downloads would have hit the same wall the moment they were reached. This one slipped through earlier because it was only ever syntax-checked and import-tested, never exercised with an actual file POST. Caught by finally sending a real video through `POST /videos/upload` end-to-end — moved the three paths onto the `Settings` class itself, then reran upload → background YOLO processing → download → CSV → PDF, all the way through: all five now return real, correct results against a real (tiny) test video.

The first pass of the auth module used `passlib[bcrypt]`. `passlib` 1.7.4 (its latest release) is incompatible with `bcrypt` 4.1+ — it throws a bogus `password cannot be longer than 72 bytes` error on *any* password, including short ones, because of a broken version-detection check. This was caught by actually running the register/login flow end-to-end against a live database (not just reading the code), and fixed by calling `bcrypt` directly instead of going through `passlib`. If you hit that exact error anywhere else in a Python project, that's why.
