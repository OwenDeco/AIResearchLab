from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Dict, List

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import text
from sqlalchemy.orm import Session

from api.deps import get_db
from config import settings

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/connections", tags=["connections"])

def get_effective_base_url() -> str:
    """Return the active ngrok tunnel URL, or localhost fallback."""
    from api.routes.ngrok import _is_running, _url as ngrok_url
    if _is_running() and ngrok_url:
        return ngrok_url
    return "http://localhost:8002"


def _check_ollama() -> str:
    """Ping Ollama base URL. Returns 'active', 'unreachable', or 'not_configured'."""
    if not settings.OLLAMA_BASE_URL:
        return "not_configured"
    try:
        r = httpx.get(f"{settings.OLLAMA_BASE_URL}/api/tags", timeout=2.0)
        return "active" if r.status_code == 200 else "error"
    except Exception:
        return "unreachable"


def _check_a2a() -> str:
    """Ping the agent card URL to verify the A2A endpoint is reachable."""
    from api.routes.ngrok import _is_running
    if not _is_running():
        return "inactive"
    base = get_effective_base_url().rstrip("/")
    try:
        r = httpx.get(f"{base}/.well-known/agent.json", timeout=3.0)
        return "active" if r.status_code == 200 else "error"
    except Exception:
        return "error"


def _check_openai() -> str:
    if settings.OPENAI_API_KEY:
        return "configured"
    return "not_configured"


def _check_azure() -> str:
    if settings.AZURE_OPENAI_API_KEY and settings.AZURE_OPENAI_ENDPOINT and settings.AZURE_OPENAI_DEPLOYMENT:
        return "configured"
    return "not_configured"


@router.get("")
def get_connections(request: Request):
    base = get_effective_base_url().rstrip("/")

    # ----------------------------------------------------------------
    # Counts from shared app state
    # ----------------------------------------------------------------
    graph_store = getattr(request.app.state, "graph_store", None)
    chroma = getattr(request.app.state, "chroma_collection", None)

    node_count = graph_store.node_count if graph_store else 0
    edge_count = graph_store.edge_count if graph_store else 0
    chroma_count = chroma.count() if chroma else 0

    # Doc + chunk counts from DB
    doc_count = 0
    chunk_count = 0
    try:
        from database import SessionLocal
        _db = SessionLocal()
        try:
            doc_count = _db.execute(text("SELECT COUNT(*) FROM documents")).scalar() or 0
            chunk_count = _db.execute(text("SELECT COUNT(*) FROM chunks")).scalar() or 0
        finally:
            _db.close()
    except Exception:
        pass

    # ----------------------------------------------------------------
    # Network status checks — run concurrently to avoid sequential timeouts
    # ----------------------------------------------------------------
    with ThreadPoolExecutor(max_workers=2) as pool:
        f_a2a    = pool.submit(_check_a2a)
        f_ollama = pool.submit(_check_ollama)
        openai_status = _check_openai()   # instant (no network)
        azure_status  = _check_azure()    # instant (no network)
    a2a_status    = f_a2a.result()
    mcp_status    = a2a_status  # MCP lives on the same server as A2A
    ollama_status = f_ollama.result()

    # ----------------------------------------------------------------
    # Exposed connections
    # ----------------------------------------------------------------
    exposed: List[Dict[str, Any]] = [
        {
            "id": "rest_api",
            "name": "REST API",
            "protocol": "HTTP/REST",
            "status": "active",
            "description": "Full OpenAPI-documented REST interface for all RAG Lab features.",
            "endpoints": [
                {"label": "Base URL", "url": "http://localhost:8002/api"},
                {"label": "OpenAPI docs", "url": "http://localhost:8002/docs"},
            ],
        },
        {
            "id": "a2a",
            "name": "A2A Agent",
            "protocol": "A2A",
            "status": a2a_status,
            "description": "Agent-to-Agent protocol endpoint. Exposes the RAG Lab Agent as a callable skill for other AI agents and orchestrators.",
            "endpoints": [
                {"label": "Agent Card", "url": f"{base}/.well-known/agent.json"},
                {"label": "Agent Card (alias)", "url": f"{base}/.well-known/agent-card.json"},
                {"label": "Task Endpoint", "url": f"{base}/a2a"},
            ],
            "methods": ["tasks/send", "tasks/sendSubscribe", "tasks/get", "tasks/cancel",
                        "message/send", "message/stream", "message/get", "message/cancel"],
        },
        {
            "id": "mcp",
            "name": "MCP Server",
            "protocol": "MCP",
            "status": mcp_status,
            "description": "Model Context Protocol server. Exposes the ask_rag_lab tool to Claude Desktop, Claude.ai, and other MCP-compatible clients.",
            "endpoints": [
                {"label": "SSE Stream", "url": f"{base}/mcp/sse"},
                {"label": "Messages", "url": f"{base}/mcp/messages"},
            ],
            "tools": ["ask_rag_lab"],
        },
    ]

    # ----------------------------------------------------------------
    # Consumed connections
    # ----------------------------------------------------------------
    consumed: List[Dict[str, Any]] = [
        {
            "id": "openai",
            "name": "OpenAI API",
            "protocol": "HTTP/REST",
            "status": openai_status,
            "description": "LLM completions (GPT-4o, GPT-4o-mini, etc.) and text embeddings.",
            "endpoints": [{"label": "API Base", "url": "https://api.openai.com/v1"}],
            "models": ["gpt-4o", "gpt-4o-mini", "text-embedding-3-small", "text-embedding-3-large"],
        },
        {
            "id": "azure_openai",
            "name": "Azure OpenAI",
            "protocol": "HTTP/REST",
            "status": azure_status,
            "description": "Azure-hosted OpenAI models for LLM and embeddings.",
            "endpoints": [
                {"label": "Endpoint", "url": settings.AZURE_OPENAI_ENDPOINT or "—"},
            ],
            "models": [settings.AZURE_OPENAI_DEPLOYMENT] if settings.AZURE_OPENAI_DEPLOYMENT else [],
        },
        {
            "id": "ollama",
            "name": "Ollama",
            "protocol": "HTTP/REST",
            "status": ollama_status,
            "description": "Local LLM and embedding inference server.",
            "endpoints": [{"label": "Base URL", "url": settings.OLLAMA_BASE_URL}],
            "models": ["llama3.3", "mistral", "nomic-embed-text"],
        },
        {
            "id": "chromadb",
            "name": "ChromaDB",
            "protocol": "Local",
            "status": "active",
            "description": "Local vector store for chunk embeddings. Persisted to disk.",
            "endpoints": [{"label": "Persist Dir", "url": settings.CHROMA_PERSIST_DIR}],
            "stats": {"vectors": chroma_count},
        },
        {
            "id": "sqlite",
            "name": "SQLite",
            "protocol": "Local",
            "status": "active",
            "description": "Local relational database for documents, chunks, runs, and benchmarks.",
            "endpoints": [{"label": "Database", "url": settings.DATABASE_URL}],
            "stats": {"documents": doc_count, "chunks": chunk_count},
        },
        {
            "id": "graph_store",
            "name": "Graph Store",
            "protocol": "Local",
            "status": "active",
            "description": "In-memory NetworkX knowledge graph with JSON persistence.",
            "endpoints": [{"label": "Persist File", "url": settings.GRAPH_DATA_PATH}],
            "stats": {"nodes": node_count, "edges": edge_count},
        },
    ]

    return {"exposed": exposed, "consumed": consumed}


@router.get("/agent-card")
def get_agent_card():
    """Return the A2A agent card as a structured object (same as /.well-known/agent.json)."""
    from api.routes.a2a import _agent_card
    return _agent_card()
