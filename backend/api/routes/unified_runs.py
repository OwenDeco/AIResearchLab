from __future__ import annotations

import json
import logging
from datetime import datetime
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from api.deps import get_db
from models_db import RunEvent, RunStep, UnifiedRun

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/unified-runs", tags=["unified-runs"])


class RunStepOut(BaseModel):
    id: str
    run_id: str
    parent_step_id: Optional[str] = None
    domain: str
    step_type: str
    component: Optional[str] = None
    started_at: str
    ended_at: Optional[str] = None
    duration_ms: Optional[float] = None
    status: str
    metrics: Optional[Dict[str, Any]] = None
    input_summary: Optional[str] = None
    output_summary: Optional[str] = None
    error_message: Optional[str] = None


class RunEventOut(BaseModel):
    id: str
    run_id: Optional[str] = None
    step_id: Optional[str] = None
    event_type: str
    category: str
    severity: str
    timestamp: str
    payload: Optional[Dict[str, Any]] = None
    summary: Optional[str] = None
    source: Optional[str] = None


class UnifiedRunOut(BaseModel):
    id: str
    parent_run_id: Optional[str] = None
    experiment_id: Optional[str] = None
    primary_domain: str
    run_type: str
    initiated_by: str
    status: str
    started_at: str
    ended_at: Optional[str] = None
    source_id: Optional[str] = None
    source_table: Optional[str] = None
    summary: Optional[Dict[str, Any]] = None


def _run_to_out(run: UnifiedRun) -> UnifiedRunOut:
    return UnifiedRunOut(
        id=run.id,
        parent_run_id=run.parent_run_id,
        experiment_id=run.experiment_id,
        primary_domain=run.primary_domain,
        run_type=run.run_type,
        initiated_by=run.initiated_by,
        status=run.status,
        started_at=run.started_at.isoformat(),
        ended_at=run.ended_at.isoformat() if run.ended_at else None,
        source_id=run.source_id,
        source_table=run.source_table,
        summary=json.loads(run.summary_json) if run.summary_json else None,
    )


def _step_to_out(step: RunStep) -> RunStepOut:
    return RunStepOut(
        id=step.id,
        run_id=step.run_id,
        parent_step_id=step.parent_step_id,
        domain=step.domain,
        step_type=step.step_type,
        component=step.component,
        started_at=step.started_at.isoformat(),
        ended_at=step.ended_at.isoformat() if step.ended_at else None,
        duration_ms=step.duration_ms,
        status=step.status,
        metrics=json.loads(step.metrics_json) if step.metrics_json else None,
        input_summary=step.input_summary,
        output_summary=step.output_summary,
        error_message=step.error_message,
    )


def _event_to_out(event: RunEvent) -> RunEventOut:
    return RunEventOut(
        id=event.id,
        run_id=event.run_id,
        step_id=event.step_id,
        event_type=event.event_type,
        category=event.category,
        severity=event.severity,
        timestamp=event.timestamp.isoformat(),
        payload=json.loads(event.payload_json) if event.payload_json else None,
        summary=event.summary,
        source=event.source,
    )


@router.get("")
def list_unified_runs(
    domain: Optional[str] = None,
    run_type: Optional[str] = None,
    status: Optional[str] = None,
    top_level_only: bool = True,
    limit: int = 50,
    offset: int = 0,
    db: Session = Depends(get_db),
) -> dict:
    q = db.query(UnifiedRun)
    if domain is not None:
        q = q.filter(UnifiedRun.primary_domain == domain)
    if run_type is not None:
        q = q.filter(UnifiedRun.run_type == run_type)
    if status is not None:
        q = q.filter(UnifiedRun.status == status)
    if top_level_only:
        q = q.filter(UnifiedRun.parent_run_id == None)  # noqa: E711
    total = q.count()
    runs = q.order_by(UnifiedRun.started_at.desc()).offset(offset).limit(limit).all()
    return {"runs": [_run_to_out(r) for r in runs], "total": total}


@router.get("/{run_id}", response_model=UnifiedRunOut)
def get_unified_run(run_id: str, db: Session = Depends(get_db)) -> UnifiedRunOut:
    run = db.query(UnifiedRun).filter(UnifiedRun.id == run_id).first()
    if run is None:
        raise HTTPException(status_code=404, detail="Run not found.")
    return _run_to_out(run)


@router.get("/{run_id}/steps")
def get_run_steps(run_id: str, db: Session = Depends(get_db)) -> dict:
    steps = (
        db.query(RunStep)
        .filter(RunStep.run_id == run_id)
        .order_by(RunStep.started_at)
        .all()
    )
    return {"steps": [_step_to_out(s) for s in steps]}


@router.get("/{run_id}/events")
def get_run_events(run_id: str, db: Session = Depends(get_db)) -> dict:
    events = (
        db.query(RunEvent)
        .filter(RunEvent.run_id == run_id)
        .order_by(RunEvent.timestamp)
        .all()
    )
    return {"events": [_event_to_out(e) for e in events]}


@router.get("/{run_id}/live")
def get_run_live(
    run_id: str,
    since: Optional[str] = None,
    db: Session = Depends(get_db),
) -> dict:
    """
    Polling endpoint for the live simulator.
    Returns the orchestrator run, all child runs, and all new events since `since`.
    Poll every 150ms with ?since=<last_now> to get only new events each tick.
    """
    root = db.query(UnifiedRun).filter(UnifiedRun.id == run_id).first()
    if root is None:
        raise HTTPException(status_code=404, detail="Run not found.")

    children = (
        db.query(UnifiedRun)
        .filter(UnifiedRun.parent_run_id == run_id)
        .order_by(UnifiedRun.started_at)
        .all()
    )

    all_run_ids = [run_id] + [c.id for c in children]

    since_dt: Optional[datetime] = None
    if since:
        try:
            since_dt = datetime.fromisoformat(since)
        except ValueError:
            pass

    q = db.query(RunEvent).filter(RunEvent.run_id.in_(all_run_ids))
    if since_dt:
        q = q.filter(RunEvent.timestamp > since_dt)
    events = q.order_by(RunEvent.timestamp).all()

    return {
        "run": _run_to_out(root),
        "children": [_run_to_out(c) for c in children],
        "events": [_event_to_out(e) for e in events],
        "now": datetime.utcnow().isoformat(),
    }
