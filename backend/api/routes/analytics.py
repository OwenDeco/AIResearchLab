from __future__ import annotations

import json
import logging
import uuid
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any, List

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from api.deps import get_db
from models_db import AgentSession, AppState, BenchmarkRun, ConnectionLog, Document, Run, UnifiedRun
from observability.tracker import _estimate_cost

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/analytics", tags=["analytics"])

_SYSTEM_COSTS_KEY = "system_costs"


# ---------------------------------------------------------------------------
# System costs helpers
# ---------------------------------------------------------------------------

def _load_system_costs(db: Session) -> list:
    row = db.query(AppState).filter(AppState.key == _SYSTEM_COSTS_KEY).first()
    if row is None:
        return []
    try:
        return json.loads(row.value)
    except Exception:
        return []


def _save_system_costs(db: Session, entries: list) -> None:
    from datetime import datetime, timezone
    value = json.dumps(entries)
    row = db.query(AppState).filter(AppState.key == _SYSTEM_COSTS_KEY).first()
    if row is None:
        db.add(AppState(key=_SYSTEM_COSTS_KEY, value=value))
    else:
        row.value = value
        row.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
    db.commit()


class SystemCostEntry(BaseModel):
    date: str           # YYYY-MM-DD
    description: str
    model: str = "claude-sonnet-4-6"
    prompt_tokens: int = 0
    completion_tokens: int = 0
    cost_usd: float = 0.0

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

ERROR_KEYWORDS = ("error", "failed", "exception", "timeout", "refused", "unauthorized")


def _is_error(summary: str) -> bool:
    s = (summary or "").lower()
    return any(kw in s for kw in ERROR_KEYWORDS)


def _date_str(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%d")


def _percentile(sorted_values: list[float], p: float) -> float:
    if not sorted_values:
        return 0.0
    idx = int(len(sorted_values) * p / 100)
    idx = min(idx, len(sorted_values) - 1)
    return sorted_values[idx]


# ---------------------------------------------------------------------------
# GET /api/analytics/summary
# ---------------------------------------------------------------------------

@router.get("/summary")
def analytics_summary(db: Session = Depends(get_db)) -> dict[str, Any]:
    now = datetime.now(tz=timezone.utc)
    cutoff_24h = now - timedelta(hours=24)

    # -----------------------------------------------------------------------
    # RUNS
    # -----------------------------------------------------------------------
    all_runs = db.query(Run).order_by(Run.created_at.asc()).all()

    # by_day
    day_map: dict[str, dict] = {}
    for r in all_runs:
        d = _date_str(r.created_at)
        if d not in day_map:
            day_map[d] = {"date": d, "count": 0, "latencies": [], "total_cost_usd": 0.0,
                          "total_prompt_tokens": 0, "total_completion_tokens": 0}
        day_map[d]["count"] += 1
        day_map[d]["latencies"].append(r.latency_ms or 0.0)
        day_map[d]["total_cost_usd"] += r.estimated_cost_usd or 0.0
        day_map[d]["total_prompt_tokens"] += r.prompt_tokens or 0
        day_map[d]["total_completion_tokens"] += r.completion_tokens or 0

    runs_by_day = [
        {
            "date": v["date"],
            "count": v["count"],
            "avg_latency_ms": round(sum(v["latencies"]) / len(v["latencies"]), 1) if v["latencies"] else 0.0,
            "total_cost_usd": round(v["total_cost_usd"], 6),
            "total_prompt_tokens": v["total_prompt_tokens"],
            "total_completion_tokens": v["total_completion_tokens"],
        }
        for v in sorted(day_map.values(), key=lambda x: x["date"])
    ]

    # by_mode
    mode_map: dict[str, dict] = {}
    for r in all_runs:
        m = r.retrieval_mode or "unknown"
        if m not in mode_map:
            mode_map[m] = {"mode": m, "count": 0, "latencies": [], "costs": [], "chunks": []}
        mode_map[m]["count"] += 1
        mode_map[m]["latencies"].append(r.latency_ms or 0.0)
        mode_map[m]["costs"].append(r.estimated_cost_usd or 0.0)
        mode_map[m]["chunks"].append(r.chunk_count or 0)

    runs_by_mode = [
        {
            "mode": v["mode"],
            "count": v["count"],
            "avg_latency_ms": round(sum(v["latencies"]) / len(v["latencies"]), 1) if v["latencies"] else 0.0,
            "avg_cost_usd": round(sum(v["costs"]) / len(v["costs"]), 6) if v["costs"] else 0.0,
            "avg_chunks": round(sum(v["chunks"]) / len(v["chunks"]), 1) if v["chunks"] else 0.0,
        }
        for v in mode_map.values()
    ]

    # by_model
    model_map: dict[str, dict] = {}
    for r in all_runs:
        mn = r.model_name or "unknown"
        if mn not in model_map:
            model_map[mn] = {"model": mn, "count": 0, "total_prompt_tokens": 0,
                             "total_completion_tokens": 0, "total_cost_usd": 0.0}
        model_map[mn]["count"] += 1
        model_map[mn]["total_prompt_tokens"] += r.prompt_tokens or 0
        model_map[mn]["total_completion_tokens"] += r.completion_tokens or 0
        model_map[mn]["total_cost_usd"] += r.estimated_cost_usd or 0.0

    runs_by_model = [
        {**v, "total_cost_usd": round(v["total_cost_usd"], 6)}
        for v in model_map.values()
    ]

    # latency percentiles
    all_latencies = sorted(r.latency_ms or 0.0 for r in all_runs)
    latency_percentiles = {
        "p50": round(_percentile(all_latencies, 50), 1),
        "p90": round(_percentile(all_latencies, 90), 1),
        "p99": round(_percentile(all_latencies, 99), 1),
    }

    # -----------------------------------------------------------------------
    # CONNECTIONS
    # -----------------------------------------------------------------------
    all_logs = db.query(ConnectionLog).order_by(ConnectionLog.timestamp.asc()).all()

    total_events = len(all_logs)
    inbound_calls = sum(1 for l in all_logs if l.direction == "inbound")
    outbound_calls = sum(1 for l in all_logs if l.direction == "outbound")
    internal_events = sum(1 for l in all_logs if l.direction == "internal")

    # by_connection
    conn_map: dict[str, dict] = {}
    for l in all_logs:
        key = l.connection_name or "(none)"
        if key not in conn_map:
            conn_map[key] = {"name": key, "type": l.connection_type or "", "inbound": 0,
                             "outbound": 0, "errors": 0}
        if l.direction == "inbound":
            conn_map[key]["inbound"] += 1
        elif l.direction == "outbound":
            conn_map[key]["outbound"] += 1
        if _is_error(l.summary):
            conn_map[key]["errors"] += 1

    by_connection = list(conn_map.values())

    # by_event_type
    etype_map: dict[str, int] = defaultdict(int)
    for l in all_logs:
        etype_map[l.event_type or "unknown"] += 1
    by_event_type = sorted(
        [{"event_type": k, "count": v} for k, v in etype_map.items()],
        key=lambda x: x["count"],
        reverse=True,
    )

    # errors_by_day
    log_day_map: dict[str, dict] = {}
    for l in all_logs:
        d = _date_str(l.timestamp)
        if d not in log_day_map:
            log_day_map[d] = {"date": d, "errors": 0, "total": 0}
        log_day_map[d]["total"] += 1
        if _is_error(l.summary):
            log_day_map[d]["errors"] += 1

    errors_by_day = sorted(log_day_map.values(), key=lambda x: x["date"])

    # -----------------------------------------------------------------------
    # AGENT / TOOL-CALL TOKENS  (from connection_logs llm_tool_selection entries)
    # -----------------------------------------------------------------------
    token_event_types = {"llm_tool_selection", "tool_chosen"}
    agent_token_day_map: dict[str, dict] = {}
    agent_token_model_map: dict[str, dict] = {}

    for l in all_logs:
        if l.event_type not in token_event_types or not l.details_json:
            continue
        try:
            det = json.loads(l.details_json)
            pt = int(det.get("prompt_tokens") or 0)
            ct = int(det.get("completion_tokens") or 0)
            model = det.get("model") or "unknown"
        except Exception:
            continue
        if not pt and not ct:
            continue
        cost = _estimate_cost(pt, ct, model)
        day = _date_str(l.timestamp)
        if day not in agent_token_day_map:
            agent_token_day_map[day] = {"date": day, "prompt_tokens": 0, "completion_tokens": 0, "cost_usd": 0.0}
        agent_token_day_map[day]["prompt_tokens"] += pt
        agent_token_day_map[day]["completion_tokens"] += ct
        agent_token_day_map[day]["cost_usd"] += cost
        if model not in agent_token_model_map:
            agent_token_model_map[model] = {"model": model, "prompt_tokens": 0, "completion_tokens": 0, "cost_usd": 0.0}
        agent_token_model_map[model]["prompt_tokens"] += pt
        agent_token_model_map[model]["completion_tokens"] += ct
        agent_token_model_map[model]["cost_usd"] += cost

    agent_tokens_by_day = [
        {**v, "cost_usd": round(v["cost_usd"], 6)}
        for v in sorted(agent_token_day_map.values(), key=lambda x: x["date"])
    ]
    agent_tokens_by_model = [
        {**v, "cost_usd": round(v["cost_usd"], 6)}
        for v in agent_token_model_map.values()
    ]

    # -----------------------------------------------------------------------
    # SYSTEM COSTS (manual entries: Claude Code CLI, etc.)
    # -----------------------------------------------------------------------
    system_cost_entries = _load_system_costs(db)
    system_costs_by_day: dict[str, dict] = {}
    for e in system_cost_entries:
        d = e.get("date", "")
        if d not in system_costs_by_day:
            system_costs_by_day[d] = {"date": d, "cost_usd": 0.0, "prompt_tokens": 0, "completion_tokens": 0}
        system_costs_by_day[d]["cost_usd"] += e.get("cost_usd", 0.0)
        system_costs_by_day[d]["prompt_tokens"] += e.get("prompt_tokens", 0)
        system_costs_by_day[d]["completion_tokens"] += e.get("completion_tokens", 0)
    system_costs_by_day_list = sorted(system_costs_by_day.values(), key=lambda x: x["date"])
    total_system_cost = round(sum(e.get("cost_usd", 0.0) for e in system_cost_entries), 6)

    # agent_calls_by_day — inbound_call = UI call (direction inbound, connection_type agent)
    # a2a_calls = inbound_call with connection_type a2a
    acall_day_map: dict[str, dict] = {}
    for l in all_logs:
        if l.event_type not in ("inbound_call", "outbound_response"):
            continue
        if l.event_type != "inbound_call":
            continue
        d = _date_str(l.timestamp)
        if d not in acall_day_map:
            acall_day_map[d] = {"date": d, "ui_calls": 0, "a2a_calls": 0}
        if l.connection_type == "a2a":
            acall_day_map[d]["a2a_calls"] += 1
        else:
            acall_day_map[d]["ui_calls"] += 1

    agent_calls_by_day = sorted(acall_day_map.values(), key=lambda x: x["date"])

    # -----------------------------------------------------------------------
    # UNIFIED RUNS
    # -----------------------------------------------------------------------
    total_ur = db.query(UnifiedRun).count()
    ur_by_domain = {
        d: db.query(UnifiedRun).filter(UnifiedRun.primary_domain == d).count()
        for d in ["orchestration", "evaluation", "interoperability", "context_engineering", "governance"]
    }
    ur_by_type = dict(
        db.query(UnifiedRun.run_type, func.count(UnifiedRun.id))
        .group_by(UnifiedRun.run_type)
        .all()
    )

    # -----------------------------------------------------------------------
    # PLATFORM
    # -----------------------------------------------------------------------
    all_docs = db.query(Document).order_by(Document.created_at.asc()).all()
    all_benchmarks = db.query(BenchmarkRun).all()
    all_sessions = db.query(AgentSession).all()

    documents_ingested = len(all_docs)
    total_chunks = sum(d.chunk_count or 0 for d in all_docs)
    benchmark_runs_count = len(all_benchmarks)
    agent_sessions_count = len(all_sessions)
    agent_messages_total = sum(s.message_count or 0 for s in all_sessions)

    # documents_by_day
    doc_day_map: dict[str, dict] = {}
    for d in all_docs:
        day = _date_str(d.created_at)
        if day not in doc_day_map:
            doc_day_map[day] = {"date": day, "count": 0, "chunks": 0}
        doc_day_map[day]["count"] += 1
        doc_day_map[day]["chunks"] += d.chunk_count or 0

    documents_by_day = sorted(doc_day_map.values(), key=lambda x: x["date"])

    # system_events — ngrok, registered, deleted events
    system_event_types = {"ngrok_start", "ngrok_stop", "registered", "deleted", "tested"}
    system_events = [
        {
            "timestamp": l.timestamp.isoformat(),
            "event_type": l.event_type,
            "summary": l.summary,
        }
        for l in sorted(all_logs, key=lambda x: x.timestamp, reverse=True)
        if l.event_type in system_event_types
    ][:50]

    # risk_signals
    risk_signals: list[dict] = []
    recent_logs = [l for l in all_logs if l.timestamp >= cutoff_24h.replace(tzinfo=None)]

    # MCP tool errors
    mcp_errors = [l for l in recent_logs if l.event_type == "mcp_tool_call" and _is_error(l.summary)]
    if mcp_errors:
        risk_signals.append({"level": "error", "signal": "MCP tool call errors", "count": len(mcp_errors), "since": "24h"})

    # A2A tool errors
    a2a_errors = [l for l in recent_logs if l.event_type == "a2a_tool_call" and _is_error(l.summary)]
    if a2a_errors:
        risk_signals.append({"level": "error", "signal": "A2A tool call errors", "count": len(a2a_errors), "since": "24h"})

    # High latency
    if latency_percentiles["p90"] > 10000:
        risk_signals.append({"level": "warning", "signal": "High latency (p90 > 10s)", "count": 1, "since": "all time"})

    # Ngrok tunnel down
    ngrok_stops = [l for l in recent_logs if l.event_type == "ngrok_stop"]
    if ngrok_stops:
        risk_signals.append({"level": "warning", "signal": "ngrok tunnel went down", "count": len(ngrok_stops), "since": "24h"})

    # Failed inbound calls
    failed_inbound = [l for l in recent_logs if l.direction == "inbound" and _is_error(l.summary)]
    if len(failed_inbound) > 5:
        risk_signals.append({"level": "error", "signal": "Failed inbound calls", "count": len(failed_inbound), "since": "24h"})

    return {
        "runs": {
            "total": len(all_runs),
            "by_day": runs_by_day,
            "by_mode": runs_by_mode,
            "by_model": runs_by_model,
            "latency_percentiles": latency_percentiles,
        },
        "agent_tokens": {
            "by_day": agent_tokens_by_day,
            "by_model": agent_tokens_by_model,
            "total_prompt_tokens": sum(v["prompt_tokens"] for v in agent_token_day_map.values()),
            "total_completion_tokens": sum(v["completion_tokens"] for v in agent_token_day_map.values()),
            "total_cost_usd": round(sum(v["cost_usd"] for v in agent_token_day_map.values()), 6),
        },
        "system_costs": {
            "entries": system_cost_entries,
            "by_day": system_costs_by_day_list,
            "total_cost_usd": total_system_cost,
        },
        "connections": {
            "total_events": total_events,
            "inbound_calls": inbound_calls,
            "outbound_calls": outbound_calls,
            "internal_events": internal_events,
            "by_connection": by_connection,
            "by_event_type": by_event_type,
            "errors_by_day": errors_by_day,
            "agent_calls_by_day": agent_calls_by_day,
        },
        "platform": {
            "documents_ingested": documents_ingested,
            "total_chunks": total_chunks,
            "benchmark_runs": benchmark_runs_count,
            "agent_sessions": agent_sessions_count,
            "agent_messages_total": agent_messages_total,
            "documents_by_day": documents_by_day,
            "system_events": system_events,
            "risk_signals": risk_signals,
        },
        "unified_runs": {
            "total": total_ur,
            "by_domain": ur_by_domain,
            "by_type": ur_by_type,
        },
    }


# ---------------------------------------------------------------------------
# System costs CRUD  (manual entries: Claude Code CLI, external tool spend)
# ---------------------------------------------------------------------------

@router.get("/system-costs")
def get_system_costs(db: Session = Depends(get_db)):
    return _load_system_costs(db)


@router.post("/system-costs", status_code=201)
def add_system_cost(entry: SystemCostEntry, db: Session = Depends(get_db)):
    entries = _load_system_costs(db)
    new_entry = {
        "id": str(uuid.uuid4()),
        **entry.model_dump(),
    }
    if not new_entry.get("cost_usd") and (new_entry.get("prompt_tokens") or new_entry.get("completion_tokens")):
        new_entry["cost_usd"] = round(
            _estimate_cost(new_entry["prompt_tokens"], new_entry["completion_tokens"], new_entry["model"]), 6
        )
    entries.append(new_entry)
    _save_system_costs(db, entries)
    return new_entry


@router.delete("/system-costs/{entry_id}", status_code=204)
def delete_system_cost(entry_id: str, db: Session = Depends(get_db)):
    entries = _load_system_costs(db)
    entries = [e for e in entries if e.get("id") != entry_id]
    _save_system_costs(db, entries)
    return None
