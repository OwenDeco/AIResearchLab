from __future__ import annotations

import json
import logging
import threading
import uuid
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from api.deps import get_bm25_index, get_chroma, get_db, get_graph_store
from api.schemas import (
    BenchmarkConfig,
    BenchmarkQuestion,
    BenchmarkResultResponse,
    BenchmarkRunRequest,
    BenchmarkRunResponse,
    BenchmarkSessionPayload,
)
from benchmarking.question_sets import get_default_question_set
from database import SessionLocal
from models_db import BenchmarkResult, BenchmarkRun, Chunk

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/benchmarks", tags=["benchmarks"])


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _run_to_response(run: BenchmarkRun) -> BenchmarkRunResponse:
    try:
        configs = json.loads(run.config_json or "[]")
    except (json.JSONDecodeError, TypeError):
        configs = []
    return BenchmarkRunResponse(
        id=run.id,
        name=run.name,
        status=run.status,
        created_at=run.created_at,
        completed_at=run.completed_at,
        total_questions=run.total_questions,
        completed_questions=run.completed_questions,
        configs=configs,
    )


def _run_benchmark_in_background(
    benchmark_run_id: str,
    questions: List[BenchmarkQuestion],
    configs: List[BenchmarkConfig],
    chroma_collection,
    graph_store,
    bm25_index,
) -> None:
    """
    Target function for the background thread.

    Creates its own DB session so it is independent of the request session.
    """
    from benchmarking.runner import BenchmarkRunner

    db = SessionLocal()
    try:
        runner = BenchmarkRunner(
            db=db,
            chroma_collection=chroma_collection,
            graph_store=graph_store,
            bm25_index=bm25_index,
        )
        runner.run(
            benchmark_run_id=benchmark_run_id,
            questions=questions,
            configs=configs,
        )
    except Exception as exc:
        logger.error("Background benchmark thread failed: %s", exc, exc_info=True)
    finally:
        db.close()


# ---------------------------------------------------------------------------
# POST /api/benchmarks
# ---------------------------------------------------------------------------

@router.post("", response_model=BenchmarkRunResponse, status_code=202)
def create_benchmark(
    request: BenchmarkRunRequest,
    db: Session = Depends(get_db),
    chroma=Depends(get_chroma),
    graph_store=Depends(get_graph_store),
    bm25_index=Depends(get_bm25_index),
):
    """
    Start a new benchmark run in a background thread.

    Returns immediately with the benchmark run ID and status=pending.
    """
    if not request.question_set:
        raise HTTPException(status_code=400, detail="question_set must not be empty.")
    if not request.configs:
        raise HTTPException(status_code=400, detail="configs must not be empty.")

    run_id = str(uuid.uuid4())
    total_questions = len(request.question_set) * len(request.configs)

    configs_data = [c.model_dump() for c in request.configs]

    run = BenchmarkRun(
        id=run_id,
        name=request.name,
        status="pending",
        config_json=json.dumps(configs_data),
        total_questions=total_questions,
        completed_questions=0,
    )
    db.add(run)
    db.commit()
    db.refresh(run)

    # Launch background thread
    thread = threading.Thread(
        target=_run_benchmark_in_background,
        args=(
            run_id,
            request.question_set,
            request.configs,
            chroma,
            graph_store,
            bm25_index,
        ),
        daemon=True,
        name=f"benchmark-{run_id[:8]}",
    )
    thread.start()

    return _run_to_response(run)


# ---------------------------------------------------------------------------
# GET /api/benchmarks
# ---------------------------------------------------------------------------

@router.get("", response_model=List[BenchmarkRunResponse])
def list_benchmarks(db: Session = Depends(get_db)):
    """Return all benchmark runs ordered by creation date descending."""
    runs = (
        db.query(BenchmarkRun)
        .order_by(BenchmarkRun.created_at.desc())
        .all()
    )
    return [_run_to_response(r) for r in runs]


# ---------------------------------------------------------------------------
# POST /api/benchmarks/question-sets/generate
# Must be registered before /{benchmark_id} to avoid wildcard shadowing
# ---------------------------------------------------------------------------

@router.post("/question-sets/generate", response_model=List[BenchmarkQuestion])
def generate_questions(
    n: int = Query(default=10, ge=1, le=50, description="Number of questions to generate"),
    doc_id: Optional[str] = Query(default=None, description="Limit to a specific document"),
    db: Session = Depends(get_db),
):
    """
    Sample chunks from ingested documents and use the LLM to generate
    question + reference_answer pairs suitable for benchmarking.
    """
    import random
    from config import settings
    from models.registry import get_llm

    # Sample chunks — more candidates than needed so we can spread across docs
    query = db.query(Chunk)
    if doc_id:
        query = query.filter(Chunk.doc_id == doc_id)

    total = query.count()
    if total == 0:
        raise HTTPException(status_code=400, detail="No chunks found. Ingest documents first.")

    # Sample up to n*3 candidate chunks, pick n evenly spread ones
    all_chunks = query.order_by(Chunk.doc_id, Chunk.chunk_index).all()
    step = max(1, len(all_chunks) // (n * 3))
    candidates = all_chunks[::step][: n * 3]
    random.shuffle(candidates)
    selected = candidates[:n]

    try:
        llm = get_llm(settings.DEFAULT_LLM)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Could not load LLM: {exc}")

    prompt_template = (
        "You are a benchmark question generator. Given the following text excerpt from a document, "
        "generate exactly ONE question that can be answered using only this excerpt, "
        "and provide a concise reference answer.\n\n"
        "Respond with valid JSON only, in this exact format:\n"
        '{{"question": "...", "reference_answer": "..."}}\n\n'
        "Text excerpt:\n{text}"
    )

    generated: List[BenchmarkQuestion] = []
    for chunk in selected:
        text = chunk.content[:2000]
        prompt = prompt_template.format(text=text)
        try:
            response = llm.complete(
                messages=[{"role": "user", "content": prompt}],
                temperature=0.7,
                max_tokens=512,
            )
            raw = response.content

            # Strip markdown code fences and find the first JSON object
            clean = raw.strip()
            for prefix in ("```json", "```"):
                if clean.startswith(prefix):
                    clean = clean[len(prefix):]
            if clean.endswith("```"):
                clean = clean[:-3]
            clean = clean.strip()

            # If not starting with {, try to find the first { ... } block
            if not clean.startswith("{"):
                start = clean.find("{")
                end = clean.rfind("}")
                if start != -1 and end != -1:
                    clean = clean[start:end + 1]

            data = json.loads(clean)

            # Accept both single object and list-of-one
            if isinstance(data, list):
                data = data[0] if data else {}

            if not isinstance(data, dict):
                raise ValueError(f"Unexpected LLM response type: {type(data)}")

            # Accept common key variants
            q = (
                data.get("question")
                or data.get("Question")
                or data.get("q")
                or ""
            )
            a = (
                data.get("reference_answer")
                or data.get("answer")
                or data.get("Answer")
                or data.get("reference")
                or ""
            )
            q = str(q).strip()
            a = str(a).strip()

            if q and a:
                generated.append(BenchmarkQuestion(
                    question=q,
                    reference_answer=a,
                    doc_ids=[chunk.doc_id],
                    source_chunk_id=chunk.id,
                ))
            else:
                logger.warning("Question generation: empty q/a for chunk %s. Raw: %s", chunk.id, raw[:200])
        except Exception as exc:
            logger.warning("Question generation failed for chunk %s: %s", chunk.id, exc)

    if not generated:
        raise HTTPException(status_code=500, detail="LLM failed to generate any questions.")

    return generated


# ---------------------------------------------------------------------------
# GET /api/benchmarks/question-sets/default
# Must be registered before /{benchmark_id} to avoid wildcard shadowing
# ---------------------------------------------------------------------------

@router.get("/question-sets/default", response_model=List[BenchmarkQuestion])
def get_default_questions():
    """Return the built-in sample benchmark question set."""
    try:
        questions = get_default_question_set()
        return [
            BenchmarkQuestion(
                question=q.question,
                reference_answer=q.reference_answer,
                doc_ids=q.doc_ids,
            )
            for q in questions
        ]
    except Exception as exc:
        logger.error("Failed to load default question set: %s", exc)
        raise HTTPException(status_code=500, detail=f"Failed to load default question set: {exc}")


# ---------------------------------------------------------------------------
# GET /api/benchmarks/session  — load persisted question set + configs
# POST /api/benchmarks/session — save current question set + configs
# Must be before /{benchmark_id} to avoid wildcard shadowing
# ---------------------------------------------------------------------------

_SESSION_KEY = "benchmark_lab_session"


@router.get("/session")
def get_session(db: Session = Depends(get_db)):
    """Return the last-saved benchmark lab session (question set + configs)."""
    from models_db import AppState
    row = db.query(AppState).filter(AppState.key == _SESSION_KEY).first()
    if row is None:
        return {"question_set": [], "configs": []}
    try:
        return json.loads(row.value)
    except Exception:
        return {"question_set": [], "configs": []}


@router.post("/session", status_code=204)
def save_session(payload: BenchmarkSessionPayload, db: Session = Depends(get_db)):
    """Persist the current benchmark lab session (question set + configs)."""
    from models_db import AppState
    from datetime import datetime, timezone
    row = db.query(AppState).filter(AppState.key == _SESSION_KEY).first()
    if row is None:
        row = AppState(key=_SESSION_KEY, value=payload.model_dump_json())
        db.add(row)
    else:
        row.value = payload.model_dump_json()
        row.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
    db.commit()
    return None


# ---------------------------------------------------------------------------
# GET /api/benchmarks/{benchmark_id}
# ---------------------------------------------------------------------------

@router.get("/{benchmark_id}", response_model=BenchmarkRunResponse)
def get_benchmark(benchmark_id: str, db: Session = Depends(get_db)):
    """Return a single benchmark run's status and progress."""
    run = db.query(BenchmarkRun).filter(BenchmarkRun.id == benchmark_id).first()
    if run is None:
        raise HTTPException(status_code=404, detail="Benchmark run not found.")
    return _run_to_response(run)


# ---------------------------------------------------------------------------
# GET /api/benchmarks/{benchmark_id}/results
# ---------------------------------------------------------------------------

@router.get("/{benchmark_id}/results", response_model=List[BenchmarkResultResponse])
def get_benchmark_results(benchmark_id: str, db: Session = Depends(get_db)):
    """Return all results for a benchmark run, ordered by question then config."""
    run = db.query(BenchmarkRun).filter(BenchmarkRun.id == benchmark_id).first()
    if run is None:
        raise HTTPException(status_code=404, detail="Benchmark run not found.")

    results = (
        db.query(BenchmarkResult)
        .filter(BenchmarkResult.benchmark_run_id == benchmark_id)
        .order_by(BenchmarkResult.created_at.asc())
        .all()
    )

    def _parse_contexts(raw: str | None) -> list:
        if not raw:
            return []
        try:
            return json.loads(raw)
        except Exception:
            return []

    return [
        BenchmarkResultResponse(
            id=r.id,
            benchmark_run_id=r.benchmark_run_id,
            question=r.question,
            reference_answer=r.reference_answer,
            config_label=r.config_label,
            retrieval_mode=r.retrieval_mode,
            model_name=r.model_name,
            embed_model=r.embed_model,
            answer=r.answer,
            context_precision=r.context_precision,
            answer_relevance=r.answer_relevance,
            hit_rate=r.hit_rate,
            mrr=r.mrr,
            answer_correctness=r.answer_correctness,
            faithfulness=r.faithfulness,
            chunks_retrieved=r.chunks_retrieved,
            source_doc_id=r.source_doc_id,
            contexts=_parse_contexts(r.contexts_json),
            latency_ms=r.latency_ms,
            estimated_cost_usd=r.estimated_cost_usd,
            created_at=r.created_at,
        )
        for r in results
    ]
