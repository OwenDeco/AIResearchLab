"""
OS Debate Room — backend routes.

Sessions are stored separately from the standard Debate Room (key: os_debate_sessions).
OutSystems agents push turns to POST /api/os-debate/turn during a live debate.
"""
from __future__ import annotations

import json
import logging
import time
import uuid
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Dict, List, Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from api.deps import get_db

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/os-debate", tags=["OS Debate Room"])

_OS_START_DEBATE_URL = "https://harmonygroup-dev.outsystems.app/ONE2026/rest/OSAgent/StartDebate"

_SESSIONS_KEY = "os_debate_sessions"
_MAX_SESSIONS  = 50

# ---------------------------------------------------------------------------
# Fixed agent definitions
# These are the only agents that participate in an OS Debate.
# ---------------------------------------------------------------------------

class OSAgent(str, Enum):
    host       = "host"
    optimistic = "optimistic"
    critical   = "critical"


OS_AGENT_META: Dict[str, Dict[str, str]] = {
    OSAgent.host: {
        "id":   OSAgent.host,
        "name": "Host",
        "role": "Debate Moderator",
    },
    OSAgent.optimistic: {
        "id":   OSAgent.optimistic,
        "name": "Optimist",
        "role": "Optimistic Agent",
    },
    OSAgent.critical: {
        "id":   OSAgent.critical,
        "name": "Critic",
        "role": "Critical Agent",
    },
}

# ---------------------------------------------------------------------------
# Storage helpers
# ---------------------------------------------------------------------------

def _load_sessions(db: Session) -> List[Dict]:
    from models_db import AppState
    row = db.query(AppState).filter(AppState.key == _SESSIONS_KEY).first()
    if row is None:
        return []
    try:
        return json.loads(row.value) or []
    except Exception:
        return []


def _save_sessions(db: Session, sessions: List[Dict]) -> None:
    from models_db import AppState
    sessions = sessions[-_MAX_SESSIONS:]
    value = json.dumps(sessions)
    row = db.query(AppState).filter(AppState.key == _SESSIONS_KEY).first()
    if row is None:
        db.add(AppState(key=_SESSIONS_KEY, value=value))
    else:
        row.value = value
        row.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
    db.commit()


def _update_session(db: Session, session_id: str, updates: Dict) -> None:
    sessions = _load_sessions(db)
    for s in sessions:
        if s["id"] == session_id:
            s.update(updates)
            break
    _save_sessions(db, sessions)


def _derive_host_turn_type(existing_host_turns: int, rounds: int) -> str:
    """Determine the turn type for the host based on how many host turns already exist."""
    if existing_host_turns == 0:
        return "open"
    if existing_host_turns >= rounds:
        return "close"
    return "moderate"


# ---------------------------------------------------------------------------
# Request / Response schemas
# ---------------------------------------------------------------------------

class OSStartExternalRequest(BaseModel):
    rounds: int   = Field(..., ge=1, le=5, description="Number of debate rounds (1–5).")
    Question: str = Field(..., min_length=1, description="The debate question or topic.")


class OSStartExternalResponse(BaseModel):
    session_id:  str  = Field(..., description="UUID of the newly created local debate session.")
    os_triggered: bool = Field(..., description="Whether OutSystems confirmed the flow was started.")


class OSTurnRequest(BaseModel):
    session_id: str     = Field(
        ...,
        description="The session ID returned by /start-external. Identifies which debate this turn belongs to.",
        example="3fa85f64-5717-4562-b3fc-2c963f66afa6",
    )
    agent: OSAgent      = Field(
        ...,
        description=(
            "Which agent is submitting this turn. "
            "Must be one of the three fixed debate participants: "
            "**host** (moderator), **optimistic** (pro-side agent), **critical** (contra-side agent)."
        ),
        example=OSAgent.optimistic,
    )
    content: str        = Field(
        ...,
        min_length=1,
        description="The agent's response text for this turn.",
        example="I believe AI will create far more jobs than it displaces, "
                "driving unprecedented economic growth.",
    )


class OSTurnResponse(BaseModel):
    ok:      bool = Field(..., description="True when the turn was stored successfully.")
    turn_id: str  = Field(..., description="UUID assigned to this turn.")


class OSCompleteResponse(BaseModel):
    ok: bool = Field(..., description="True when the session was marked completed.")


class OSStopResponse(BaseModel):
    ok: bool = Field(..., description="True when the session was force-stopped.")


# ---------------------------------------------------------------------------
# Seeded lab agent — OS Critical Debate Agent
# ---------------------------------------------------------------------------

_OS_CRITICAL_AGENT_NAME = "OS Critical Debate Agent"

_OS_CRITICAL_SYSTEM_PROMPT = (
    "You are a critical debate participant. Your role is to champion skepticism and scrutiny. "
    "Argue against overoptimistic assumptions, highlight realistic risks and downsides, "
    "and challenge the Optimist's claims with grounded counterarguments. "
    "Keep your responses focused, constructive, and concise — 2–3 sentences per turn. "
    "Your response must never exceed 400 characters."
)


def seed_optimistic_agent(db: Session) -> str:
    """Create or update the OS Critical Debate Agent config. Returns its ID."""
    from api.routes.agent_configs import _load_configs, _save_configs
    configs = _load_configs(db)
    existing = next((c for c in configs if c.get("name") == _OS_CRITICAL_AGENT_NAME), None)
    if existing:
        if existing.get("system_prompt") != _OS_CRITICAL_SYSTEM_PROMPT:
            existing["system_prompt"] = _OS_CRITICAL_SYSTEM_PROMPT
            existing["updated_at"] = datetime.now(timezone.utc).replace(tzinfo=None).isoformat()
            _save_configs(db, configs)
            logger.info("Updated system prompt for '%s'", _OS_CRITICAL_AGENT_NAME)
        return existing["id"]

    now = datetime.now(timezone.utc).replace(tzinfo=None).isoformat()
    agent_id = str(uuid.uuid4())
    configs.append({
        "id":            agent_id,
        "name":          _OS_CRITICAL_AGENT_NAME,
        "role":          "Critical Debate Guest",
        "system_prompt": _OS_CRITICAL_SYSTEM_PROMPT,
        "tools": {
            "mcp_connection_ids": [],
            "a2a_connection_ids": [],
            "agent_ids":          [],
            "use_own_a2a":        False,
        },
        "rag": {
            "enabled":        False,
            "retrieval_mode": "hybrid",
            "model_name":     "",
            "embed_model":    "",
            "top_k":          5,
        },
        "created_at": now,
        "updated_at": now,
    })
    _save_configs(db, configs)
    logger.info("Seeded '%s' agent config (id: %s)", _OS_CRITICAL_AGENT_NAME, agent_id)
    return agent_id


# ---------------------------------------------------------------------------
# Session CRUD endpoints
# ---------------------------------------------------------------------------

@router.get(
    "",
    summary="List OS debate sessions",
    description="Returns all OS Debate Room sessions, most recent first.",
)
def list_os_debates(db: Session = Depends(get_db)):
    return list(reversed(_load_sessions(db)))


@router.get(
    "/{session_id}",
    summary="Get an OS debate session",
    description="Fetch a single session by ID, including all turns received so far.",
)
def get_os_debate(session_id: str, db: Session = Depends(get_db)):
    session = next((s for s in _load_sessions(db) if s["id"] == session_id), None)
    if session is None:
        raise HTTPException(status_code=404, detail="OS Debate session not found")
    return session


# ---------------------------------------------------------------------------
# Start — creates a local session then triggers OutSystems
# ---------------------------------------------------------------------------

@router.post(
    "/start-external",
    response_model=OSStartExternalResponse,
    summary="Start an OS debate",
    description=(
        "Creates a local debate session (with a unique `session_id`), then triggers the "
        "OutSystems debate flow by calling `POST /OSAgent/StartDebate` with the question, "
        "rounds, and the generated `session_id`. "
        "OutSystems agents should use the returned `session_id` when pushing turns back via "
        "`POST /api/os-debate/turn`."
    ),
)
async def start_os_debate_external(
    body: OSStartExternalRequest,
    db: Session = Depends(get_db),
):
    # Create a local session pre-populated with the fixed agent structure
    session_id = str(uuid.uuid4())
    session: Dict[str, Any] = {
        "id":         session_id,
        "status":     "running",
        "host_id":    OSAgent.host,
        "guest_ids":  [OSAgent.optimistic, OSAgent.critical],
        "topic":      body.Question,
        "rounds":     body.rounds,
        "turns":      [],
        "started_at": datetime.now(timezone.utc).replace(tzinfo=None).isoformat(),
        "ended_at":   None,
        "source":     "outsystems",
    }
    sessions = _load_sessions(db)
    sessions.append(session)
    _save_sessions(db, sessions)

    # Call OutSystems — pass session_id so agents know where to push turns
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                _OS_START_DEBATE_URL,
                json={"rounds": body.rounds, "Question": body.Question, "session_id": session_id},
                headers={"Content-Type": "application/json"},
            )
        resp.raise_for_status()
        os_triggered = resp.text.strip().lower() == "true"
    except httpx.HTTPStatusError as exc:
        _update_session(db, session_id, {"status": "failed"})
        raise HTTPException(status_code=exc.response.status_code, detail=str(exc))
    except httpx.RequestError as exc:
        _update_session(db, session_id, {"status": "failed"})
        raise HTTPException(status_code=502, detail=f"OutSystems unreachable: {exc}")

    if not os_triggered:
        _update_session(db, session_id, {"status": "failed"})

    return OSStartExternalResponse(session_id=session_id, os_triggered=os_triggered)


# ---------------------------------------------------------------------------
# Turn push — called by OutSystems agents during the debate
# ---------------------------------------------------------------------------

@router.post(
    "/turn",
    response_model=OSTurnResponse,
    summary="Push a debate turn",
    description=(
        "Called by an OutSystems agent to submit its response during an ongoing debate. "
        "Supply the `session_id` from `/start-external`, the fixed `agent` identifier, "
        "and the agent's `content`. "
        "\n\n"
        "**Fixed agents:**\n"
        "| Value | Name | Role |\n"
        "|---|---|---|\n"
        "| `host` | Host | Debate Moderator — opens, moderates between rounds, and closes |\n"
        "| `optimistic` | Optimist | Pro-side agent |\n"
        "| `critical` | Critic | Contra-side agent |\n"
        "\n\n"
        "The `turn_type` is derived automatically from the agent role and turn order: "
        "`open` (first host turn), `speak` (guest turns), `moderate` (host between rounds), "
        "`close` (final host turn). "
        "The session is automatically marked **completed** when the closing host turn is received."
    ),
    responses={
        200: {"description": "Turn stored successfully."},
        404: {"description": "Session not found."},
        422: {"description": "Validation error — check agent value and session_id format."},
    },
)
def push_os_turn(body: OSTurnRequest, request: Request, db: Session = Depends(get_db)):
    from api.conn_log import log_conn_event

    sessions = _load_sessions(db)
    session  = next((s for s in sessions if s["id"] == body.session_id), None)
    if session is None:
        raise HTTPException(status_code=404, detail=f"Session '{body.session_id}' not found.")

    meta = OS_AGENT_META[body.agent]

    # Derive turn_type from role and position
    if body.agent == OSAgent.host:
        existing_host = sum(1 for t in session["turns"] if t["agent_id"] == OSAgent.host)
        turn_type = _derive_host_turn_type(existing_host, session["rounds"])
    else:
        turn_type = "speak"

    turn_id = str(uuid.uuid4())
    turn = {
        "id":         turn_id,
        "agent_id":   meta["id"],
        "agent_name": meta["name"],
        "role":       meta["role"],
        "content":    body.content,
        "turn_type":  turn_type,
        "timestamp":  datetime.now(timezone.utc).replace(tzinfo=None).isoformat(),
    }
    session["turns"].append(turn)

    # Auto-complete on closing host turn
    if turn_type == "close":
        session["status"]   = "completed"
        session["ended_at"] = datetime.now(timezone.utc).replace(tzinfo=None).isoformat()

    _save_sessions(db, sessions)

    caller_ip = request.client.host if request.client else "unknown"
    try:
        log_conn_event(
            db,
            event_type="turn_received",
            direction="inbound",
            connection_type=None,
            connection_name=f"OS Debate Turn ({body.agent})",
            caller=caller_ip,
            summary=f"Turn from {body.agent} on session {body.session_id[:8]}…: {body.content[:80]}",
            trace_id=body.session_id,
        )
    except Exception as exc:
        logger.warning("OS Debate turn log failed: %s", exc)

    return OSTurnResponse(ok=True, turn_id=turn_id)


# ---------------------------------------------------------------------------
# Complete — explicit completion signal from OutSystems
# ---------------------------------------------------------------------------

@router.post(
    "/{session_id}/complete",
    response_model=OSCompleteResponse,
    summary="Mark debate session as completed",
    description=(
        "Explicitly marks an OS debate session as completed. "
        "This is called automatically when a `close` turn is pushed, but can also be "
        "called directly by the OutSystems flow when all turns have been submitted."
    ),
)
def complete_os_debate_session(session_id: str, db: Session = Depends(get_db)):
    if not any(s["id"] == session_id for s in _load_sessions(db)):
        raise HTTPException(status_code=404, detail="Session not found")
    _update_session(db, session_id, {
        "status":   "completed",
        "ended_at": datetime.now(timezone.utc).replace(tzinfo=None).isoformat(),
    })
    return OSCompleteResponse(ok=True)


@router.post(
    "/{session_id}/stop",
    response_model=OSStopResponse,
    summary="Force-stop a running debate session",
    description=(
        "Immediately halts a running OS debate session. "
        "Sets status to `stopped` and records `ended_at`. "
        "Returns 409 if the session is already finished."
    ),
    responses={
        200: {"description": "Session stopped."},
        404: {"description": "Session not found."},
        409: {"description": "Session is not currently running."},
    },
)
def stop_os_debate_session(session_id: str, db: Session = Depends(get_db)):
    sessions = _load_sessions(db)
    session = next((s for s in sessions if s["id"] == session_id), None)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    if session["status"] != "running":
        raise HTTPException(status_code=409, detail=f"Session is already '{session['status']}'")
    _update_session(db, session_id, {
        "status":   "stopped",
        "ended_at": datetime.now(timezone.utc).replace(tzinfo=None).isoformat(),
    })
    return OSStopResponse(ok=True)


# ---------------------------------------------------------------------------
# A2A — OS Optimistic Debate Agent
# ---------------------------------------------------------------------------

def _os_a2a_agent_card() -> Dict[str, Any]:
    from api.routes.connections import get_effective_base_url
    base = get_effective_base_url().rstrip("/")
    return {
        "name": "OS Critical Debate Agent",
        "description": (
            "Participates in the OS Debate Room as the critical agent. "
            "Pass a session_id and the agent reads the live debate conversation, "
            "generates a critical counterargument, saves it as a 'critical' turn in the lab, "
            "and returns the answer."
        ),
        "url": f"{base}/api/os-debate/a2a",
        "version": "1.0.0",
        "capabilities": {
            "streaming": False,
            "pushNotifications": False,
            "stateTransitionHistory": False,
            "methods": ["tasks/send"],
        },
        "authentication": {"schemes": ["None"]},
        "defaultInputModes": ["text/plain"],
        "defaultOutputModes": ["text/plain"],
        "skills": [
            {
                "id": "respond-to-debate",
                "name": "Respond to Debate Session (Critical)",
                "description": (
                    "Given a session_id, reads the current OS debate conversation "
                    "and generates a critical counterargument. The response is automatically "
                    "saved as a 'critical' turn in the lab debate room."
                ),
                "tags": ["debate", "critical", "os-debate"],
                "inputModes": ["text/plain"],
                "outputModes": ["text/plain"],
                "examples": ["3fa85f64-5717-4562-b3fc-2c963f66afa6"],
            }
        ],
    }


@router.get(
    "/a2a/agent.json",
    summary="OS Optimistic Debate Agent — A2A Agent Card",
    description=(
        "Returns the A2A agent card for the OS Optimistic Debate Agent. "
        "Register this URL as an A2A connection in OutSystems to discover the agent's skill. "
        "The agent card points to `POST /api/os-debate/a2a` as the task endpoint."
    ),
)
def os_debate_a2a_agent_card():
    from fastapi.responses import JSONResponse
    return JSONResponse(
        content=_os_a2a_agent_card(),
        headers={"ngrok-skip-browser-warning": "true"},
    )


def _a2a_ok(rpc_id: Any, task_id: str, answer: str) -> Dict:
    return {
        "jsonrpc": "2.0",
        "id": rpc_id,
        "result": {
            "id": task_id,
            "contextId": task_id,
            "status": {"state": "completed"},
            "artifacts": [{
                "artifactId": str(uuid.uuid4()),
                "parts": [{"type": "text", "text": answer}],
                "index": 0,
                "lastChunk": True,
            }],
        },
    }


def _a2a_err(rpc_id: Any, code: int, message: str) -> Dict:
    return {"jsonrpc": "2.0", "id": rpc_id, "error": {"code": code, "message": message}}


def _extract_session_id(text: str) -> Optional[str]:
    import re as _re
    m = _re.search(
        r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
        text, _re.I,
    )
    return m.group(0) if m else None


def _build_debate_context(session: Dict) -> str:
    lines = [f'Debate topic: "{session["topic"]}"', ""]
    turns = session.get("turns", [])
    if turns:
        lines.append("Conversation so far:")
        for t in turns:
            lines.append(f"{t['agent_name']}: {t['content']}")
        lines.append("")
    lines.append(
        "You are the Critic (Critical Agent). Based on the conversation above, "
        "give your critical response. Challenge optimistic arguments with grounded counterpoints. "
        "Keep it to 2–3 sentences."
    )
    return "\n".join(lines)


def _os_a2a_card_response():
    from fastapi.responses import JSONResponse
    return JSONResponse(
        content=_os_a2a_agent_card(),
        headers={"ngrok-skip-browser-warning": "true"},
    )


@router.get("/a2a", summary="OS Optimistic Debate Agent — Agent Card (GET on task URL)")
def os_debate_a2a_get():
    """OutSystems first tries GET on the task URL itself — return the card here."""
    return _os_a2a_card_response()


@router.get("/a2a/.well-known/agent.json", summary="OS Optimistic Debate Agent — Agent Card (well-known)")
def os_debate_a2a_well_known():
    """OutSystems fallback: tries {url}/.well-known/agent.json."""
    return _os_a2a_card_response()


@router.get("/a2a/.well-known/agent-card.json", summary="OS Optimistic Debate Agent — Agent Card (well-known alias)")
def os_debate_a2a_well_known_alias():
    """OutSystems fallback: tries {url}/.well-known/agent-card.json."""
    return _os_a2a_card_response()


@router.post(
    "/a2a",
    summary="OS Optimistic Debate Agent — A2A task endpoint",
    description=(
        "JSON-RPC 2.0 A2A endpoint for the OS Optimistic Debate Agent. "
        "Supports `tasks/send`. Pass the `session_id` UUID as the message text.\n\n"
        "The agent:\n"
        "1. Reads the current OS debate session's full turn history.\n"
        "2. Generates an optimistic response using the seeded agent config.\n"
        "3. Saves the response as an `optimistic` turn (visible live in the lab UI).\n"
        "4. Returns the response text as an A2A artifact.\n\n"
        "**Example request body:**\n"
        "```json\n"
        '{"jsonrpc":"2.0","method":"tasks/send","id":"1",'
        '"params":{"id":"task-uuid","message":{"role":"user",'
        '"parts":[{"type":"text","text":"<session_id>"}]}}}\n'
        "```"
    ),
)
async def os_debate_a2a_task(request: Request, db: Session = Depends(get_db)):
    from fastapi.responses import JSONResponse
    from api.routes.agent_configs import _load_configs, AgentConfigChatRequest, chat_with_agent
    from api.conn_log import log_conn_event

    caller_ip = request.client.host if request.client else "unknown"
    trace_id  = str(uuid.uuid4())

    def _log(event_type: str, direction: str, summary: str, **kw):
        try:
            log_conn_event(
                db,
                event_type=event_type,
                direction=direction,
                connection_type="a2a",
                connection_name="OS Optimistic Debate Agent",
                caller=caller_ip,
                summary=summary,
                trace_id=trace_id,
                **kw,
            )
        except Exception as exc:
            logger.warning("OS Debate A2A log failed: %s", exc)

    try:
        body = await request.json()
    except Exception:
        _log("inbound_call", "inbound", f"OS Debate A2A — parse error from {caller_ip}")
        return JSONResponse(
            status_code=400,
            content=_a2a_err(None, -32700, "Parse error: invalid JSON."),
        )

    rpc_id  = body.get("id")
    method  = body.get("method", "")
    params  = body.get("params", {})

    _log("inbound_call", "inbound",
         f"OS Debate A2A inbound [{method}] from {caller_ip}")

    if method not in ("tasks/send", "message/send"):
        _log("outbound_response", "outbound",
             f"OS Debate A2A rejected — unsupported method '{method}'")
        return JSONResponse(content=_a2a_err(
            rpc_id, -32601,
            f"Method '{method}' not supported. Use tasks/send.",
        ))

    task_id = params.get("id") or str(uuid.uuid4())
    message = params.get("message", {})

    # Extract text from message parts
    raw_text = ""
    for part in message.get("parts", []):
        if isinstance(part, dict):
            raw_text += part.get("text", "") if "text" in part else ""
    raw_text = raw_text.strip()

    if not raw_text:
        _log("outbound_response", "outbound",
             "OS Debate A2A rejected — empty message")
        return JSONResponse(content=_a2a_err(rpc_id, -32602, "Message text is empty."))

    session_id = _extract_session_id(raw_text)
    if not session_id:
        # Connection test from OutSystems (no UUID) — return a healthy response
        _log("outbound_response", "outbound",
             "OS Debate A2A connection test — agent ready")
        return JSONResponse(content=_a2a_ok(
            rpc_id, task_id,
            "OS Optimistic Debate Agent is ready. "
            "Send a debate session_id UUID to participate in a debate.",
        ))

    _log("inbound_call", "inbound",
         f"OS Debate A2A — session {session_id[:8]}… from {caller_ip}")

    # ── Load and validate session ─────────────────────────────────────────────
    sessions = _load_sessions(db)
    session  = next((s for s in sessions if s["id"] == session_id), None)
    if session is None:
        _log("outbound_response", "outbound",
             f"OS Debate A2A — session {session_id[:8]}… not found")
        return JSONResponse(content=_a2a_err(rpc_id, -32602, f"Session '{session_id}' not found."))
    if session["status"] != "running":
        _log("outbound_response", "outbound",
             f"OS Debate A2A — session {session_id[:8]}… is '{session['status']}', not running")
        return JSONResponse(content=_a2a_err(
            rpc_id, -32602,
            f"Session is '{session['status']}', not running.",
        ))

    # ── Resolve critical agent config ─────────────────────────────────────────
    agent_id = seed_optimistic_agent(db)
    configs  = _load_configs(db)
    cfg      = next((c for c in configs if c["id"] == agent_id), None)
    if cfg is None:
        _log("outbound_response", "outbound",
             "OS Debate A2A — critical agent config missing")
        return JSONResponse(content=_a2a_err(rpc_id, -32603, "Critical agent config not found."))

    # ── Generate response ─────────────────────────────────────────────────────
    context  = _build_debate_context(session)
    chat_req = AgentConfigChatRequest(message=context, history=[], initiated_by="os_debate")
    result   = await chat_with_agent(cfg["id"], chat_req, request, db)
    answer   = result["answer"]

    # ── Save as critical turn ─────────────────────────────────────────────────
    sessions = _load_sessions(db)
    session  = next((s for s in sessions if s["id"] == session_id), None)
    if session is not None and session["status"] == "running":
        meta = OS_AGENT_META[OSAgent.critical]
        session["turns"].append({
            "id":         str(uuid.uuid4()),
            "agent_id":   meta["id"],
            "agent_name": meta["name"],
            "role":       meta["role"],
            "content":    answer,
            "turn_type":  "speak",
            "timestamp":  datetime.now(timezone.utc).replace(tzinfo=None).isoformat(),
        })
        _save_sessions(db, sessions)

    _log("outbound_response", "outbound",
         f"OS Debate A2A (critic) — responded to session {session_id[:8]}…: {answer[:80]}")

    return JSONResponse(content=_a2a_ok(rpc_id, task_id, answer))
