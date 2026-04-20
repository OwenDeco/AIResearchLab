"""
MCP (Model Context Protocol) server for the RAG Lab Agent.

Exposes a single tool — ask_rag_lab — that answers any question about
the RAG Lab application using the same LLM + documentation pipeline as
the A2A endpoint.

Mounted at /mcp in main.py using the SSE transport:
  GET  /mcp/sse       — SSE stream (client connects here)
  POST /mcp/messages  — client messages

The server URL to share with MCP clients (e.g. Claude Desktop) is:
  http://localhost:8002/mcp/sse
or, when exposed via ngrok:
  https://<tunnel>/.well-known/agent.json  (A2A)
  https://<tunnel>/mcp/sse                 (MCP)
"""
from __future__ import annotations

import logging

from mcp.server.fastmcp import FastMCP

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Server definition
# ---------------------------------------------------------------------------

mcp = FastMCP(
    "RAG Lab",
    instructions=(
        "You have access to the ask_rag_lab tool. Use it to answer any question "
        "about the RAG Lab application: APIs, retrieval modes, chunking strategies, "
        "graph extraction, benchmarking, model configuration, and environment variables."
    ),
)


# ---------------------------------------------------------------------------
# Tool: ask_rag_lab
# ---------------------------------------------------------------------------

@mcp.tool()
async def ask_rag_lab(query: str) -> str:
    """
    Answer any question about the RAG Lab application.

    Covers: REST API endpoints and parameters, retrieval modes (lexical, vector,
    hybrid, graph_rag, parent_child, semantic_rerank), chunking strategies,
    graph entity/relation extraction, benchmark metrics, model providers
    (OpenAI, Azure OpenAI, Ollama), environment variables, and all frontend pages.
    Also uses registered external MCP connections as tools when relevant.

    Args:
        query: The question to answer about the RAG Lab.

    Returns:
        A detailed answer grounded in the project documentation.
    """
    from api.routes.a2a import _run_agent_async
    logger.info("MCP ask_rag_lab: %s", query[:120])
    try:
        answer = await _run_agent_async(query)
        _log_mcp_call(query, success=True)
        return answer
    except Exception as exc:
        logger.error("MCP ask_rag_lab failed: %s", exc)
        _log_mcp_call(query, success=False, error=str(exc))
        return f"Error: {exc}"


# ---------------------------------------------------------------------------
# Native data tools — served as MCP tools AND used by the agent loop
# ---------------------------------------------------------------------------

async def _list_documents_impl() -> str:
    from database import SessionLocal
    from models_db import Document
    db = SessionLocal()
    try:
        docs = db.query(Document).order_by(Document.created_at.desc()).all()
        if not docs:
            return "No documents ingested yet."
        rows = [
            f"- {d.filename} ({d.file_type}, {d.chunk_count} chunks, "
            f"graph={'yes' if d.graph_extracted else 'no'}, id={d.id[:8]})"
            for d in docs
        ]
        return f"{len(docs)} document(s):\n" + "\n".join(rows)
    finally:
        db.close()


async def _list_runs_impl(limit: int = 10) -> str:
    from database import SessionLocal
    from models_db import Run
    db = SessionLocal()
    try:
        runs = db.query(Run).order_by(Run.created_at.desc()).limit(min(limit, 50)).all()
        if not runs:
            return "No retrieval runs recorded yet."
        rows = [
            f"- [{r.created_at.strftime('%Y-%m-%d %H:%M')}] "
            f"mode={r.retrieval_mode} model={r.model_name} "
            f"latency={r.latency_ms:.0f}ms cost=${r.estimated_cost_usd:.4f} "
            f"query=\"{r.query[:60]}\" id={r.id[:8]}"
            for r in runs
        ]
        return f"Last {len(runs)} run(s):\n" + "\n".join(rows)
    finally:
        db.close()


async def _get_run_detail_impl(run_id: str) -> str:
    import json as _json
    from database import SessionLocal
    from models_db import Run
    db = SessionLocal()
    try:
        run = db.query(Run).filter(Run.id == run_id).first()
        if run is None:
            run = db.query(Run).filter(Run.id.like(run_id + "%")).first()
        if run is None:
            return f"Run '{run_id}' not found."
        stage_timings = _json.loads(run.stage_timings_json or "{}")
        lines = [
            f"Run {run.id}",
            f"  Query: {run.query}",
            f"  Mode: {run.retrieval_mode}  Model: {run.model_name}  Embed: {run.embed_model}",
            f"  Latency: {run.latency_ms:.0f}ms  Cost: ${run.estimated_cost_usd:.4f}",
            f"  Tokens: {run.prompt_tokens} prompt + {run.completion_tokens} completion",
            f"  Chunks: {run.chunk_count}  Graph nodes: {run.graph_node_count}",
        ]
        if stage_timings:
            lines.append(f"  Stage timings (ms): {_json.dumps(stage_timings)}")
        lines.append(f"  Answer: {run.answer[:500]}")
        return "\n".join(lines)
    finally:
        db.close()


async def _list_benchmarks_impl() -> str:
    from database import SessionLocal
    from models_db import BenchmarkRun
    db = SessionLocal()
    try:
        runs = db.query(BenchmarkRun).order_by(BenchmarkRun.created_at.desc()).all()
        if not runs:
            return "No benchmark runs recorded yet."
        rows = [
            f"- [{r.created_at.strftime('%Y-%m-%d %H:%M')}] "
            f"\"{r.name}\" status={r.status} "
            f"questions={r.completed_questions}/{r.total_questions} "
            f"id={r.id[:8]}"
            for r in runs
        ]
        return f"{len(runs)} benchmark run(s):\n" + "\n".join(rows)
    finally:
        db.close()


async def _get_benchmark_results_impl(benchmark_id: str) -> str:
    from database import SessionLocal
    from models_db import BenchmarkRun, BenchmarkResult
    db = SessionLocal()
    try:
        run = db.query(BenchmarkRun).filter(BenchmarkRun.id == benchmark_id).first()
        if run is None:
            run = db.query(BenchmarkRun).filter(BenchmarkRun.id.like(benchmark_id + "%")).first()
        if run is None:
            return f"Benchmark run '{benchmark_id}' not found."
        results = (
            db.query(BenchmarkResult)
            .filter(BenchmarkResult.benchmark_run_id == run.id)
            .all()
        )
        if not results:
            return f"Benchmark \"{run.name}\" has no results yet (status: {run.status})."
        by_config: dict = {}
        for r in results:
            by_config.setdefault(r.config_label, []).append(r)
        lines = [f"Benchmark: \"{run.name}\" ({run.status}, {len(results)} result(s))"]
        for cfg, items in by_config.items():
            n = len(items)
            def avg(field):
                return sum(getattr(r, field) or 0.0 for r in items) / n
            lines.append(
                f"\n  Config: {cfg} ({n} questions)"
                f"\n    MRR:                {avg('mrr'):.3f}"
                f"\n    Hit Rate:           {avg('hit_rate'):.3f}"
                f"\n    Answer Relevance:   {avg('answer_relevance'):.3f}"
                f"\n    Answer Correctness: {avg('answer_correctness'):.3f}"
                f"\n    Faithfulness:       {avg('faithfulness'):.3f}"
                f"\n    Context Precision:  {avg('context_precision'):.3f}"
                f"\n    Avg Latency:        {avg('latency_ms'):.0f}ms"
                f"\n    Avg Cost:           ${avg('estimated_cost_usd'):.4f}"
            )
        return "\n".join(lines)
    finally:
        db.close()


async def _get_analytics_summary_impl() -> str:
    from sqlalchemy import func
    from database import SessionLocal
    from models_db import Run
    db = SessionLocal()
    try:
        stats = (
            db.query(
                Run.retrieval_mode,
                func.count(Run.id).label("count"),
                func.avg(Run.latency_ms).label("avg_latency"),
                func.avg(Run.estimated_cost_usd).label("avg_cost"),
                func.sum(Run.estimated_cost_usd).label("total_cost"),
            )
            .group_by(Run.retrieval_mode)
            .all()
        )
        if not stats:
            return "No runs recorded yet."
        lines = ["Analytics summary by retrieval mode:"]
        for s in stats:
            lines.append(
                f"  {s.retrieval_mode:<22}: {s.count:4d} runs  "
                f"avg latency {(s.avg_latency or 0):.0f}ms  "
                f"avg cost ${(s.avg_cost or 0):.4f}  "
                f"total cost ${(s.total_cost or 0):.4f}"
            )
        total_runs = sum(s.count for s in stats)
        total_cost = sum(s.total_cost or 0 for s in stats)
        lines.append(f"\nTotal: {total_runs} runs, ${total_cost:.4f} estimated spend")
        return "\n".join(lines)
    finally:
        db.close()


@mcp.tool()
async def list_documents() -> str:
    """List all ingested documents with filename, type, chunk count, and graph extraction status."""
    return await _list_documents_impl()


@mcp.tool()
async def list_runs(limit: int = 10) -> str:
    """List recent retrieval runs. limit: max runs to return (default 10, max 50)."""
    return await _list_runs_impl(limit)


@mcp.tool()
async def get_run_detail(run_id: str) -> str:
    """Get full detail (query, answer, timings, cost, tokens) for a retrieval run by ID or ID prefix."""
    return await _get_run_detail_impl(run_id)


@mcp.tool()
async def list_benchmarks() -> str:
    """List all benchmark runs with name, status, question counts, and IDs."""
    return await _list_benchmarks_impl()


@mcp.tool()
async def get_benchmark_results(benchmark_id: str) -> str:
    """Get aggregated metrics (MRR, hit rate, relevance, faithfulness, latency, cost) for a benchmark run by ID or prefix."""
    return await _get_benchmark_results_impl(benchmark_id)


@mcp.tool()
async def get_analytics_summary() -> str:
    """Get analytics: run counts, avg latency, avg/total cost grouped by retrieval mode."""
    return await _get_analytics_summary_impl()


# ---------------------------------------------------------------------------
# Exports for the agent tool-calling loop
# ---------------------------------------------------------------------------

NATIVE_TOOL_SCHEMAS = [
    {
        "type": "function",
        "function": {
            "name": "list_documents",
            "description": "List all ingested documents with filename, type, chunk count, and graph extraction status.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_runs",
            "description": "List recent retrieval runs with query, mode, model, latency, and cost.",
            "parameters": {
                "type": "object",
                "properties": {
                    "limit": {
                        "type": "integer",
                        "description": "Max runs to return (default 10, max 50)",
                        "default": 10,
                    }
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_run_detail",
            "description": "Get full detail (query, answer, stage timings, cost, tokens) for a specific retrieval run by ID or ID prefix.",
            "parameters": {
                "type": "object",
                "properties": {
                    "run_id": {"type": "string", "description": "Full or partial run ID"}
                },
                "required": ["run_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_benchmarks",
            "description": "List all benchmark runs with name, status, question counts, and IDs.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_benchmark_results",
            "description": "Get aggregated metrics (MRR, hit rate, answer relevance, faithfulness, latency, cost) for a benchmark run by ID or prefix.",
            "parameters": {
                "type": "object",
                "properties": {
                    "benchmark_id": {
                        "type": "string",
                        "description": "Full or partial benchmark run ID",
                    }
                },
                "required": ["benchmark_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_analytics_summary",
            "description": "Get aggregated analytics: run counts, average latency, average and total cost grouped by retrieval mode.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
]

NATIVE_TOOL_FNS = {
    "list_documents": _list_documents_impl,
    "list_runs": _list_runs_impl,
    "get_run_detail": _get_run_detail_impl,
    "list_benchmarks": _list_benchmarks_impl,
    "get_benchmark_results": _get_benchmark_results_impl,
    "get_analytics_summary": _get_analytics_summary_impl,
}


def _log_mcp_call(query: str, success: bool, error: str = "") -> None:
    """Write a connection log entry for the MCP tool call."""
    try:
        from database import SessionLocal
        from api.conn_log import log_conn_event
        db = SessionLocal()
        try:
            log_conn_event(
                db,
                event_type="inbound_call",
                direction="inbound",
                connection_type="mcp",
                connection_name="MCP Server",
                summary=f"MCP ask_rag_lab: {query[:100]}",
                details={"query": query[:500], "success": success, "error": error},
            )
        finally:
            db.close()
    except Exception as exc:
        logger.warning("MCP: could not write connection log: %s", exc)


# ---------------------------------------------------------------------------
# ASGI app — mounted in main.py as app.mount("/mcp", mcp_sse_app)
# ---------------------------------------------------------------------------

mcp_sse_app = mcp.sse_app()
