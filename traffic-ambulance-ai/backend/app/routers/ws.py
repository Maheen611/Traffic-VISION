from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from ..websocket_manager import manager

router = APIRouter(tags=["websocket"])


@router.websocket("/ws")
async def dashboard_socket(websocket: WebSocket):
    """
    The frontend's sidebar 'Connect Live Backend' field points here, e.g.
    ws://localhost:8000/ws. Every `manager.broadcast(...)` call from the
    video pipeline pushes a JSON payload matching schemas.LiveFrameStats
    to every connected client — the same shape the frontend's simulation
    state already uses, so no frontend changes are needed to go live.
    """
    await manager.connect(websocket)
    try:
        while True:
            await websocket.receive_text()  # keep-alive / future client commands
    except WebSocketDisconnect:
        manager.disconnect(websocket)
