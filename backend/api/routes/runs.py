from __future__ import annotations

import json
import logging
from typing import List

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from api.deps import get_db
from api.schemas import ContextItem, RunListResponse, RunResponse
from models_db import Run

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/runs", tags=["runs"])


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _run_to_response(run: Run, include_contexts: bool = False) -> RunResponse:
    try:
        stage_timings = json.loads(run.stage_timings_json or "{}")
    except (json.JSONDecodeError, TypeError):
        stage_timings = {}

    contexts: List[ContextItem] = []
    if include_contexts:
        try:
            raw = json.loads(run.context_json or "[]")
            for item in raw:
                contexts.append(
                    ContextItem(
                        chunk_id=item.get("chunk_id", ""),
                        doc_id=item.get("doc_id", ""),
                        content=item.get("content", ""),
                        score=item.get("score", 0.0),
                        metadata=item.get("metadata", {}),
                    )
                )
        except (json.JSONDecodeError, TypeError):
            contexts = []

    return RunResponse(
        id=run.id,
        query=run.query,
        retrieval_mode=run.retrieval_mode,
        model_name=run.model_name,
        embed_model=run.embed_model,
        answer=run.answer,
        contexts=contexts,
        latency_ms=run.latency_ms,
        prompt_tokens=run.prompt_tokens,
        completion_tokens=run.completion_tokens,
        estimated_cost_usd=run.estimated_cost_usd,
        stage_timings=stage_timings,
        chunk_count=run.chunk_count,
        graph_node_count=run.graph_node_count,
        created_at=run.created_at,
    )


# ---------------------------------------------------------------------------
# GET /api/runs
# ---------------------------------------------------------------------------

@router.get("", response_model=List[RunResponse])
def list_runs(limit: int = 50, db: Session = Depends(get_db)):
    """Return the most recent query runs."""
    runs = (
        db.query(Run)
        .order_by(Run.created_at.desc())
        .limit(limit)
        .all()
    )
    return [_run_to_response(r, include_contexts=False) for r in runs]


# ---------------------------------------------------------------------------
# GET /api/runs/{run_id}
# ---------------------------------------------------------------------------

@router.get("/{run_id}", response_model=RunResponse)
def get_run(run_id: str, db: Session = Depends(get_db)):
    """Return a single run with full context_json."""
    run = db.query(Run).filter(Run.id == run_id).first()
    if run is None:
        raise HTTPException(status_code=404, detail="Run not found.")
    return _run_to_response(run, include_contexts=True)
