from __future__ import annotations

import json
import logging
import os
import time
import uuid
from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from api.deps import get_db

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/agent", tags=["agent"])

_HISTORY_KEY = "agent_conversation"

# Docs directory: two levels up from this file (backend/api/routes → project root → docs)
_DOCS_DIR = os.path.normpath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..", "docs")
)

_SYSTEM_PROMPT_HEADER = """\
You are the RAG Lab Agent — an expert assistant with complete knowledge of the \
RAG Lab application. Answer questions about the project's features, APIs, \
configuration, parameters, retrieval modes, chunking strategies, graph extraction, \
benchmarking, models, and limitations.

You have access to the full project documentation below. Use it to give precise, \
accurate answers. When referencing API endpoints, include the full path and all \
relevant parameters. If something is genuinely not documented, say so.

Do not make up features or parameters that are not in the documentation.

===== PROJECT DOCUMENTATION =====
"""


# ---------------------------------------------------------------------------
# Load documentation — auto-reloads when any .md file changes
# ---------------------------------------------------------------------------

_docs_cache: Optional[str] = None
_docs_mtime: float = 0.0  # max mtime of all doc files at last load


def _doc_files() -> List[str]:
    """Return ordered list of doc file paths."""
    if not os.path.isdir(_DOCS_DIR):
        return []
    order = [
        "overview.md", "configuration.md", "chunking.md", "retrieval.md",
        "models.md", "graph.md", "benchmarking.md", "api-reference.md", "frontend.md",
        "a2a.md", "mcp.md",
    ]
    seen: set = set()
    paths: List[str] = []
    for fname in order:
        fpath = os.path.join(_DOCS_DIR, fname)
        if os.path.isfile(fpath):
            paths.append(fpath)
            seen.add(fname)
    try:
        for fname in sorted(os.listdir(_DOCS_DIR)):
            if fname.endswith(".md") and fname not in seen:
                paths.append(os.path.join(_DOCS_DIR, fname))
    except Exception:
        pass
    return paths


def _load_docs() -> str:
    """Return concatenated docs, reloading from disk whenever a file has changed."""
    global _docs_cache, _docs_mtime

    files = _doc_files()
    if not files:
        return "(No documentation available.)"

    # Check max mtime across all doc files
    try:
        current_mtime = max(os.path.getmtime(f) for f in files)
    except Exception:
        current_mtime = 0.0

    if _docs_cache is not None and current_mtime <= _docs_mtime:
        return _docs_cache  # nothing changed

    parts: List[str] = []
    for fpath in files:
        try:
            with open(fpath, "r", encoding="utf-8") as fh:
                parts.append(fh.read())
        except Exception as exc:
            logger.warning("Agent: could not read %s: %s", fpath, exc)

    combined = "\n\n---\n\n".join(parts) if parts else "(No documentation files found.)"
    logger.info("Agent: reloaded %d doc file(s), %d chars total.", len(parts), len(combined))

    _docs_cache = combined
    _docs_mtime = current_mtime
    return combined


def _build_system_prompt() -> str:
    return _SYSTEM_PROMPT_HEADER + _load_docs() + "\n\n===== END OF DOCUMENTATION ====="


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

class ChatMessage(BaseModel):
    role: str   # "user" or "assistant"
    content: str


class AgentChatRequest(BaseModel):
    message: str
    history: List[ChatMessage] = []


class SourceItem(BaseModel):
    chunk_id: str
    doc_id: str
    content: str
    score: float


class AgentChatResponse(BaseModel):
    answer: str
    sources: List[SourceItem]
    latency_ms: float


# ---------------------------------------------------------------------------
# POST /api/agent/chat
# ---------------------------------------------------------------------------

@router.post("/chat", response_model=AgentChatResponse)
async def agent_chat(request_body: AgentChatRequest, db: Session = Depends(get_db)):
    from api.routes.a2a import _run_agent_loop, _log_trace

    t_start = time.monotonic()
    trace_id = str(uuid.uuid4())
    query_preview = request_body.message[:120]

    # Create a UnifiedRun to track this agent chat session
    _ur_id: Optional[str] = None
    _chat_start = datetime.utcnow()
    try:
        from models_db import UnifiedRun as _UR
        _ur_id = str(uuid.uuid4())
        _ur = _UR(
            id=_ur_id,
            primary_domain="orchestration",
            run_type="agent_session",
            initiated_by="user",
            status="running",
            started_at=_chat_start,
            source_table="agent_sessions",
            summary_json=json.dumps({"message_preview": request_body.message[:100]}),
        )
        db.add(_ur)
        db.commit()
    except Exception:
        _ur_id = None

    _log_trace(trace_id,
               event_type="inbound_call",
               direction="inbound",
               connection_type="agent",
               run_id=_ur_id,
               summary=f"UI agent chat: {query_preview}",
               details={"source": "ui", "query_preview": query_preview})

    # Build messages: conversation history + current question (no system prompt —
    # _run_agent_loop prepends it internally)
    messages = [
        {"role": turn.role, "content": turn.content}
        for turn in request_body.history
    ]
    messages.append({"role": "user", "content": request_body.message})

    answer = ""
    try:
        answer = await _run_agent_loop(messages, trace_id=trace_id, run_id=_ur_id)
    except Exception as exc:
        logger.error("Agent generation failed: %s", exc, exc_info=True)
        answer = f"Sorry, I encountered an error: {exc}"

    latency_ms = round((time.monotonic() - t_start) * 1000, 1)

    _log_trace(trace_id,
               event_type="outbound_response",
               direction="outbound",
               connection_type="agent",
               run_id=_ur_id,
               summary=f"UI agent response ({latency_ms:.0f} ms): {answer[:120]}",
               details={"source": "ui", "latency_ms": latency_ms, "answer_preview": answer[:200]})

    # Finalize UnifiedRun and emit RunEvents
    if _ur_id:
        try:
            from models_db import UnifiedRun as _UR2, RunEvent as _RE
            _fin_row = db.query(_UR2).filter(_UR2.id == _ur_id).first()
            if _fin_row:
                _fin_row.status = "completed"
                _fin_row.ended_at = datetime.utcnow()
                _fin_row.summary_json = json.dumps({
                    "latency_ms": latency_ms,
                    "answer_preview": answer[:200],
                })
            db.add(_RE(
                id=str(uuid.uuid4()),
                run_id=_ur_id,
                event_type="started",
                category="execution",
                severity="info",
                timestamp=_chat_start,
                summary=f"Agent message: {request_body.message[:100]}",
                source="agent",
            ))
            db.add(_RE(
                id=str(uuid.uuid4()),
                run_id=_ur_id,
                event_type="completed",
                category="execution",
                severity="info",
                timestamp=datetime.utcnow(),
                summary=f"Responded in {latency_ms:.0f}ms",
                source="agent",
            ))
            db.commit()
        except Exception:
            pass

    return AgentChatResponse(answer=answer, sources=[], latency_ms=latency_ms)


# ---------------------------------------------------------------------------
# GET /api/agent/history  —  load persisted conversation
# PUT /api/agent/history  —  save conversation
# DELETE /api/agent/history  —  clear conversation
# ---------------------------------------------------------------------------

@router.get("/history")
def get_history(db: Session = Depends(get_db)):
    from models_db import AppState
    row = db.query(AppState).filter(AppState.key == _HISTORY_KEY).first()
    if row is None:
        return []
    try:
        return json.loads(row.value)
    except Exception:
        return []


@router.put("/history", status_code=204)
def save_history(messages: List[ChatMessage], db: Session = Depends(get_db)):
    from models_db import AppState
    from datetime import datetime, timezone
    value = json.dumps([m.model_dump() for m in messages])
    row = db.query(AppState).filter(AppState.key == _HISTORY_KEY).first()
    if row is None:
        db.add(AppState(key=_HISTORY_KEY, value=value))
    else:
        row.value = value
        row.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
    db.commit()


@router.delete("/history", status_code=204)
def clear_history(db: Session = Depends(get_db)):
    from models_db import AppState
    db.query(AppState).filter(AppState.key == _HISTORY_KEY).delete()
    db.commit()


# ---------------------------------------------------------------------------
# POST /api/agent/reload-docs  —  force reload documentation cache
# ---------------------------------------------------------------------------

@router.post("/reload-docs", status_code=200)
def reload_docs():
    """Force a doc reload on the next request by resetting the mtime sentinel."""
    global _docs_mtime
    _docs_mtime = 0.0
    return {"status": "cache cleared"}


# ---------------------------------------------------------------------------
# Agent Sessions
# ---------------------------------------------------------------------------

class RenameSessionRequest(BaseModel):
    name: str


def _session_meta(s) -> dict:
    return {
        "id": s.id,
        "name": s.name,
        "created_at": s.created_at.isoformat(),
        "last_active": s.last_active.isoformat(),
        "message_count": s.message_count,
    }


@router.get("/sessions")
def list_sessions(db: Session = Depends(get_db)):
    """Return all agent sessions, newest-active first."""
    from models_db import AgentSession
    sessions = db.query(AgentSession).order_by(AgentSession.last_active.desc()).all()
    return [_session_meta(s) for s in sessions]


@router.post("/sessions", status_code=201)
def create_session(db: Session = Depends(get_db)):
    """Create a new empty session."""
    from models_db import AgentSession
    now = datetime.utcnow()
    name = f"Session {now.strftime('%b %d, %H:%M')}"
    s = AgentSession(
        id=str(uuid.uuid4()),
        name=name,
        created_at=now,
        last_active=now,
        message_count=0,
        messages_json="[]",
    )
    db.add(s)
    db.commit()
    return _session_meta(s)


@router.get("/sessions/{session_id}/messages")
def get_session_messages(session_id: str, db: Session = Depends(get_db)):
    """Return the messages for a session."""
    from models_db import AgentSession
    s = db.query(AgentSession).filter(AgentSession.id == session_id).first()
    if s is None:
        raise HTTPException(status_code=404, detail="Session not found.")
    try:
        return json.loads(s.messages_json)
    except Exception:
        return []


@router.put("/sessions/{session_id}/messages", status_code=204)
def save_session_messages(
    session_id: str,
    messages: List[ChatMessage],
    db: Session = Depends(get_db),
):
    """Overwrite the messages for a session and update last_active."""
    from models_db import AgentSession
    s = db.query(AgentSession).filter(AgentSession.id == session_id).first()
    if s is None:
        raise HTTPException(status_code=404, detail="Session not found.")
    s.messages_json = json.dumps([m.model_dump() for m in messages])
    s.message_count = len(messages)
    s.last_active = datetime.utcnow()
    db.commit()


@router.patch("/sessions/{session_id}")
def rename_session(
    session_id: str,
    body: RenameSessionRequest,
    db: Session = Depends(get_db),
):
    """Rename a session."""
    from models_db import AgentSession
    s = db.query(AgentSession).filter(AgentSession.id == session_id).first()
    if s is None:
        raise HTTPException(status_code=404, detail="Session not found.")
    s.name = body.name.strip() or s.name
    db.commit()
    return _session_meta(s)


@router.delete("/sessions/{session_id}", status_code=204)
def delete_session(session_id: str, db: Session = Depends(get_db)):
    """Delete a session and all its messages."""
    from models_db import AgentSession
    db.query(AgentSession).filter(AgentSession.id == session_id).delete()
    db.commit()
