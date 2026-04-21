from __future__ import annotations

import json
import logging
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import List, Optional

from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)


@dataclass
class BenchmarkConfig:
    label: str
    retrieval_mode: str
    model_name: str
    embed_model: str
    top_k: int = 5


class BenchmarkRunner:
    """
    Executes a full benchmark: for each (config, question) pair, retrieves
    chunks, generates an answer, evaluates it with metrics, and persists the
    result to the database.

    Designed to run synchronously inside a background thread so it does not
    block the FastAPI event loop.
    """

    def __init__(
        self,
        db: Session,
        chroma_collection,
        graph_store,
        bm25_index,
    ) -> None:
        self._db = db
        self._chroma = chroma_collection
        self._graph_store = graph_store
        self._bm25 = bm25_index

    # ------------------------------------------------------------------
    # Public entry point
    # ------------------------------------------------------------------

    def run(
        self,
        benchmark_run_id: str,
        questions,  # list[BenchmarkQuestion | api.schemas.BenchmarkQuestion]
        configs,    # list[BenchmarkConfig | api.schemas.BenchmarkConfig]
    ) -> None:
        """
        Execute the benchmark.

        Updates the BenchmarkRun record in the database throughout execution.
        """
        from models_db import BenchmarkResult, BenchmarkRun as BenchmarkRunModel

        # Mark as running
        self._update_run_status(benchmark_run_id, "running")

        completed = 0
        total = len(questions) * len(configs)

        # ------------------------------------------------------------------
        # Unified run tracking — create the top-level UnifiedRun record
        # ------------------------------------------------------------------
        _ur_id = None
        _final_status = "failed"  # default; overwritten on success
        _total_cost = 0.0
        _total_prompt_tokens = 0
        _total_completion_tokens = 0
        _total_latency_ms = 0.0
        try:
            import uuid as _uuid
            from models_db import UnifiedRun as _UR
            _bm_run = self._db.query(BenchmarkRunModel).filter(
                BenchmarkRunModel.id == benchmark_run_id
            ).first()
            _bm_name = _bm_run.name if _bm_run else None
            _ur_id = str(_uuid.uuid4())
            _ur = _UR(
                id=_ur_id,
                primary_domain="evaluation",
                run_type="benchmark_run",
                initiated_by="user",
                status="running",
                started_at=_bm_run.created_at if _bm_run else datetime.now(timezone.utc).replace(tzinfo=None),
                source_id=benchmark_run_id,
                source_table="benchmark_runs",
                summary_json=json.dumps({
                    "name": _bm_name,
                    "total_questions": total,
                    "status": "running",
                }),
            )
            self._db.add(_ur)
            self._db.commit()
        except Exception as _exc:
            logger.debug("UnifiedRun creation skipped: %s", _exc)
            _ur_id = None
            _bm_name = None

        try:
            for config in configs:
                # Normalise config to plain attributes
                label = getattr(config, "label", str(config))
                retrieval_mode = getattr(config, "retrieval_mode", "vector")
                model_name = getattr(config, "model_name", "openai/gpt-4o-mini")
                embed_model = getattr(config, "embed_model", "openai/text-embedding-3-small")
                top_k = getattr(config, "top_k", 5)

                for question in questions:
                    q_text = getattr(question, "question", str(question))
                    ref_answer = getattr(question, "reference_answer", "")
                    source_doc_ids = list(getattr(question, "doc_ids", []) or [])
                    source_chunk_id = getattr(question, "source_chunk_id", None)

                    result = self._run_single(
                        benchmark_run_id=benchmark_run_id,
                        question=q_text,
                        reference_answer=ref_answer,
                        source_doc_ids=source_doc_ids,
                        source_chunk_id=source_chunk_id,
                        config_label=label,
                        retrieval_mode=retrieval_mode,
                        model_name=model_name,
                        embed_model=embed_model,
                        top_k=top_k,
                    )

                    # Persist result
                    db_result = BenchmarkResult(
                        id=str(uuid.uuid4()),
                        benchmark_run_id=benchmark_run_id,
                        question=q_text,
                        reference_answer=ref_answer,
                        config_label=label,
                        retrieval_mode=retrieval_mode,
                        model_name=model_name,
                        embed_model=embed_model,
                        answer=result["answer"],
                        context_precision=result["context_precision"],
                        answer_relevance=result["answer_relevance"],
                        hit_rate=result["hit_rate"],
                        mrr=result["mrr"],
                        answer_correctness=result["answer_correctness"],
                        faithfulness=result["faithfulness"],
                        chunks_retrieved=result["chunks_retrieved"],
                        source_doc_id=source_doc_ids[0] if source_doc_ids else None,
                        contexts_json=result["contexts_json"],
                        latency_ms=result["latency_ms"],
                        estimated_cost_usd=result["estimated_cost_usd"],
                    )
                    # Commit result independently so a failure doesn't block progress
                    try:
                        self._db.add(db_result)
                        self._db.commit()
                    except Exception as exc:
                        logger.error("BenchmarkRunner: result commit failed: %s", exc)
                        self._db.rollback()

                    # Accumulate run totals
                    _total_cost += result.get("estimated_cost_usd") or 0.0
                    _total_prompt_tokens += result.get("prompt_tokens") or 0
                    _total_completion_tokens += result.get("completion_tokens") or 0
                    _total_latency_ms += result.get("latency_ms") or 0.0

                    # Unified run: record a RunStep for this scored answer
                    if _ur_id:
                        try:
                            import uuid as _uuid
                            from models_db import RunStep as _RS
                            self._db.add(_RS(
                                id=str(_uuid.uuid4()),
                                run_id=_ur_id,
                                domain="evaluation",
                                step_type="score_answer",
                                component=db_result.config_label,
                                started_at=datetime.now(timezone.utc).replace(tzinfo=None),
                                ended_at=datetime.now(timezone.utc).replace(tzinfo=None),
                                duration_ms=result.get("latency_ms"),
                                status="completed",
                                metrics_json=json.dumps({
                                    "context_precision": result.get("context_precision"),
                                    "answer_relevance": result.get("answer_relevance"),
                                    "answer_correctness": result.get("answer_correctness"),
                                    "cost_usd": result.get("estimated_cost_usd"),
                                    "latency_ms": result.get("latency_ms"),
                                    "prompt_tokens": result.get("prompt_tokens", 0),
                                    "completion_tokens": result.get("completion_tokens", 0),
                                }),
                                input_summary=(q_text or "")[:200],
                                output_summary=(result.get("answer") or "")[:200],
                            ))
                            self._db.commit()
                        except Exception as _exc:
                            logger.debug("RunStep creation skipped: %s", _exc)
                            try:
                                self._db.rollback()
                            except Exception:
                                pass

                    completed += 1
                    self._update_progress(benchmark_run_id, completed)

            _final_status = "completed"
            self._update_run_status(benchmark_run_id, _final_status, completed_at=datetime.now(timezone.utc).replace(tzinfo=None))

        except Exception as exc:
            logger.error("BenchmarkRunner.run failed: %s", exc, exc_info=True)
            _final_status = "failed"
            self._update_run_status(benchmark_run_id, _final_status)

        # Unified run: finalise the top-level UnifiedRun record
        if _ur_id:
            try:
                from models_db import UnifiedRun as _UR
                _ur2 = self._db.query(_UR).filter(_UR.id == _ur_id).first()
                if _ur2:
                    _ur2.status = _final_status
                    _ur2.ended_at = datetime.now(timezone.utc).replace(tzinfo=None)
                    _ur2.summary_json = json.dumps({
                        "name": _bm_name,
                        "total_questions": total,
                        "completed_questions": completed,
                        "step_count": completed,
                        "status": _final_status,
                        "total_cost_usd": round(_total_cost, 6),
                        "total_tokens": _total_prompt_tokens + _total_completion_tokens,
                        "total_prompt_tokens": _total_prompt_tokens,
                        "total_completion_tokens": _total_completion_tokens,
                        "total_latency_ms": round(_total_latency_ms, 1),
                    })
                    self._db.commit()
            except Exception as _exc:
                logger.debug("UnifiedRun finalisation skipped: %s", _exc)

    # ------------------------------------------------------------------
    # Single question evaluation
    # ------------------------------------------------------------------

    def _run_single(
        self,
        benchmark_run_id: str,
        question: str,
        reference_answer: str,
        source_doc_ids: List[str],
        source_chunk_id: Optional[str],
        config_label: str,
        retrieval_mode: str,
        model_name: str,
        embed_model: str,
        top_k: int,
    ) -> dict:
        from evaluation.metrics import (
            answer_relevance, answer_correctness, context_precision, faithfulness,
        )
        from models.registry import get_embedder, get_llm, get_reranker
        from observability.tracker import RunTracker

        tracker = RunTracker()
        retrieved_chunks = []
        answer = ""

        # ------ Retrieval ------
        with tracker.start_stage("retrieval"):
            try:
                retriever = self._build_retriever(
                    retrieval_mode=retrieval_mode,
                    embed_model=embed_model,
                    model_name=model_name,
                )
                retrieved_chunks = retriever.retrieve(question, top_k=top_k)

                # Enrich content for lexical results
                from retrieval.base import RetrievedChunk
                chunk_ids_no_content = [c.chunk_id for c in retrieved_chunks if not c.content]
                if chunk_ids_no_content:
                    from models_db import Chunk as ChunkModel
                    rows = (
                        self._db.query(ChunkModel)
                        .filter(ChunkModel.id.in_(chunk_ids_no_content))
                        .all()
                    )
                    row_map = {r.id: r for r in rows}
                    for chunk in retrieved_chunks:
                        if not chunk.content:
                            row = row_map.get(chunk.chunk_id)
                            if row:
                                chunk.content = row.content
                                chunk.doc_id = row.doc_id or chunk.doc_id

            except Exception as exc:
                logger.error("BenchmarkRunner retrieval failed (%s): %s", retrieval_mode, exc)
                retrieved_chunks = []

        tracker.record_chunks(len(retrieved_chunks))

        # ------ Generation ------
        with tracker.start_stage("generation"):
            context_parts = [c.content for c in retrieved_chunks if c.content]
            context_text = "\n\n".join(
                f"[{i+1}] {t}" for i, t in enumerate(context_parts)
            ) or "No relevant context found."

            prompt = f"Answer based on context:\n{context_text}\n\nQuestion: {question}"

            try:
                llm = get_llm(model_name)
                llm_response = llm.complete(
                    messages=[{"role": "user", "content": prompt}],
                    temperature=0.0,
                    max_tokens=1024,
                )
                answer = llm_response.content
                tracker.record_tokens(
                    prompt=llm_response.prompt_tokens,
                    completion=llm_response.completion_tokens,
                    model=model_name,
                )
            except Exception as exc:
                logger.error("BenchmarkRunner generation failed: %s", exc)
                answer = f"Generation error: {exc}"

        metrics = tracker.to_dict()

        # ------ Evaluation ------
        chunk_texts = [c.content for c in retrieved_chunks if c.content]
        retrieved_doc_ids = [c.doc_id for c in retrieved_chunks]
        retrieved_chunk_ids = [c.chunk_id for c in retrieved_chunks]

        try:
            embedder = get_embedder(embed_model)
        except Exception:
            embedder = None

        cp = context_precision(chunk_texts, reference_answer)
        ar = answer_relevance(answer, question, embedder=embedder)
        ac = answer_correctness(answer, reference_answer, embedder=embedder)
        ff = faithfulness(answer, chunk_texts)

        # Hit@K and MRR: document-level evaluation.
        # A retrieval is a hit if any chunk from the source document is in top-K.
        # MRR = 1 / rank of the first chunk from the source document.
        # If no document is linked to the question → metrics are undefined (None).
        if source_doc_ids:
            hr = 0.0
            rr = 0.0
            for i, doc_id in enumerate(retrieved_doc_ids):
                if doc_id in source_doc_ids:
                    hr = 1.0
                    rr = 1.0 / (i + 1)
                    break
        else:
            hr = None
            rr = None

        contexts_data = [
            {
                "chunk_id": c.chunk_id,
                "doc_id": c.doc_id,
                "content": c.content[:500] if c.content else "",
                "score": round(c.score, 4),
            }
            for c in retrieved_chunks
        ]

        return {
            "answer": answer,
            "context_precision": cp,
            "answer_relevance": ar,
            "hit_rate": hr,
            "mrr": rr,
            "answer_correctness": ac,
            "faithfulness": ff,
            "chunks_retrieved": len(chunk_texts),
            "contexts_json": json.dumps(contexts_data),
            "latency_ms": metrics["total_elapsed_ms"],
            "estimated_cost_usd": metrics["estimated_cost_usd"],
            "prompt_tokens": metrics["prompt_tokens"],
            "completion_tokens": metrics["completion_tokens"],
        }

    # ------------------------------------------------------------------
    # Retriever factory
    # ------------------------------------------------------------------

    def _build_retriever(self, retrieval_mode: str, embed_model: str, model_name: str):
        from retrieval.factory import build_retriever
        return build_retriever(
            mode=retrieval_mode,
            embed_model=embed_model,
            model_name=model_name,
            db=self._db,
            chroma=self._chroma,
            graph_store=self._graph_store,
            bm25_index=self._bm25,
        )

    # ------------------------------------------------------------------
    # DB helpers
    # ------------------------------------------------------------------

    def _update_run_status(
        self,
        run_id: str,
        status: str,
        completed_at: Optional[datetime] = None,
    ) -> None:
        from models_db import BenchmarkRun as BenchmarkRunModel

        try:
            run = self._db.query(BenchmarkRunModel).filter(BenchmarkRunModel.id == run_id).first()
            if run:
                run.status = status
                if completed_at:
                    run.completed_at = completed_at
                self._db.commit()
        except Exception as exc:
            logger.error("BenchmarkRunner: failed to update status to '%s': %s", status, exc)
            self._db.rollback()

    def _update_progress(self, run_id: str, completed: int) -> None:
        from models_db import BenchmarkRun as BenchmarkRunModel

        try:
            run = self._db.query(BenchmarkRunModel).filter(BenchmarkRunModel.id == run_id).first()
            if run:
                run.completed_questions = completed
                self._db.commit()
        except Exception as exc:
            logger.error("BenchmarkRunner: failed to update progress: %s", exc)
            self._db.rollback()
