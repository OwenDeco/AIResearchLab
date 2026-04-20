from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime
from typing import List

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from api.deps import get_bm25_index, get_chroma, get_db, get_graph_store
from api.schemas import ContextItem, QueryRequest, QueryResponse
from models_db import Run
from models.registry import get_llm
from observability.tracker import RunTracker
from retrieval.base import RetrievedChunk
from retrieval.factory import build_retriever

logger = logging.getLogger(__name__)

router = APIRouter(tags=["retrieval"])


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _enrich_chunks_with_content(
    chunks: List[RetrievedChunk],
    db: Session,
) -> List[RetrievedChunk]:
    """
    For retrievers that don't populate content (e.g. lexical), load content
    from DB by chunk_id.
    """
    from models_db import Chunk as ChunkModel

    needs_content = [c for c in chunks if not c.content]
    if not needs_content:
        return chunks

    chunk_ids = [c.chunk_id for c in needs_content]
    rows = db.query(ChunkModel).filter(ChunkModel.id.in_(chunk_ids)).all()
    row_map = {r.id: r for r in rows}

    for chunk in needs_content:
        row = row_map.get(chunk.chunk_id)
        if row:
            chunk.content = row.content
            chunk.doc_id = row.doc_id or chunk.doc_id

    return chunks


# ---------------------------------------------------------------------------
# POST /api/query
# ---------------------------------------------------------------------------

def _query_external(request: QueryRequest, run_id: str, tracker: RunTracker, db: Session) -> QueryResponse:
    """Route a query to a registered external A2A agent or MCP server."""
    from api.routes.registered_connections import _load_list, _A2A_KEY, _MCP_KEY

    conn_id = request.external_connection_id
    conn_type = request.external_connection_type
    answer = ""
    retrieval_mode = f"external_{conn_type}" if conn_type else "external"

    with tracker.start_stage("retrieval"):
        pass  # no local retrieval

    # Log outbound call
    from api.conn_log import log_conn_event as _log
    _log(
        db,
        event_type="outbound_call",
        direction="outbound",
        connection_type=conn_type or "unknown",
        connection_id=conn_id,
        summary=f"Outbound query via {conn_type or 'external'} connection '{conn_id}': {request.query[:100]}",
        details={"query": request.query, "connection_id": conn_id, "connection_type": conn_type},
    )

    with tracker.start_stage("generation"):
        try:
            if conn_type == "a2a":
                conns = _load_list(db, _A2A_KEY)
                conn = next((c for c in conns if c["id"] == conn_id), None)
                if conn is None:
                    raise ValueError(f"A2A connection '{conn_id}' not found.")
                from connections.a2a_client import call_agent
                answer = call_agent(conn["task_url"], request.query)

            elif conn_type == "mcp":
                conns = _load_list(db, _MCP_KEY)
                conn = next((c for c in conns if c["id"] == conn_id), None)
                if conn is None:
                    raise ValueError(f"MCP connection '{conn_id}' not found.")
                from connections.mcp_client import run_with_tools
                answer = run_with_tools(conn["server_url"], request.query, request.model_name, conn.get("transport", "sse"))

            else:
                raise ValueError(f"Unknown external connection type '{conn_type}'.")

        except Exception as exc:
            logger.error("External connection query failed: %s", exc, exc_info=True)
            answer = "External connection error. Check server logs for details."

    metrics = tracker.to_dict()

    run = Run(
        id=run_id,
        query=request.query,
        retrieval_mode=retrieval_mode,
        model_name=request.model_name,
        embed_model=request.embed_model,
        answer=answer,
        context_json="[]",
        latency_ms=metrics["total_elapsed_ms"],
        prompt_tokens=metrics.get("prompt_tokens", 0),
        completion_tokens=metrics.get("completion_tokens", 0),
        estimated_cost_usd=0.0,
        stage_timings_json=json.dumps(metrics["stage_timings"]),
        chunk_count=0,
        graph_node_count=0,
    )
    db.add(run)
    try:
        db.commit()
    except Exception as exc:
        logger.error("Failed to persist external Run: %s", exc)
        db.rollback()

    return QueryResponse(
        answer=answer,
        contexts=[],
        run_id=run_id,
        latency_ms=metrics["total_elapsed_ms"],
        tokens={"prompt": 0, "completion": 0, "total": 0},
        cost=0.0,
        stage_timings=metrics["stage_timings"],
        retrieval_mode=retrieval_mode,
    )


@router.post("/query", response_model=QueryResponse)
def query(
    request: QueryRequest,
    db: Session = Depends(get_db),
    chroma=Depends(get_chroma),
    graph_store=Depends(get_graph_store),
    bm25_index=Depends(get_bm25_index),
):
    """Run a query using the selected retrieval mode and LLM."""
    tracker = RunTracker()
    run_id = str(uuid.uuid4())

    # ------------------------------------------------------------------
    # External connection routing (A2A / MCP) — bypasses local retrieval
    # ------------------------------------------------------------------
    if request.external_connection_id:
        return _query_external(request, run_id, tracker, db)

    # ------------------------------------------------------------------
    # Stage 1: Retrieval
    # ------------------------------------------------------------------
    retrieved_chunks: List[RetrievedChunk] = []
    with tracker.start_stage("retrieval"):
        try:
            retriever = build_retriever(
                mode=request.retrieval_mode,
                embed_model=request.embed_model,
                model_name=request.model_name,
                db=db,
                chroma=chroma,
                graph_store=graph_store,
                bm25_index=bm25_index,
                alpha=request.alpha,
                graph_hops=request.graph_hops,
            )
            retrieved_chunks = retriever.retrieve(request.query, top_k=request.top_k)
            # Ensure all chunks have content populated
            retrieved_chunks = _enrich_chunks_with_content(retrieved_chunks, db)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        except Exception as exc:
            logger.error("Retrieval stage failed: %s", exc, exc_info=True)
            retrieved_chunks = []

    tracker.record_chunks(len(retrieved_chunks))

    # Track graph nodes for graph_rag mode
    if request.retrieval_mode == "graph_rag":
        graph_node_count = sum(
            len(c.metadata.get("matched_entities", [])) for c in retrieved_chunks
        )
        tracker.record_graph_nodes(graph_node_count)

    # ------------------------------------------------------------------
    # Stage 2: Generation
    # ------------------------------------------------------------------
    answer = ""
    with tracker.start_stage("generation"):
        context_parts = []
        for i, chunk in enumerate(retrieved_chunks, start=1):
            if chunk.content:
                context_parts.append(f"[{i}] {chunk.content}")

        context_text = "\n\n".join(context_parts) if context_parts else "No relevant context found."

        prompt = f"Answer based on context:\n{context_text}\n\nQuestion: {request.query}"

        try:
            llm = get_llm(request.model_name)
            llm_response = llm.complete(
                messages=[{"role": "user", "content": prompt}],
                temperature=0.0,
                max_tokens=2048,
            )
            answer = llm_response.content
            tracker.record_tokens(
                prompt=llm_response.prompt_tokens,
                completion=llm_response.completion_tokens,
                model=request.model_name,
            )
        except Exception as exc:
            logger.error("Generation stage failed: %s", exc, exc_info=True)
            answer = "Generation failed. Check server logs for details."

    # ------------------------------------------------------------------
    # Persist Run to DB
    # ------------------------------------------------------------------
    metrics = tracker.to_dict()

    context_items = [
        {
            "chunk_id": c.chunk_id,
            "doc_id": c.doc_id,
            "content": c.content,
            "score": c.score,
            "metadata": c.metadata,
        }
        for c in retrieved_chunks
    ]

    run = Run(
        id=run_id,
        query=request.query,
        retrieval_mode=request.retrieval_mode,
        model_name=request.model_name,
        embed_model=request.embed_model,
        answer=answer,
        context_json=json.dumps(context_items),
        latency_ms=metrics["total_elapsed_ms"],
        prompt_tokens=metrics["prompt_tokens"],
        completion_tokens=metrics["completion_tokens"],
        estimated_cost_usd=metrics["estimated_cost_usd"],
        stage_timings_json=json.dumps(metrics["stage_timings"]),
        chunk_count=metrics["chunk_count"],
        graph_node_count=metrics["graph_node_count"],
    )
    db.add(run)
    try:
        db.commit()
    except Exception as exc:
        logger.error("Failed to persist Run: %s", exc)
        db.rollback()

    # ------------------------------------------------------------------
    # Unified run tracking — never raises, never blocks the response
    # ------------------------------------------------------------------
    try:
        from models_db import UnifiedRun as _UR, RunStep as _RS, RunEvent as _RE
        _now = datetime.utcnow()
        _stage_timings = json.loads(run.stage_timings_json or "{}") if run.stage_timings_json else {}
        _ur = _UR(
            id=str(uuid.uuid4()),
            primary_domain="orchestration",
            run_type="runtime_test",
            initiated_by="user",
            status="completed",
            started_at=run.created_at,
            ended_at=_now,
            source_id=run.id,
            source_table="runs",
            summary_json=json.dumps({
                "total_latency_ms": run.latency_ms,
                "total_tokens": (run.prompt_tokens or 0) + (run.completion_tokens or 0),
                "total_cost_usd": run.estimated_cost_usd,
                "error_count": 0,
                "step_count": len(_stage_timings),
                "final_output": (run.answer or "")[:200],
                "retrieval_mode": run.retrieval_mode,
            }),
        )
        db.add(_ur)
        # Create one RunStep per stage timing
        for _stage, _ms in _stage_timings.items():
            _stype = (
                "llm_call"
                if any(x in _stage for x in ("generat", "llm", "synthesis"))
                else "retrieve_chunks"
            )
            db.add(_RS(
                id=str(uuid.uuid4()),
                run_id=_ur.id,
                domain="orchestration",
                step_type=_stype,
                component=run.model_name if _stype == "llm_call" else run.retrieval_mode,
                started_at=run.created_at,
                ended_at=_now,
                duration_ms=float(_ms),
                status="completed",
                metrics_json=json.dumps({
                    "prompt_tokens": run.prompt_tokens if _stype == "llm_call" else None,
                    "completion_tokens": run.completion_tokens if _stype == "llm_call" else None,
                    "cost_usd": run.estimated_cost_usd if _stype == "llm_call" else None,
                    "chunk_count": run.chunk_count if _stype == "retrieve_chunks" else None,
                }),
                input_summary=f"Query: {run.query[:100]}",
                output_summary=(
                    f"{run.chunk_count or 0} chunks"
                    if _stype == "retrieve_chunks"
                    else (run.answer or "")[:100]
                ),
            ))
        # Key lifecycle events
        db.add(_RE(
            id=str(uuid.uuid4()),
            run_id=_ur.id,
            event_type="started",
            category="execution",
            severity="info",
            timestamp=run.created_at,
            summary=f"Query: {run.query[:100]}",
            source="retrieval",
        ))
        db.add(_RE(
            id=str(uuid.uuid4()),
            run_id=_ur.id,
            event_type="chunk_selected",
            category="data",
            severity="info",
            timestamp=_now,
            summary=f"{run.chunk_count or 0} chunks via {run.retrieval_mode}",
            source="retrieval",
            payload_json=json.dumps({
                "chunk_count": run.chunk_count,
                "retrieval_mode": run.retrieval_mode,
            }),
        ))
        db.add(_RE(
            id=str(uuid.uuid4()),
            run_id=_ur.id,
            event_type="llm_called",
            category="ai",
            severity="info",
            timestamp=_now,
            summary=f"{run.model_name}: {run.prompt_tokens or 0}+{run.completion_tokens or 0} tokens",
            source="retrieval",
            payload_json=json.dumps({
                "model": run.model_name,
                "prompt_tokens": run.prompt_tokens,
                "completion_tokens": run.completion_tokens,
                "cost_usd": run.estimated_cost_usd,
            }),
        ))
        db.add(_RE(
            id=str(uuid.uuid4()),
            run_id=_ur.id,
            event_type="completed",
            category="execution",
            severity="info",
            timestamp=_now,
            summary=f"Completed in {(run.latency_ms or 0):.0f}ms",
            source="retrieval",
        ))
        db.commit()
    except Exception:
        pass  # never break the query response

    # ------------------------------------------------------------------
    # Build response
    # ------------------------------------------------------------------
    return QueryResponse(
        answer=answer,
        contexts=[
            ContextItem(
                chunk_id=c.chunk_id,
                doc_id=c.doc_id,
                content=c.content,
                score=c.score,
                metadata=c.metadata,
            )
            for c in retrieved_chunks
        ],
        run_id=run_id,
        latency_ms=metrics["total_elapsed_ms"],
        tokens={
            "prompt": metrics["prompt_tokens"],
            "completion": metrics["completion_tokens"],
            "total": metrics["total_tokens"],
        },
        cost=metrics["estimated_cost_usd"],
        stage_timings=metrics["stage_timings"],
        retrieval_mode=request.retrieval_mode,
    )
