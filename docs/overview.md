# AI Systems Lab — Project Overview

## What It Is

**AI Systems Lab** (v2.0) is a production-style full-stack application for ingesting documents, comparing multiple Retrieval-Augmented Generation (RAG) pipelines, running automated benchmarks, and visualizing cost/latency/quality tradeoffs. It is a research and experimentation platform — not a chatbot product.

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
  observability/    Token/cost/latency tracking; unified run/step/event recording across all execution paths
  database.py       SQLAlchemy + SQLite setup
  models_db.py      ORM models
  config.py         Settings loaded from .env
  main.py           FastAPI app entry point
docs/               This documentation (used by the AI Systems Lab Agent)
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

## ORM Models (`models_db.py`)

Key SQLAlchemy models defined in `backend/models_db.py`:

- `Document` — ingested file record (filename, chunking strategy, status)
- `Chunk` — individual text chunk linked to a document
- `Run` — a single RAG query execution (retrieval mode, model, latency, tokens, cost)
- `BenchmarkRun` / `BenchmarkResult` — benchmark session and per-question results
- `AgentSession` / `AgentMessage` — agent chat sessions and messages
- `ConnectionLog` — audit log for all connection events (A2A, MCP, system)
- `RegisteredConnection` — persisted external A2A agents and MCP servers
- `UnifiedRun` — one record per run across all domains; links to domain-specific records via `source_id`/`source_table`
- `RunStep` — individual steps within a run (retrieve_chunks, llm_call, tool_call, score_answer, etc.) with timing and metrics
- `RunEvent` — fine-grained events attached to run/step context, categorized as execution/data/ai/connection/evaluation/governance

## UI Pages

| Page | Route | Description |
|---|---|---|
| Dashboard | `/` | Run history, benchmark history, cost/latency overview |
| Document Ingestion | `/ingestion` | Upload files, select chunking strategy, inspect chunks |
| Runtime Playground | `/playground` | Query interface, choose retrieval mode + model, inspect context + answer |
| Benchmark Lab | `/benchmark` | Define question sets, run multi-config benchmarks, compare results |
| Graph Explorer | `/graph` | Interactive entity/relation visualization |
| Analytics | `/analytics` | Filter and compare cost, latency, quality by model/mode/strategy/date |
| Settings | `/settings` | Provider API keys, agent toggles, custom model IDs |
| Connections | `/connections` | Exposed protocols, consumed services, ngrok tunnel, registered connections |
| Agent | `/agent` | Full-page chat with the AI Systems Lab Agent, persistent sessions |
| Logs | `/logs` | Audit trail for all connection events |
| Runs | `/runs` | Cross-domain run browser with domain/type/status filters, step timeline, and event log |
| Agents | `/agents` | Create and manage named agent configs; chat with any agent; configure RAG, tools, and sub-agents |
| Agent Flow | `/flow` | Force-directed graph of all agents, MCP servers, and A2A connections; drag-to-persist layout |
| Pixel Simulator | `/orchestration-simulator` | Pixel-art orchestration simulator (Agent Simulation mode) and Debate Room mode |

## Running the Application

```
# Backend (from backend/)
python -m uvicorn main:app --host 127.0.0.1 --port 8002 --reload

# Frontend (from frontend/)
npm run dev          # dev server on port 5173
npm run build        # production build to dist/
```

There is a desktop launcher: `AI Systems Lab.bat` on the desktop starts both servers and opens the browser.

## Exposed Protocols

The AI Systems Lab exposes its agent capability over three protocols simultaneously:

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
