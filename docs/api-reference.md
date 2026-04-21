# API Reference

All endpoints are under `http://localhost:8002/api`. The OpenAPI docs are at `/docs`.

---

## Documents

### POST /api/documents/ingest
Upload and ingest a single document.

**Form fields:**
| Field | Type | Default | Description |
|---|---|---|---|
| file | File | required | PDF, TXT, MD, DOCX, XLSX, PPTX, HTML, CSV |
| chunk_strategy | string | "fixed" | fixed, sliding, sentence, semantic, parent_child |
| chunk_size | int | 512 | Target chunk size in characters |
| chunk_overlap | int | 50 | Overlap between chunks (fixed/sliding only) |
| embed_model | string | "openai/text-embedding-3-large" | Embedding provider key |
| extract_graph | bool | false | Schedule graph extraction after ingestion |
| percentile_threshold | int | 95 | Split threshold for semantic chunking (1–99) |
| max_chunk_tokens | int | 512 | Max tokens per chunk for semantic chunking |

**Response:** `DocumentResponse` — the newly created document.

**Behavior:** Chunking and embedding (→ ChromaDB) run synchronously before the response is sent. If `extract_graph` is `true`, graph extraction is scheduled as a background task and starts after the response; its progress is visible via `GET /api/documents/{doc_id}/extract-progress`.

---

### GET /api/documents
List all ingested documents, newest first.

**Response:** Array of `DocumentResponse`:
```json
{
  "id": "uuid",
  "filename": "paper.pdf",
  "file_type": "pdf",
  "created_at": "2025-01-01T00:00:00",
  "chunk_strategy": "fixed",
  "chunk_count": 42,
  "doc_metadata": {"source": "paper.pdf", "chunk_size": 512, "chunk_overlap": 50, "embed_model": "..."},
  "graph_extracted": false,
  "embedded_count": 42,
  "embedding_errors": 0
}
```

| Field | Description |
|---|---|
| `embedded_count` | Chunks successfully upserted into ChromaDB |
| `embedding_errors` | Number of embedding batches that failed (chunks are still in SQLite) |
| `graph_extracted` | `true` once background graph extraction has completed |

---

### GET /api/documents/{doc_id}
Get a single document by ID.

**Response:** `DocumentResponse` (same shape as above).

---

### DELETE /api/documents/{doc_id}
Delete a document and all associated data.

Removes: SQLite document + chunk records, ChromaDB embeddings, BM25 index entries.

**Response:** `204 No Content`

---

### GET /api/documents/{doc_id}/chunks
Get paginated chunks for a document.

**Query params:**
| Param | Default | Description |
|---|---|---|
| page | 1 | Page number (1-based) |
| page_size | 20 | Chunks per page (max 200) |

**Response:** Array of `ChunkResponse`:
```json
{
  "id": "uuid",
  "doc_id": "uuid",
  "content": "...",
  "chunk_index": 0,
  "parent_chunk_id": null,
  "start_char": 0,
  "end_char": 512,
  "metadata": {}
}
```

---

### GET /api/documents/samples
List files available in the `raw/` sample directory.

**Response:** Array of `{filename, size_bytes, ext}` objects.

---

### POST /api/documents/ingest-samples
Ingest one or more files from the `raw/` directory without uploading.

**Request body:**
```json
{
  "filenames": ["paper1.pdf", "paper2.pdf"],
  "chunk_strategy": "fixed",
  "chunk_size": 512,
  "chunk_overlap": 50,
  "embed_model": "openai/text-embedding-3-large",
  "extract_graph": false,
  "percentile_threshold": 95,
  "max_chunk_tokens": 512
}
```

**Response:** Array of `DocumentResponse` — one per successfully ingested file. Files not found or with unsupported extensions are silently skipped. Path traversal attempts (`../`, absolute paths) are rejected.

---

### GET /api/documents/extracting
Returns doc_ids currently undergoing background graph extraction.

**Response:** plain array of strings — `["doc_id_1", "doc_id_2"]`

---

### POST /api/documents/{doc_id}/extract-graph
Schedule graph extraction for an already-ingested document (background task).

**Errors:**
- `404` if document not found
- `409` if extraction is already running for this document
- `400` if document has no chunks

**Response:** `202 Accepted`
```json
{"status": "started", "doc_id": "...", "chunk_count": 42}
```

---

### GET /api/documents/{doc_id}/extract-progress
Poll live progress of a running graph extraction.

**Response:**
```json
{
  "total": 483,
  "done": 120,
  "triples": 54,
  "status": "running",
  "wait_remaining_secs": 0.0
}
```

| Field | Description |
|---|---|
| `total` | Total chunks to process |
| `done` | Chunks fully processed so far |
| `triples` | Graph triples extracted so far |
| `status` | `"running"` or `"rate_limited"` |
| `wait_remaining_secs` | Seconds until extraction resumes after a rate-limit pause (0 when running) |

**Errors:** `404` if no extraction is currently running for this document (use this to detect completion).

---

### POST /api/documents/{doc_id}/cancel-graph
Cancel a running graph extraction for this document.

**Response:** `204 No Content`

---

## Retrieval / Query

### POST /api/query
Run a RAG query and get an answer with retrieved context.

**Request body (`QueryRequest`):**
```json
{
  "query": "What is BERT?",
  "retrieval_mode": "vector",
  "model_name": "openai/gpt-4o-mini",
  "embed_model": "openai/text-embedding-3-small",
  "top_k": 5,
  "graph_hops": 2,
  "alpha": 0.5
}
```

| Field | Description |
|---|---|
| `retrieval_mode` | `lexical`, `semantic_rerank`, `vector`, `hybrid`, `graph_rag`, `parent_child` |
| `model_name` | LLM provider key (`openai/*`, `azure/*`, `ollama/*`) |
| `embed_model` | Embedding provider key |
| `top_k` | Number of chunks to retrieve |
| `graph_hops` | Hops for `graph_rag` traversal (1–3 recommended) |
| `alpha` | Hybrid weight: 0 = pure lexical, 1 = pure vector |
| `external_connection_id` | *(optional)* ID of a registered A2A or MCP connection. When set, local retrieval is bypassed entirely. |
| `external_connection_type` | *(optional)* `"a2a"` or `"mcp"` — must match the connection type. |

When `external_connection_id` is provided:
- **A2A**: query is forwarded to the agent's task URL via JSON-RPC; the answer is returned directly
- **MCP**: an agentic tool-call loop is run against the MCP server until a final answer is produced
- `contexts` in the response will be empty; `retrieval_mode` will be `"external_a2a"` or `"external_mcp"`

**Response (`QueryResponse`):**
```json
{
  "answer": "BERT is a transformer-based model...",
  "contexts": [{"chunk_id": "...", "doc_id": "...", "content": "...", "score": 0.92, "metadata": {}}],
  "run_id": "uuid",
  "latency_ms": 1234.5,
  "tokens": {"prompt": 800, "completion": 150, "total": 950},
  "cost": 0.000142,
  "stage_timings": {"retrieval": 120.3, "generation": 1100.2},
  "retrieval_mode": "vector"
}
```

---

## Run History

### GET /api/runs
List query run history.

**Query params:** `limit` (default 50)

**Response:** Array of `RunResponse` objects.

---

### GET /api/runs/{run_id}
Get a single run by ID including full contexts.

---

## Graph

### GET /api/graph
Get the full knowledge graph (all nodes and edges).

**Query params (optional):** `doc_id`, `entity_type` — filter nodes and edges to a specific document or entity type.

**Response (`GraphResponse`):**
```json
{
  "nodes": [{"id": "bert", "label": "BERT", "type": "Technology", "doc_ids": [...], "chunk_ids": [...]}],
  "edges": [{"source": "bert", "target": "google", "predicate": "created_by", "chunk_id": "...", "confidence": 0.95, "evidence": "BERT was created by Google researchers"}]
}
```

---

### GET /api/graph/stats
Return graph summary statistics.

**Response:**
```json
{
  "node_count": 142,
  "edge_count": 287,
  "top_entities": [{"node": "BERT", "degree": 12}, ...],
  "doc_count": 5
}
```

---

### POST /api/graph/query
Graph-aware semantic search — returns nodes, edges, and chunk IDs relevant to a query.

**Request body:** `{"query": "...", "hops": 2}`

**Response:** `{"nodes": [...], "edges": [...], "chunk_ids": [...]}`

---

### DELETE /api/graph
Clear the entire graph (nodes and edges).

**Response:** `204 No Content`

---

### GET /api/graph/entity-types
List configured entity types.

**Response:** Array of `{name, color}` objects.

---

### PUT /api/graph/entity-types
Update entity type configuration.

**Request body:** `{"types": [{"name": "Person", "color": "#4f8ef7"}, ...]}`

---

### GET /api/graph/predicates
List configured predicates with their enabled/disabled state.

**Response:** Array of `{name, description, enabled}` objects.

---

### PUT /api/graph/predicates
Update predicate enabled/disabled state.

**Request body:** `{"predicates": [{"name": "uses", "description": "...", "enabled": true}, ...]}`

---

### GET /api/graph/extraction-config
Get extraction configuration.

**Response:** `{"min_confidence": 0.65, "preprocess_text": true}`

---

### PUT /api/graph/extraction-config
Update extraction configuration.

**Request body:** `{"min_confidence": 0.65, "preprocess_text": true}`

---

## Benchmarks

### GET /api/benchmarks
List all benchmark runs.

### POST /api/benchmarks
Start a benchmark run.

**Request body (`BenchmarkRunRequest`):**
```json
{
  "name": "My Benchmark",
  "question_set": [
    {"question": "What is X?", "reference_answer": "X is...", "doc_ids": ["uuid"]}
  ],
  "configs": [
    {"label": "Vector GPT-4o-mini", "retrieval_mode": "vector", "model_name": "openai/gpt-4o-mini", "embed_model": "openai/text-embedding-3-small", "top_k": 5}
  ]
}
```

### GET /api/benchmarks/{run_id}
Get a benchmark run with status and progress.

### GET /api/benchmarks/{run_id}/results
Get detailed results for each question/config pair.

**Response per result (`BenchmarkResultResponse`):**
```json
{
  "question": "...",
  "reference_answer": "...",
  "config_label": "Vector GPT-4o-mini",
  "answer": "...",
  "context_precision": 0.82,
  "answer_relevance": 0.91,
  "hit_rate": 1.0,
  "mrr": 1.0,
  "answer_correctness": 0.78,
  "faithfulness": 0.85,
  "chunks_retrieved": 5,
  "latency_ms": 1234.5,
  "estimated_cost_usd": 0.000142
}
```

### GET /api/benchmarks/session
Load the persisted benchmark lab session (question set + configs).

### PUT /api/benchmarks/session
Save the current benchmark lab session.

### GET /api/benchmarks/question-sets/default
Return the built-in default question set.

### POST /api/benchmarks/question-sets/generate
Generate questions from ingested documents using the LLM.

**Query params:** `n` (number of questions, default 10), `doc_id` (optional, limit to one document)

---

## Unified Runs

### GET /api/unified-runs
List unified runs across all domains.

**Query params:**
| Param | Type | Default | Description |
|---|---|---|---|
| domain | string | — | Filter by: orchestration, evaluation, interoperability, context_engineering, governance |
| run_type | string | — | Filter by: runtime_test, retrieval_test, benchmark_run, connection_test, agent_session |
| status | string | — | Filter by: running, completed, failed |
| limit | int | 50 | Max results |
| offset | int | 0 | Pagination offset |

**Response:** `{"runs": [UnifiedRunOut], "total": int}`

Each `UnifiedRunOut`:
```json
{
  "id": "uuid",
  "parent_run_id": null,
  "primary_domain": "orchestration",
  "run_type": "runtime_test",
  "initiated_by": "user",
  "status": "completed",
  "started_at": "2026-04-20T14:30:00",
  "ended_at": "2026-04-20T14:30:02",
  "source_id": "run-uuid",
  "source_table": "runs",
  "summary": {
    "name": "My Benchmark",
    "total_latency_ms": 1234,
    "total_tokens": 500,
    "total_cost_usd": 0.0012,
    "step_count": 2,
    "final_output": "The answer is..."
  }
}
```

---

### GET /api/unified-runs/{run_id}
Get a single unified run by ID. Returns 404 if not found.

---

### GET /api/unified-runs/{run_id}/steps
Get all RunStep records for a run, ordered by `started_at`.

**Response:** `{"steps": [RunStepOut]}`

Each `RunStepOut`:
```json
{
  "id": "uuid",
  "run_id": "uuid",
  "domain": "orchestration",
  "step_type": "retrieve_chunks",
  "component": "vector",
  "started_at": "...",
  "ended_at": "...",
  "duration_ms": 450,
  "status": "completed",
  "metrics": {"chunk_count": 5, "cost_usd": null},
  "input_summary": "Query: what is...",
  "output_summary": "5 chunks retrieved"
}
```

Step types: `retrieve_chunks`, `llm_call`, `tool_call`, `agent_handoff`, `score_answer`, `embed_query`, `api_request`

---

### GET /api/unified-runs/{run_id}/events
Get all RunEvent records for a run, ordered by `timestamp`.

**Response:** `{"events": [RunEventOut]}`

Each `RunEventOut`:
```json
{
  "id": "uuid",
  "run_id": "uuid",
  "step_id": null,
  "event_type": "llm_called",
  "category": "ai",
  "severity": "info",
  "timestamp": "...",
  "payload": {"model": "openai/gpt-4o", "prompt_tokens": 200},
  "summary": "LLM call to openai/gpt-4o: 200+150 tokens",
  "source": "retrieval"
}
```

Event categories: `execution` | `data` | `ai` | `connection` | `evaluation` | `governance`

Event types (examples): `started`, `completed`, `failed`, `chunk_selected`, `llm_called`, `a2a_sent`, `a2a_received`, `mcp_called`, `score_computed`

---

## Analytics

### GET /api/analytics/system-costs
List stored system cost entries (e.g. Claude Code CLI sessions).

**Response:** Array of `{id, date, description, model, prompt_tokens, completion_tokens, cost_usd}`

---

### POST /api/analytics/system-costs
Add a system cost entry.

**Body:**
```json
{
  "date": "2026-04-20",
  "description": "Claude Code session abc12345",
  "model": "claude-sonnet-4-6",
  "prompt_tokens": 45000,
  "completion_tokens": 8000,
  "cost_usd": 0.255
}
```

---

### DELETE /api/analytics/system-costs/{entry_id}
Remove a system cost entry by ID.

---

## Connections

### GET /api/connections
Returns the status of all exposed and consumed connections.

**Response:**
```json
{
  "exposed": [
    {
      "id": "rest_api",
      "name": "REST API",
      "protocol": "HTTP/REST",
      "status": "active",
      "description": "...",
      "endpoints": [{"label": "Base URL", "url": "http://localhost:8002/api"}]
    },
    {
      "id": "a2a",
      "name": "A2A Agent",
      "protocol": "A2A",
      "status": "active",
      "endpoints": [...],
      "methods": ["tasks/send", "message/send", ...]
    },
    {
      "id": "mcp",
      "name": "MCP Server",
      "protocol": "MCP",
      "status": "active",
      "endpoints": [
        {"label": "SSE Stream", "url": "http://localhost:8002/mcp/sse"},
        {"label": "Messages", "url": "http://localhost:8002/mcp/messages"}
      ],
      "tools": ["ask_rag_lab"]
    }
  ],
  "consumed": [
    {"id": "openai", "name": "OpenAI API", "status": "configured", "models": [...]},
    {"id": "azure_openai", "name": "Azure OpenAI", "status": "configured | not_configured"},
    {"id": "ollama", "name": "Ollama", "status": "active | unreachable | not_configured"},
    {"id": "chromadb", "name": "ChromaDB", "status": "active", "stats": {"vectors": 1234}},
    {"id": "sqlite", "name": "SQLite", "status": "active", "stats": {"documents": 5, "chunks": 420}},
    {"id": "graph_store", "name": "Graph Store", "status": "active", "stats": {"nodes": 142, "edges": 287}}
  ]
}
```

**Status values:**
| Value | Meaning |
|---|---|
| `active` | Running and reachable |
| `inactive` | Server not reachable because the tunnel is stopped (A2A and MCP only) |
| `configured` | Credentials present but not live-pinged |
| `not_configured` | Missing credentials |
| `unreachable` | Configured but ping failed (Ollama only) |
| `error` | Tunnel is running but endpoint returned an unexpected response |

---

## ngrok Tunnel

### GET /api/ngrok/status
Returns the current tunnel state.

**Response:** `{"running": true, "url": "https://abc123.ngrok-free.app"}` — `url` is `null` when not running.

### POST /api/ngrok/start
Starts an ngrok tunnel on port 8002. Polls the local ngrok API (`:4040`) until the HTTPS URL is available (up to 12 s).

**Response:** `{"running": true, "url": "https://..."}`

**Errors:** `500` if ngrok is not installed or the tunnel URL is not available within 12 s.

### POST /api/ngrok/stop
Terminates the ngrok subprocess. The effective public URL reverts to `http://localhost:8002`.

**Response:** `{"running": false, "url": null}`

---

## Registered Connections

CRUD endpoints for managing external A2A agents and MCP servers that can be used as query sources in the Playground.

### GET /api/connections/registered
Returns all registered A2A and MCP connections.

**Response:**
```json
{
  "a2a": [
    {
      "id": "uuid",
      "name": "My External Agent",
      "agent_card_url": "https://host/.well-known/agent.json",
      "task_url": "https://host/a2a",
      "description": "...",
      "skills": ["project-qa"],
      "created_at": "2026-04-04T12:00:00"
    }
  ],
  "mcp": [
    {
      "id": "uuid",
      "name": "My MCP Server",
      "server_url": "https://host/mcp",
      "description": "...",
      "tools": ["search", "lookup"],
      "created_at": "2026-04-04T12:00:00"
    }
  ]
}
```

### POST /api/connections/registered/a2a
Register an external A2A agent. Fetches the agent card to discover the task URL and skills.

**Request body:** `{"name": "My External Agent", "agent_card_url": "https://host/.well-known/agent.json"}`

**Response:** the created connection object. **Errors:** `400` if the agent card is unreachable or invalid.

### POST /api/connections/registered/mcp
Register an external MCP server. Connects to discover available tools.

**Request body:**
```json
{
  "name": "My MCP Server",
  "server_url": "https://host/mcp",
  "description": "optional",
  "transport": "sse"
}
```
`transport` is `"sse"` (default) or `"streamable_http"`.

**Response:** the created connection object, including `tools` (name list) and `tool_schemas` (full objects with `inputSchema`). **Errors:** `400` if the server is unreachable.

### DELETE /api/connections/registered/{id}
Delete a registered connection by ID (searches both A2A and MCP lists).

**Response:** `204 No Content`

### POST /api/connections/registered/{id}/test
Live-test a registered connection.

- **A2A**: sends a minimal ping task and checks for a valid JSON-RPC response
- **MCP**: connects using the registered transport and lists available tools

**Response:**
```json
{"id": "uuid", "status": "ok", "message": "MCP server reachable."}
```
`status` is `"ok"` on success or `"error"` on failure. On failure, `message` contains a human-readable reason (e.g. `"Connection timed out — the host did not respond in time."`).

### POST /api/connections/registered/{id}/call
Call a specific tool on a registered MCP server.

**Request body:**
```json
{"tool_name": "my_tool", "arguments": {"param1": "value"}}
```

**Response:**
```json
{"result": "tool output text"}
```
**Errors:** `400` if the tool call fails or the server is unreachable. `404` if the connection ID is not found (MCP only).

---

## MCP Server

The RAG Lab exposes an MCP (Model Context Protocol) server at `/mcp` using the SSE transport.

### GET /mcp/sse
SSE stream endpoint. MCP clients connect here to establish a session.

### POST /mcp/messages
Client-to-server messages endpoint. Used by the MCP client after connecting via SSE.

**Tool exposed: `ask_rag_lab`**

| Parameter | Type | Description |
|---|---|---|
| `query` | string | Any question about the RAG Lab application |

Returns a detailed text answer grounded in the project documentation. Every call is logged to the connection log (direction: inbound, type: mcp).

**Claude Desktop configuration:**
```json
{
  "mcpServers": {
    "rag-lab": {
      "transport": {"type": "sse", "url": "http://localhost:8002/mcp/sse"}
    }
  }
}
```

When exposed via ngrok, replace `http://localhost:8002` with the tunnel URL.

---

## Agent

### POST /api/agent/chat
Send a message to the RAG Lab Agent.

**Request body:**
```json
{
  "message": "What retrieval modes are available?",
  "history": [{"role": "user", "content": "..."}, {"role": "assistant", "content": "..."}]
}
```

**Response:** `{"answer": "...", "sources": [], "latency_ms": 1234.5}`

### GET /api/agent/history
Load the legacy persisted conversation (AppState). Used internally for backward compatibility.

### PUT /api/agent/history
Save the legacy conversation.

### DELETE /api/agent/history
Clear the legacy conversation.

---

## Agent Sessions

### GET /api/agent/sessions
List all sessions, sorted by `last_active` descending.

**Response:** array of `{id, name, created_at, last_active, message_count}`

### POST /api/agent/sessions
Create a new empty session with an auto-generated name.

### GET /api/agent/sessions/{id}/messages
Return the messages array for a session.

**Response:** `[{"role": "user"|"assistant", "content": "..."}, ...]`

### PUT /api/agent/sessions/{id}/messages
Overwrite all messages for a session and update `last_active`.

**Request body:** `[{"role": "...", "content": "..."}, ...]`

### PATCH /api/agent/sessions/{id}
Rename a session.

**Request body:** `{"name": "New name"}`

### DELETE /api/agent/sessions/{id}
Delete a session and all its messages.

---

## Logs

### GET /api/logs/connections
Return recent connection log entries, newest first.

**Query params:** `limit` (default 200, max 1000), `direction` (`inbound`/`outbound`/`system`), `event_type`

**Response:** array of `{id, timestamp, event_type, direction, connection_type, connection_name, connection_id, caller, summary, details, run_id}`

> **Note:** Each entry includes a `run_id` field (nullable string) linking to the associated `UnifiedRun`, if one was created for that event.

**Event types:**
| event_type | direction | Source |
|---|---|---|
| `registered` | system | Registered connection added |
| `deleted` | system | Registered connection deleted |
| `tested` | outbound | Connection test |
| `ngrok_start` | system | ngrok tunnel started |
| `ngrok_stop` | system | ngrok tunnel stopped |
| `inbound_call` | inbound | Incoming A2A or MCP tool call |
| `outbound_call` | outbound | Playground query routed to external connection |

### DELETE /api/logs/connections
Delete all connection log entries.

---

## Models / Providers

### GET /api/models
List all available models.

**Response:**
```json
{
  "llms": ["openai/gpt-4o", "openai/gpt-4o-mini", "ollama/llama3", ...],
  "embed_models": ["openai/text-embedding-3-small", "openai/text-embedding-3-large", ...],
  "rerankers": ["cross-encoder/ms-marco-MiniLM-L-6-v2", ...]
}
```

### GET /api/models/custom
Get custom model definitions (LLMs and embedding models added by the user).

### PUT /api/models/custom
Save custom model definitions.

**Request body:** `{"llms": ["..."], "embed_models": ["..."]}`

---

## Settings / AppState

### GET /api/settings
Get provider settings (API keys, endpoints).

**Response:** `{openai_api_key, azure_api_key, azure_endpoint, azure_deployment, ollama_base_url}`

### PUT /api/settings
Save provider settings.

### GET /api/settings/provider-notes
Get user-editable notes for each provider.

**Response:** `{"openai": "...", "azure": "...", "ollama": "..."}`

---

### PUT /api/settings/provider-notes
Save provider notes.

**Body:** `{"openai": "...", "azure": "...", "ollama": "..."}`

---

### GET /api/graph/entity-types
Get graph entity type configuration.

### PUT /api/graph/entity-types
Save graph entity types.

**Request body:** `{"types": [{"name": "Person", "color": "#4f8ef7"}, ...]}`
