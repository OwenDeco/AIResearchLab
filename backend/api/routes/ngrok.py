from __future__ import annotations

import logging
import subprocess
import time
from typing import Optional

import httpx
from fastapi import APIRouter, HTTPException

from config import settings

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/ngrok", tags=["ngrok"])

# Module-level process handle and current tunnel URL.
# Single-process app so a module global is safe.
_process: Optional[subprocess.Popen] = None
_url: Optional[str] = None


def _is_running() -> bool:
    global _process
    return _process is not None and _process.poll() is None


def _poll_tunnel_url(timeout: float = 10.0) -> Optional[str]:
    """Poll the local ngrok API until a HTTPS tunnel URL appears."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        time.sleep(0.5)
        try:
            r = httpx.get("http://localhost:4040/api/tunnels", timeout=2.0)
            tunnels = r.json().get("tunnels", [])
            for t in tunnels:
                if t.get("proto") == "https":
                    return t["public_url"]
        except Exception:
            pass
    return None


# ---------------------------------------------------------------------------
# GET /api/ngrok/status
# ---------------------------------------------------------------------------

@router.get("/status")
def get_status():
    """Return the current ngrok tunnel status."""
    global _process, _url
    if not _is_running():
        _process = None
        _url = None
    return {"running": _is_running(), "url": _url}


# ---------------------------------------------------------------------------
# POST /api/ngrok/start
# ---------------------------------------------------------------------------

@router.post("/start")
def start_ngrok():
    """Start an ngrok tunnel on port 8002."""
    global _process, _url

    if _is_running():
        return {"running": True, "url": _url}

    logger.info("Starting ngrok tunnel on port 8002 …")
    try:
        _process = subprocess.Popen(
            ["ngrok", "http", "8002", "--log=stdout"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except FileNotFoundError:
        raise HTTPException(
            status_code=500,
            detail="ngrok executable not found. Install it with: winget install ngrok.ngrok",
        )

    tunnel_url = _poll_tunnel_url(timeout=12.0)

    if not tunnel_url:
        _process.kill()
        _process = None
        raise HTTPException(
            status_code=500,
            detail="ngrok started but tunnel URL was not available within 12 s. "
                   "Make sure your ngrok authtoken is configured.",
        )

    _url = tunnel_url
    logger.info("ngrok tunnel active: %s", tunnel_url)

    from database import SessionLocal
    from api.conn_log import log_conn_event
    _db = SessionLocal()
    try:
        log_conn_event(
            _db,
            event_type="ngrok_start",
            direction="system",
            connection_type="ngrok",
            summary=f"ngrok tunnel started → {tunnel_url}",
            details={"url": tunnel_url},
        )
    finally:
        _db.close()

    return {"running": True, "url": tunnel_url}


# ---------------------------------------------------------------------------
# POST /api/ngrok/stop
# ---------------------------------------------------------------------------

@router.post("/stop")
def stop_ngrok():
    """Stop the running ngrok tunnel."""
    global _process, _url

    if _process:
        logger.info("Stopping ngrok …")
        _process.terminate()
        try:
            _process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            _process.kill()
        _process = None

    _url = None
    logger.info("ngrok stopped")

    from database import SessionLocal
    from api.conn_log import log_conn_event
    _db = SessionLocal()
    try:
        log_conn_event(
            _db,
            event_type="ngrok_stop",
            direction="system",
            connection_type="ngrok",
            summary="ngrok tunnel stopped",
        )
    finally:
        _db.close()

    return {"running": False, "url": None}
