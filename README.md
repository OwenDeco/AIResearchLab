# AI Retrieval & Benchmark Lab

A production-style RAG platform for document ingestion, multi-strategy retrieval, knowledge-graph construction, benchmarking, and observability. Run everything locally — no cloud required — or connect to OpenAI / Azure OpenAI.

---

## Features

| Feature | What it does |
|---|---|
| **6 Retrieval Modes** | Lexical (BM25), Semantic Reranking, Vector, Hybrid, Graph RAG, Parent-Child |
| **Document Ingestion** | Upload PDF, TXT, MD, DOCX; 6 chunking strategies; per-chunk embeddings |
| **Knowledge Graph** | LLM-powered entity/relation extraction; NetworkX DiGraph; interactive force-directed visualiser |
| **Benchmark Lab** | Define question sets, run multi-config comparisons, measure hit rate, MRR, faithfulness, correctness |
| **Analytics** | Filter/compare runs by model, mode, date; latency/cost/quality charts |
| **Agent Chat** | Multi-session chat with access to MCP tools and registered A2A agents |
| **A2A Protocol** | Exposes and consumes external A2A agents; dynamic agent card with skills |
| **MCP Server** | Exposes RAG Q&A as an MCP tool via SSE and Streamable HTTP transports |
| **Registered Connections** | Register and test external A2A agents and MCP servers; route Playground queries to them |
| **ngrok Integration** | One-click tunnel to expose A2A/MCP endpoints; public URL auto-saved |
| **Settings UI** | Manage API keys (masked), custom model names, public base URL — no `.env` editing needed at runtime |

---

## Stack

| Layer | Technology |
|---|---|
| API server | FastAPI (Python) |
| Vector store | ChromaDB (embedded, persistent) |
| Keyword index | rank-bm25 |
| Knowledge graph | NetworkX DiGraph + JSON persistence |
| Relational store | SQLite via SQLAlchemy (Postgres-compatible via `DATABASE_URL`) |
| LLMs & Embeddings | OpenAI / Azure OpenAI / Ollama |
| Reranker | sentence-transformers `cross-encoder/ms-marco-MiniLM-L-6-v2` (local) |
| Frontend | React 18 + Vite + Tailwind CSS |
| MCP | `mcp` Python package (SSE + Streamable HTTP) |

---

## Quick Start (Local Dev)

### Prerequisites

- **Python 3.10+**
- **Node.js 18+**
- **Git**
- *(Optional)* [Ollama](https://ollama.com) for local LLMs

### 1. Clone the repo

```bash
git clone https://github.com/YOUR_USERNAME/ragtool.git
cd ragtool
```

### 2. Configure environment

```bash
cp backend/.env.example backend/.env
```

Open `backend/.env` and set at minimum:

```ini
OPENAI_API_KEY=sk-proj-...   # Required for GPT models and OpenAI embeddings
```

Everything else has sensible defaults. Ollama works out of the box if running locally — no API key needed.

### 3. Install backend dependencies

```bash
cd backend
pip install -r requirements.txt
```

Download required NLTK data (one-time):

```bash
python -c "import nltk; nltk.download('punkt'); nltk.download('punkt_tab'); nltk.download('stopwords')"
```

### 4. Start the backend

```bash
uvicorn main:app --host 0.0.0.0 --port 8002 --reload
```

- API: `http://localhost:8002`
- Swagger UI: `http://localhost:8002/docs`

### 5. Install and start the frontend

```bash
cd ../frontend
npm install
npm run dev
```

- UI: `http://localhost:5173`

---

## Docker

Build and run everything with Docker Compose:

```bash
cp backend/.env.example backend/.env
# Edit backend/.env and add your API key(s)

docker compose up --build
```

| Service | URL |
|---|---|
| Frontend | `http://localhost:5173` |
| Backend API | `http://localhost:8002` |
| Swagger UI | `http://localhost:8002/docs` |

To run in detached mode:

```bash
docker compose up --build -d
docker compose logs -f          # stream logs
docker compose down             # stop
```

---

## Local LLMs with Ollama

If you want to run without any cloud API keys:

```bash
# Install Ollama: https://ollama.com
ollama pull llama3.2            # fast, good quality
ollama pull nomic-embed-text    # embedding model
```

Then in the UI, select `ollama/llama3.2` as LLM and `ollama/nomic-embed-text` as embedding model. No API key required.

Other supported Ollama models: `llama3.3`, `mistral`, `qwen2.5`, `phi4`, `deepseek-r1`, `mxbai-embed-large`, `bge-m3`.

---

## Usage Guide

### Ingest Documents

1. Open the **Document Ingestion** page
2. Drag and drop or select PDF / TXT / MD / DOCX files (max 100 MB each)
3. Choose a chunking strategy:
   - **Fixed size** — chunks of N characters with optional overlap
   - **Sliding window** — overlapping windows for dense coverage
   - **Sentence** — splits on sentence boundaries
   - **Paragraph** — splits on blank lines
   - **Semantic** — groups sentences by embedding similarity (requires embedding model)
   - **Parent-child** — creates small child chunks + large parent chunks
4. Click **Ingest** — embeddings are computed and stored immediately
5. *(Optional)* Click **Extract Graph** to run LLM entity/relation extraction

### Query the Playground

1. Open the **Retrieval Playground**
2. Enter a question
3. Choose:
   - **Retrieval mode**: lexical / vector / hybrid / semantic_rerank / graph_rag / parent_child
   - **LLM**: any configured model
   - **Embedding model**: any configured model
   - **Top-k**: number of chunks to retrieve
4. Click **Ask** — see the answer, retrieved context, latency, and estimated cost
5. Each query is saved to Run History

To route a query to a registered external A2A agent or MCP server instead of local retrieval, toggle **Use registered connection** and select from the dropdown.

### Run Benchmarks

1. Open the **Benchmark Lab**
2. Create or auto-generate a question set (questions + reference answers)
3. Add one or more configurations (retrieval mode + LLM combinations)
4. Click **Run** — results appear as they complete
5. Compare hit rate, MRR, answer correctness, faithfulness side-by-side

### Knowledge Graph

1. After ingesting documents, go to **Graph Explorer**
2. Run **Extract Graph** on the Ingestion page (uses LLM — costs tokens)
3. Browse the interactive force-directed graph
4. Click nodes/edges to see entity details and source chunks
5. Filter by document or entity type

### Register External Connections

In the **Connections** page, under **Registered Connections**:

**A2A Agent:**
```
Name: My Agent
Agent Card URL: http://other-host/.well-known/agent.json
```
The task URL and skills are extracted automatically from the agent card.

**MCP Server:**
```
Name: My MCP Server
Server URL: http://other-host/mcp
Transport: SSE  (or Streamable HTTP)
```
Available tools are discovered at registration time.

Use the **Test** button on each card to send a live ping.

### Expose via ngrok

In the **Connections** page, under **Exposed**:

1. Click **Start tunnel** — a public ngrok URL is created and saved
2. The A2A agent card at `<ngrok-url>/.well-known/agent.json` is now reachable by other agents
3. The MCP server at `<ngrok-url>/mcp/sse` is reachable by MCP clients
4. The tunnel URL is auto-saved as the Public Base URL so it persists after stopping

Prerequisites:
```bash
# Install ngrok: https://ngrok.com
ngrok config add-authtoken YOUR_AUTHTOKEN
```

---

## API Reference

Full API docs: `http://localhost:8002/docs`

Key endpoint groups:

| Prefix | Description |
|---|---|
| `POST /api/documents/upload` | Upload and ingest a document |
| `GET /api/documents` | List all documents |
| `POST /api/retrieval/query` | Run a retrieval + generation query |
| `GET /api/runs` | Query run history |
| `GET /api/benchmarks` | List benchmark runs |
| `POST /api/benchmarks/run` | Start a benchmark run |
| `GET /api/graph/stats` | Graph node/edge counts |
| `POST /api/graph/extract` | Start LLM entity extraction |
| `GET /api/models/available` | List available LLM + embedding models |
| `GET /api/settings` | Get current settings (API keys masked) |
| `PUT /api/settings` | Update settings / API keys |
| `GET /api/connections/registered` | List registered A2A + MCP connections |
| `POST /api/connections/registered/a2a` | Register an external A2A agent |
| `POST /api/connections/registered/mcp` | Register an external MCP server |
| `POST /api/ngrok/start` | Start ngrok tunnel |
| `POST /api/ngrok/stop` | Stop ngrok tunnel |
| `POST /a2a` | A2A endpoint (inbound tasks from external agents) |
| `GET /.well-known/agent.json` | A2A agent card |
| `/mcp/sse` | MCP SSE transport |
| `/mcp` | MCP Streamable HTTP transport |

---

## Configuration

All variables go in `backend/.env`. See `backend/.env.example` for a full template.

| Variable | Default | Description |
|---|---|---|
| `OPENAI_API_KEY` | — | OpenAI API key |
| `AZURE_OPENAI_API_KEY` | — | Azure OpenAI key |
| `AZURE_OPENAI_ENDPOINT` | — | Azure endpoint URL |
| `AZURE_OPENAI_DEPLOYMENT` | — | Azure deployment name |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama server URL |
| `DATABASE_URL` | `sqlite:///./ragtool.db` | SQLAlchemy DB URL |
| `CHROMA_PERSIST_DIR` | `./chroma_data` | ChromaDB storage directory |
| `GRAPH_DATA_PATH` | `./graph_data.json` | NetworkX graph JSON file |
| `DEFAULT_LLM` | `openai/gpt-4o-mini` | Default LLM |
| `DEFAULT_EMBED_MODEL` | `openai/text-embedding-3-small` | Default embedding model |
| `AGENT_BASE_URL` | `http://localhost:8002` | Public base URL for A2A agent card |
| `DEBUG` | `false` | Enable verbose MCP request/response logging |

API keys can also be set and updated at runtime through the **Settings** page — no restart required.

---

## Custom Models

Add any model name following the `provider/model-name` convention via the **Settings** page or:

```http
PUT /api/models/custom
{
  "llms": ["openai/gpt-4-turbo", "ollama/llama3.1:70b"],
  "embed_models": ["openai/text-embedding-ada-002"]
}
```

Custom models appear in all dropdowns immediately.

---

## Retrieval Modes

| Mode | Key | Description |
|---|---|---|
| Lexical | `lexical` | BM25 keyword search |
| Semantic Reranking | `semantic_rerank` | BM25 candidates → cross-encoder reranker |
| Vector | `vector` | ChromaDB cosine similarity |
| Hybrid | `hybrid` | BM25 + vector with configurable alpha (0–1) |
| Graph RAG | `graph_rag` | Entity extraction → multi-hop graph traversal → chunks |
| Parent-Child | `parent_child` | Small child retrieval → large parent context |

---

## Project Structure

```
ragtool/
├── backend/
│   ├── api/routes/         # FastAPI route handlers
│   ├── chunking/           # Chunking strategies
│   ├── connections/        # A2A client, MCP client
│   ├── evaluation/         # Answer quality metrics
│   ├── graph/              # Entity extraction, GraphStore
│   ├── ingestion/          # Document loading + ingest pipeline
│   ├── models/             # LLM/embedding/reranker provider registry
│   ├── observability/      # Token usage, cost, latency tracking
│   ├── retrieval/          # BM25, vector, hybrid, graph, parent-child
│   ├── config.py           # Pydantic Settings (loads .env)
│   ├── database.py         # SQLAlchemy models + session
│   ├── main.py             # FastAPI app, middleware, routers
│   └── requirements.txt
├── frontend/
│   ├── src/
│   │   ├── api/            # Axios API client
│   │   ├── components/     # Shared UI components
│   │   └── pages/          # Dashboard, Ingestion, Playground, etc.
│   └── package.json
├── docs/                   # Feature documentation
├── docker-compose.yml
└── README.md
```

---

## Security Notes

- API keys are **never returned in plain text** from the API — GET responses return masked values (`sk-...XXXX`).
- The `DEBUG=true` setting enables verbose MCP logging that includes full request/response bodies. Leave it `false` in production.
- When using ngrok, your A2A and MCP endpoints become publicly accessible. Rotate your ngrok authtoken if you suspect it was exposed.
- File uploads are limited to **100 MB** per file.
- External A2A/MCP URLs are validated to prevent SSRF — only `http://` and `https://` schemes are accepted.

---

## License

MIT — see [LICENSE](LICENSE).
