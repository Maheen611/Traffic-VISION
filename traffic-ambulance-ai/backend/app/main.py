from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import settings
from .database import init_db
from .routers import upload, analytics, reports, cameras, ws, auth, assistant

app = FastAPI(title=settings.APP_NAME, version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def on_startup():
    init_db()


@app.get("/health")
def health():
    return {"status": "ok", "service": settings.APP_NAME}


app.include_router(auth.router, prefix=settings.API_V1_PREFIX)
app.include_router(assistant.router, prefix=settings.API_V1_PREFIX)
app.include_router(upload.router, prefix=settings.API_V1_PREFIX)
app.include_router(analytics.router, prefix=settings.API_V1_PREFIX)
app.include_router(reports.router, prefix=settings.API_V1_PREFIX)
app.include_router(cameras.router, prefix=settings.API_V1_PREFIX)
app.include_router(ws.router)  # exposed at /ws, not under the versioned prefix

# Run with: uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
