"""
Debate orchestration: a host agent poses a topic, guest agents discuss in turns.
All LLM calls run in a background task; the frontend polls and typewriters each turn.
"""
from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from api.deps import get_db
from config import settings

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/debate", tags=["debate"])

_SESSIONS_KEY = "debate_sessions"
_MAX_SESSIONS = 50
_MAX_TURN_TOKENS = 90   # keeps balloon text concise


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


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

class DebateStartRequest(BaseModel):
    host_id: str
    guest_ids: List[str]
    topic: str
    rounds: int = 2


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.post("/start")
async def start_debate(
    body: DebateStartRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    from api.routes.agent_configs import _load_configs
    configs = _load_configs(db)

    host_cfg = next((c for c in configs if c["id"] == body.host_id), None)
    if host_cfg is None:
        raise HTTPException(status_code=404, detail="Host agent not found")

    guest_cfgs = [c for c in configs if c["id"] in body.guest_ids]
    if not guest_cfgs:
        raise HTTPException(status_code=400, detail="No valid guest agents found")

    rounds = max(1, min(body.rounds, 5))
    session_id = str(uuid.uuid4())
    session: Dict[str, Any] = {
        "id": session_id,
        "status": "running",
        "host_id": body.host_id,
        "guest_ids": body.guest_ids,
        "topic": body.topic,
        "rounds": rounds,
        "turns": [],
        "started_at": datetime.now(timezone.utc).replace(tzinfo=None).isoformat(),
        "ended_at": None,
    }

    sessions = _load_sessions(db)
    sessions.append(session)
    _save_sessions(db, sessions)

    background_tasks.add_task(
        _run_debate,
        session_id,
        body.host_id,
        body.guest_ids,
        body.topic,
        rounds,
    )

    return {"session_id": session_id}


@router.get("")
def list_debates(db: Session = Depends(get_db)):
    sessions = _load_sessions(db)
    return list(reversed(sessions))


@router.get("/{session_id}")
def get_debate(session_id: str, db: Session = Depends(get_db)):
    sessions = _load_sessions(db)
    session = next((s for s in sessions if s["id"] == session_id), None)
    if session is None:
        raise HTTPException(status_code=404, detail="Debate session not found")
    return session


# ---------------------------------------------------------------------------
# Background debate runner
# ---------------------------------------------------------------------------

async def _run_debate(
    session_id: str,
    host_id: str,
    guest_ids: List[str],
    topic: str,
    rounds: int,
) -> None:
    from api.routes.agent_configs import _load_configs
    from api.conn_log import log_conn_event
    from models.registry import get_llm
    from models_db import UnifiedRun, RunStep, RunEvent
    from database import SessionLocal

    db = SessionLocal()
    run_id = str(uuid.uuid4())
    t_debate_start = datetime.utcnow()

    try:
        configs = _load_configs(db)
        host_cfg = next((c for c in configs if c["id"] == host_id), None)
        guest_cfgs = [c for c in configs if c["id"] in guest_ids]

        if not host_cfg or not guest_cfgs:
            _update_session(db, session_id, {"status": "failed"})
            return

        guest_names = ", ".join(c["name"] for c in guest_cfgs)

        # ── Create UnifiedRun ────────────────────────────────────────────────
        db.add(UnifiedRun(
            id=run_id,
            primary_domain="orchestration",
            run_type="debate",
            initiated_by="user",
            status="running",
            started_at=t_debate_start,
            source_id=session_id,
            source_table="debate_sessions",
            summary_json=json.dumps({
                "topic": topic,
                "host": host_cfg["name"],
                "guests": guest_names,
                "rounds": rounds,
            }),
        ))
        db.add(RunEvent(
            id=str(uuid.uuid4()),
            run_id=run_id,
            event_type="started",
            category="execution",
            severity="info",
            timestamp=t_debate_start,
            summary=f'Debate started — "{topic}" | host: {host_cfg["name"]} | guests: {guest_names}',
            source="debate",
        ))
        db.commit()

        # store run_id in the session record so the frontend can link to it
        _update_session(db, session_id, {"run_id": run_id})

        log_conn_event(
            db,
            event_type="debate_started",
            direction="inbound",
            connection_type="agent",
            connection_name=host_cfg["name"],
            summary=f'Debate "{topic}" started ({rounds} round{"s" if rounds != 1 else ""})',
            trace_id=run_id,
            run_id=run_id,
            details={"topic": topic, "host": host_cfg["name"], "guests": guest_names, "rounds": rounds},
            write_run_event=False,
        )

        # ── Helpers ──────────────────────────────────────────────────────────

        conversation: List[Dict[str, str]] = []

        def _append_turn(cfg: Dict, content: str, turn_type: str) -> None:
            turn = {
                "id": str(uuid.uuid4()),
                "agent_id": cfg["id"],
                "agent_name": cfg["name"],
                "role": cfg.get("role", ""),
                "content": content,
                "turn_type": turn_type,
                "timestamp": datetime.now(timezone.utc).replace(tzinfo=None).isoformat(),
            }
            sessions = _load_sessions(db)
            for s in sessions:
                if s["id"] == session_id:
                    s["turns"].append(turn)
                    break
            _save_sessions(db, sessions)

        def _call_llm_tracked(cfg: Dict, messages: List[Dict], turn_type: str) -> str:
            model_name = (
                cfg.get("rag", {}).get("model_name")
                or settings.AGENT_MODEL
                or settings.DEFAULT_LLM
            )
            try:
                llm = get_llm(model_name)
            except Exception:
                llm = get_llm(settings.DEFAULT_LLM)

            t0 = datetime.utcnow()
            response = llm.complete(messages=messages, temperature=0.75, max_tokens=_MAX_TURN_TOKENS)
            t1 = datetime.utcnow()
            content = (response.content or "").strip()
            duration_ms = round((t1 - t0).total_seconds() * 1000, 1)

            # RunStep per LLM call
            step_id = str(uuid.uuid4())
            db.add(RunStep(
                id=step_id,
                run_id=run_id,
                domain="orchestration",
                step_type="llm_call",
                component=cfg["name"],
                started_at=t0,
                ended_at=t1,
                duration_ms=duration_ms,
                status="completed",
                input_summary=turn_type,
                output_summary=content[:120],
                metrics_json=json.dumps({
                    "prompt_tokens": response.prompt_tokens,
                    "completion_tokens": response.completion_tokens,
                    "duration_ms": duration_ms,
                }),
            ))
            db.add(RunEvent(
                id=str(uuid.uuid4()),
                run_id=run_id,
                step_id=step_id,
                event_type="llm_call",
                category="ai",
                severity="info",
                timestamp=t1,
                summary=f"[{cfg['name']}] {turn_type} — {content[:80]}",
                payload_json=json.dumps({
                    "agent": cfg["name"],
                    "turn_type": turn_type,
                    "duration_ms": duration_ms,
                    "prompt_tokens": response.prompt_tokens,
                    "completion_tokens": response.completion_tokens,
                }),
                source="debate",
            ))
            db.commit()

            log_conn_event(
                db,
                event_type="llm_call",
                direction="internal",
                connection_type="agent",
                connection_name=cfg["name"],
                summary=f"[{cfg['name']}] {turn_type}: {content[:80]}",
                trace_id=run_id,
                run_id=run_id,
                details={"turn_type": turn_type, "duration_ms": duration_ms},
                write_run_event=False,
            )

            return content

        def _context_block() -> str:
            recent = conversation[-8:]
            lines = [f'Debate topic: "{topic}"', ""]
            if recent:
                lines.append("Conversation so far:")
                for t in recent:
                    lines.append(f"{t['name']}: {t['content']}")
                lines.append("")
            return "\n".join(lines)

        host_sys = (
            host_cfg.get("system_prompt", "").strip()
            or f"You are a debate moderator named {host_cfg['name']}."
        )

        # Opening
        opening = _call_llm_tracked(host_cfg, [
            {"role": "system", "content": host_sys},
            {"role": "user", "content": (
                f'{_context_block()}Open this debate with a brief 2-sentence introduction '
                "and pose one sharp opening question. Be concise."
            )},
        ], "open")
        _append_turn(host_cfg, opening, "open")
        conversation.append({"name": host_cfg["name"], "content": opening})

        # Rounds
        for round_num in range(1, rounds + 1):
            for guest_cfg in guest_cfgs:
                guest_sys = (
                    guest_cfg.get("system_prompt", "").strip()
                    or f"You are a debate participant named {guest_cfg['name']}."
                )
                response = _call_llm_tracked(guest_cfg, [
                    {"role": "system", "content": guest_sys},
                    {"role": "user", "content": (
                        f"{_context_block()}Round {round_num} — your turn. "
                        "State your position directly in 2-3 sentences. Be concrete."
                    )},
                ], f"speak (round {round_num})")
                _append_turn(guest_cfg, response, "speak")
                conversation.append({"name": guest_cfg["name"], "content": response})

            if round_num < rounds:
                moderation = _call_llm_tracked(host_cfg, [
                    {"role": "system", "content": host_sys},
                    {"role": "user", "content": (
                        f"{_context_block()}Briefly acknowledge the main point (1 sentence) "
                        f"and pose a follow-up question for round {round_num + 1}."
                    )},
                ], f"moderate (after round {round_num})")
                _append_turn(host_cfg, moderation, "moderate")
                conversation.append({"name": host_cfg["name"], "content": moderation})

        # Closing
        closing = _call_llm_tracked(host_cfg, [
            {"role": "system", "content": host_sys},
            {"role": "user", "content": (
                f"{_context_block()}Close the debate. "
                "Summarise the key perspectives in 2 sentences."
            )},
        ], "close")
        _append_turn(host_cfg, closing, "close")

        ended_at = datetime.utcnow()
        total_ms = round((ended_at - t_debate_start).total_seconds() * 1000, 1)

        _update_session(db, session_id, {
            "status": "completed",
            "ended_at": datetime.now(timezone.utc).replace(tzinfo=None).isoformat(),
        })

        # Finish the UnifiedRun
        run_row = db.query(UnifiedRun).filter(UnifiedRun.id == run_id).first()
        if run_row:
            existing = json.loads(run_row.summary_json or "{}")
            existing["total_latency_ms"] = total_ms
            run_row.status = "completed"
            run_row.ended_at = ended_at
            run_row.summary_json = json.dumps(existing)
        db.add(RunEvent(
            id=str(uuid.uuid4()),
            run_id=run_id,
            event_type="completed",
            category="execution",
            severity="info",
            timestamp=ended_at,
            summary=f'Debate completed in {total_ms:.0f} ms — "{topic}"',
            source="debate",
        ))
        db.commit()

        log_conn_event(
            db,
            event_type="debate_completed",
            direction="outbound",
            connection_type="agent",
            connection_name=host_cfg["name"],
            summary=f'Debate "{topic}" completed in {total_ms:.0f} ms',
            trace_id=run_id,
            run_id=run_id,
            details={"total_latency_ms": total_ms, "topic": topic},
            write_run_event=False,
        )

    except Exception as exc:
        logger.error("Debate run %s failed: %s", session_id, exc, exc_info=True)
        try:
            _update_session(db, session_id, {"status": "failed"})
            ended_at = datetime.utcnow()
            run_row = db.query(UnifiedRun).filter(UnifiedRun.id == run_id).first()
            if run_row:
                run_row.status = "failed"
                run_row.ended_at = ended_at
            db.add(RunEvent(
                id=str(uuid.uuid4()),
                run_id=run_id,
                event_type="failed",
                category="execution",
                severity="error",
                timestamp=ended_at,
                summary=f"Debate failed: {exc}",
                source="debate",
            ))
            db.commit()
            log_conn_event(
                db,
                event_type="debate_failed",
                direction="outbound",
                connection_type="agent",
                connection_name="",
                summary=f'Debate "{topic}" failed: {exc}',
                trace_id=run_id,
                run_id=run_id,
                details={"error": str(exc)},
                write_run_event=False,
            )
        except Exception:
            pass
    finally:
        db.close()
