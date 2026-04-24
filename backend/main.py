from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import AsyncGenerator

import chromadb
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from config import settings
from database import Base, SessionLocal, engine
from graph.store import GraphStore
from retrieval.bm25_index import BM25Index

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(name)s  %(message)s",
)
logger = logging.getLogger(__name__)


def _migrate_documents(engine) -> None:
    """Add new columns to documents if they don't exist yet."""
    new_columns = {
        "graph_extracted": "INTEGER DEFAULT 0 NOT NULL",
    }
    with engine.connect() as conn:
        existing = {
            row[1]
            for row in conn.execute(
                __import__("sqlalchemy").text("PRAGMA table_info(documents)")
            )
        }
        for col, col_type in new_columns.items():
            if col not in existing:
                conn.execute(
                    __import__("sqlalchemy").text(
                        f"ALTER TABLE documents ADD COLUMN {col} {col_type}"
                    )
                )
                logger.info("DB migration: added column documents.%s", col)
        conn.commit()


def _migrate_connection_logs(engine) -> None:
    """Add trace_id to connection_logs if it doesn't exist yet."""
    with engine.connect() as conn:
        existing = {
            row[1]
            for row in conn.execute(
                __import__("sqlalchemy").text("PRAGMA table_info(connection_logs)")
            )
        }
        if "trace_id" not in existing:
            conn.execute(
                __import__("sqlalchemy").text(
                    "ALTER TABLE connection_logs ADD COLUMN trace_id TEXT"
                )
            )
            logger.info("DB migration: added column connection_logs.trace_id")
        conn.commit()


def _migrate_unified_runs(engine) -> None:
    """Add run_id to connection_logs for unified run linking."""
    with engine.connect() as conn:
        existing = {
            row[1]
            for row in conn.execute(
                __import__("sqlalchemy").text("PRAGMA table_info(connection_logs)")
            )
        }
        if "run_id" not in existing:
            conn.execute(
                __import__("sqlalchemy").text(
                    "ALTER TABLE connection_logs ADD COLUMN run_id TEXT"
                )
            )
            logger.info("DB migration: added column connection_logs.run_id")
        conn.commit()


def _migrate_benchmark_results(engine) -> None:
    """Add new metric columns to benchmark_results if they don't exist yet."""
    new_columns = {
        "hit_rate": "REAL DEFAULT 0.0",
        "mrr": "REAL DEFAULT 0.0",
        "answer_correctness": "REAL DEFAULT 0.0",
        "faithfulness": "REAL DEFAULT 0.0",
        "chunks_retrieved": "INTEGER DEFAULT 0",
        "source_doc_id": "TEXT",
        "contexts_json": "TEXT",
    }
    with engine.connect() as conn:
        existing = {
            row[1]
            for row in conn.execute(
                __import__("sqlalchemy").text("PRAGMA table_info(benchmark_results)")
            )
        }
        for col, col_type in new_columns.items():
            if col not in existing:
                conn.execute(
                    __import__("sqlalchemy").text(
                        f"ALTER TABLE benchmark_results ADD COLUMN {col} {col_type}"
                    )
                )
                logger.info("DB migration: added column benchmark_results.%s", col)
        conn.commit()


# ---------------------------------------------------------------------------
# Lifespan: startup & shutdown
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """Application lifespan: initialise all shared resources on startup."""
    logger.info("Starting up AI Retrieval & Benchmark Lab …")

    # 1. Create all SQLite tables
    Base.metadata.create_all(bind=engine)
    _migrate_documents(engine)
    _migrate_benchmark_results(engine)
    _migrate_connection_logs(engine)
    _migrate_unified_runs(engine)
    logger.info("Database tables ready.")

    # 2. Init ChromaDB persistent client + collection
    chroma_client = chromadb.PersistentClient(path=settings.CHROMA_PERSIST_DIR)
    chroma_collection = chroma_client.get_or_create_collection(
        name="ragtool_chunks",
        metadata={"hnsw:space": "cosine"},
    )
    app.state.chroma_client = chroma_client
    app.state.chroma_collection = chroma_collection
    logger.info(
        "ChromaDB collection 'ragtool_chunks' ready (items: %d).",
        chroma_collection.count(),
    )

    # 3. Load / init graph store
    graph_store = GraphStore(persist_path=settings.GRAPH_DATA_PATH)
    graph_store.load()
    app.state.graph_store = graph_store
    logger.info(
        "GraphStore ready (%d nodes, %d edges).",
        graph_store.node_count,
        graph_store.edge_count,
    )

    # 4. Build BM25 index from existing DB chunks
    bm25_index = BM25Index()
    _startup_db = SessionLocal()
    try:
        bm25_index.load_from_db(_startup_db)
    finally:
        _startup_db.close()
    app.state.bm25_index = bm25_index
    logger.info("BM25Index ready.")

    logger.info("Startup complete.")

    yield  # ← application runs here

    # Shutdown
    logger.info("Shutting down …")
    try:
        graph_store.save()
        logger.info("GraphStore persisted.")
    except Exception as exc:
        logger.warning("GraphStore save failed on shutdown: %s", exc)
    logger.info("Shutdown complete.")


# ---------------------------------------------------------------------------
# FastAPI application
# ---------------------------------------------------------------------------

app = FastAPI(
    title="AI Retrieval & Benchmark Lab",
    description=(
        "Production-style RAG platform for document ingestion, "
        "multi-strategy retrieval, benchmarking, and observability."
    ),
    version="1.0.0",
    lifespan=lifespan,
)

# ---------------------------------------------------------------------------
# CORS middleware
# ---------------------------------------------------------------------------

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Accept"],
)


# ---------------------------------------------------------------------------
# MCP debug middleware — logs full req/resp for /mcp paths
# ---------------------------------------------------------------------------

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request as StarletteRequest
from starlette.responses import Response as StarletteResponse

class MCPDebugMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: StarletteRequest, call_next):
        if not request.url.path.startswith("/mcp"):
            return await call_next(request)

        body = await request.body()
        print(f"\n[MCP DEBUG] >>> {request.method} {request.url.path}", flush=True)
        print(f"[MCP DEBUG]     headers: {dict(request.headers)}", flush=True)
        print(f"[MCP DEBUG]     body:    {body.decode(errors='replace')[:2000]}", flush=True)

        response = await call_next(request)

        try:
            resp_body = b""
            async for chunk in response.body_iterator:
                resp_body += chunk
            print(f"[MCP DEBUG] <<< status={response.status_code} body={resp_body.decode(errors='replace')[:2000]}", flush=True)
            return StarletteResponse(
                content=resp_body,
                status_code=response.status_code,
                headers=dict(response.headers),
                media_type=response.media_type,
            )
        except Exception as exc:
            print(f"[MCP DEBUG] <<< status={response.status_code} (body read failed: {exc})", flush=True)
            return response

if settings.DEBUG:
    app.add_middleware(MCPDebugMiddleware)

# ---------------------------------------------------------------------------
# Routers
# ---------------------------------------------------------------------------

from api.routes.documents import router as documents_router      # noqa: E402
from api.routes.models import router as models_router            # noqa: E402
from api.routes.retrieval import router as retrieval_router      # noqa: E402
from api.routes.runs import router as runs_router                # noqa: E402
from api.routes.graph import router as graph_router              # noqa: E402
from api.routes.benchmarks import router as benchmarks_router    # noqa: E402
from api.routes.settings import router as settings_router        # noqa: E402
from api.routes.agent import router as agent_router              # noqa: E402
from api.routes.a2a import router as a2a_router                        # noqa: E402
from api.routes.connections import router as connections_router                    # noqa: E402
from api.routes.registered_connections import router as reg_connections_router    # noqa: E402
from api.routes.ngrok import router as ngrok_router                               # noqa: E402
from api.routes.logs import router as logs_router                                  # noqa: E402
from api.routes.mcp_server import mcp_sse_app                                     # noqa: E402
from api.routes.analytics import router as analytics_router                        # noqa: E402
from api.routes.unified_runs import router as unified_runs_router                  # noqa: E402
from api.routes.agent_configs import router as agent_configs_router                # noqa: E402
from api.routes.debate import router as debate_router                              # noqa: E402

app.include_router(documents_router, prefix="/api")
app.include_router(models_router, prefix="/api")
app.include_router(retrieval_router, prefix="/api")
app.include_router(runs_router, prefix="/api")
app.include_router(graph_router, prefix="/api")
app.include_router(benchmarks_router, prefix="/api")
app.include_router(settings_router, prefix="/api")
app.include_router(agent_router, prefix="/api")
app.include_router(connections_router, prefix="/api")
app.include_router(reg_connections_router, prefix="/api")
app.include_router(ngrok_router, prefix="/api")
app.include_router(logs_router, prefix="/api")
app.include_router(analytics_router, prefix="/api")
app.include_router(unified_runs_router, prefix="/api")
app.include_router(agent_configs_router, prefix="/api")
app.include_router(debate_router, prefix="/api")
app.include_router(a2a_router)           # no /api prefix — A2A lives at root
app.mount("/mcp", mcp_sse_app)           # MCP SSE transport: /mcp/sse + /mcp/messages


# ---------------------------------------------------------------------------
# Health check
# ---------------------------------------------------------------------------

@app.get("/", tags=["health"])
def health_check():
    return {"status": "ok", "version": "1.0.0"}
