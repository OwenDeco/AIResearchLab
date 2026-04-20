# RAG Lab — Project Overview

## What It Is

**RAG Lab** is a production-style full-stack application for ingesting documents, comparing multiple Retrieval-Augmented Generation (RAG) pipelines, running automated benchmarks, and visualizing cost/latency/quality tradeoffs. It is a research and experimentation platform — not a chatbot product.

## Architecture

```
frontend/           React + Vite UI (port 5173 in dev, served from dist/ in prod)
backend/
  api/              FastAPI routes (port 8002)
  ingestion/        Document loading + chunking pipeline
  chunking/         Five chunking strategies
  retrieval/        Six retrieval modes
  graph/            Entity/relation extraction + NetworkX graph store
  models/           LLM, embedding, and reranker provider abstraction
  benchmarking/     Benchmark run orchestration
  evaluation/       Quality metric computation
  observability/    Token/cost/latency tracking
  database.py       SQLAlchemy + SQLite setup
  models_db.py      ORM models
  config.py         Settings loaded from .env
  main.py           FastAPI app entry point
docs/               This documentation (used by the RAG Lab Agent)
  raw/                Sample documents for lab ingestion
```

## Technology Stack

| Layer | Technology |
|---|---|
| Backend framework | FastAPI (Python) |
| Frontend framework | React + Vite + TypeScript |
| Database | SQLite via SQLAlchemy (default) |
| Vector store | ChromaDB (local persistence) |
| Graph store | NetworkX in-memory + JSON persistence |
| State management (frontend) | Zustand |
| HTTP client (frontend) | Axios via `src/api/client.ts` |
| Styling | Tailwind CSS |
| Charts | Recharts |
| Graph visualization | react-force-graph-2d |

## Running the Application

```
# Backend (from backend/)
python -m uvicorn main:app --host 127.0.0.1 --port 8002 --reload

# Frontend (from frontend/)
npm run dev          # dev server on port 5173
npm run build        # production build to dist/
```

There is a desktop launcher: `RAG Lab.bat` on the desktop starts both servers and opens the browser.

## Exposed Protocols

The RAG Lab exposes its agent capability over three protocols simultaneously:

| Protocol | Endpoint | Purpose |
|---|---|---|
| REST API | `http://localhost:8002/api` | Full RAG/document/benchmark API |
| A2A | `http://localhost:8002/a2a` | Agent-to-Agent (JSON-RPC 2.0) for AI orchestrators |
| MCP | `http://localhost:8002/mcp/sse` | Model Context Protocol for Claude Desktop and MCP clients |

All three can be exposed publicly via the built-in ngrok tunnel panel on the Connections page.

## Key Design Principles

- All models (LLM, embeddings, reranker) are swappable via UI — no hardcoding
- Every query run records: latency, token usage, estimated cost, stage timings, model/provider, chunk/node counts
- Graph RAG is first-class — not optional or mocked
- The system runs fully locally after setting env vars; cloud providers are optional
- Six retrieval modes are all available and comparable in benchmarks
- Rate limits from OpenAI are handled with exact Retry-After sleep (not fixed-interval backoff)
