# A2A (Agent-to-Agent) Protocol

The AI Systems Lab Agent is exposed as an A2A-compatible agent, allowing other AI agents and orchestrators to discover and call it using the [A2A protocol](https://google.github.io/A2A/).

---

## Discovery

The Agent Card is served at:
```
GET http://localhost:8002/.well-known/agent.json
```

It describes the agent's name, capabilities, skills, and the URL of the task endpoint. Any A2A-compatible client (Google ADK, LangGraph, custom agents) can fetch this to learn how to call the agent.

---

## Agent Card

```json
{
  "name": "RAG Lab Agent",
  "description": "Documentation-grounded Q&A agent for the RAG Lab platform. Ask it anything about the project — features, REST APIs, configuration, retrieval modes, chunking, graph extraction, benchmarking, and model providers...",
  "url": "http://localhost:8002/a2a",
  "version": "1.0.0",
  "capabilities": {
    "streaming": true,
    "pushNotifications": false,
    "stateTransitionHistory": false
  },
  "authentication": { "schemes": ["None"] },
  "defaultInputModes": ["text/plain"],
  "defaultOutputModes": ["text/plain"],
  "skills": [
    {
      "id": "project-qa",
      "name": "Project Q&A",
      "description": "Answer questions about the RAG Lab platform — features, REST APIs, configuration, retrieval modes, chunking, graph extraction, benchmarking, and model providers — grounded in the project's own documentation.",
      "tags": ["qa", "documentation"],
      "examples": ["What retrieval modes are available?", "How does Graph RAG work?", "Which environment variables are required?"]
    }
  ]
}
```

**The `skills` list is a single static `project-qa` skill.** The card advertises exactly one capability — documentation-grounded Q&A about the platform. It deliberately does **not** advertise registered external MCP/A2A connections, nor the internal native data skills (`list_documents`, `list_runs`, `get_run_detail`, `list_benchmarks`, `get_benchmark_results`, `get_analytics_summary`), so external A2A clients (e.g. OutSystems) see one clear capability: ask questions about the project.

### Inbound A2A execution is documentation-grounded Q&A

Inbound A2A requests (`tasks/send` and `tasks/sendSubscribe` on `POST /a2a`) run the agent loop in **`platform_only` mode** (`_run_agent_loop(..., platform_only=True)`):

- **No tools** are exposed to the LLM — no native data tools, no registered MCP servers, no external A2A agents. The agent answers purely from the project documentation loaded into the system prompt.
- The knowledge source is **all git-tracked Markdown across the whole repository** (`README.md`, `docs/*.md`, `outsystems/README.md`, …), assembled by `_doc_files()` in `agent.py`. Files matched by `.gitignore` are filtered out via `git ls-files` (tracked-only) plus `git check-ignore`, so sensitive files — `.env`, `CLAUDE.md`, `CHANGELOG.md`, `tasks/`, the internal `.txt` specs — are **never** exposed. Sample-data fixtures under `backend/data/` are also excluded. If git is unavailable, it falls back to the curated `docs/` folder + `README.md`.
- Inbound A2A uses the **compact doc partition** (`compact_docs=True` → `_COMPACT_DOC_NAMES` in `agent.py`): the seven core platform docs (`overview`, `configuration`, `chunking`, `retrieval`, `models`, `graph`, `benchmarking`) — **~9k tokens per call instead of ~30k** — so bursts of simultaneous callers don't exhaust provider TPM limits. The UI System Agent keeps the full doc set.
- It uses the same **System Agent prompt** (`_build_system_prompt()`) as the UI System Agent: it answers questions about the platform's features/config/APIs and declines questions about ingested user data.
- Answers are **plain prose, not Markdown** (`_A2A_PLAIN_STYLE` in `a2a.py`): the card advertises `text/plain` output and external callers typically render the artifact text raw, so the model is instructed to reply in one short paragraph with no headers, lists, bold markers, or line breaks. The UI System Agent still answers in Markdown (the web UI renders it).

### Concurrency

The tool-less inbound path is built to survive a burst of simultaneous callers (e.g. a live demo):

- The blocking LLM provider call runs in a worker thread (`asyncio.to_thread`), so one in-flight request never blocks the event loop for the others.
- An `asyncio.Semaphore(4)` (`_LLM_MAX_CONCURRENCY` in `a2a.py`) caps in-flight LLM calls, so a burst is served in waves instead of triggering a provider 429 storm.
- Measured with `AGENT_MODEL=openai/gpt-4o-mini`: **20 simultaneous `tasks/send` requests → 20/20 answered**, median ~14s, worst ~22s, no rate-limit errors.

This mode matches the UI System Agent (`platform_only=True`). The Playground agent and the exposed MCP-server tool (`_run_agent_async(query)` in `mcp_server.py`) are unchanged and still have their normal tool sets (native data tools + registered MCP/A2A connections).

The `url` field is derived from the effective public base URL, computed at request time with this priority: (1) custom URL saved by the user in the database, (2) active ngrok tunnel URL, (3) `http://localhost:8002`. No in-memory state is involved — the correct URL is always used regardless of tunnel start/stop order.

---

## Task Endpoint

```
POST http://localhost:8002/a2a
Content-Type: application/json
```

Uses JSON-RPC 2.0 over HTTP. Supported methods:

| Method | Transport | Description |
|---|---|---|
| `tasks/send` | HTTP response | Synchronous — blocks until answer is ready, returns completed Task |
| `tasks/sendSubscribe` | SSE stream | Streaming — emits working → artifact → completed events |
| `tasks/get` | HTTP response | Retrieve a task by ID (ephemeral, process-lifetime only) |
| `tasks/cancel` | HTTP response | Cancel a task (no-op if already completed) |
| `message/send` | HTTP response | Alias for `tasks/send` (alternate method name) |
| `message/stream` | SSE stream | Alias for `tasks/sendSubscribe` |

---

## tasks/send — Example

**Request:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tasks/send",
  "params": {
    "id": "task-abc123",
    "message": {
      "role": "user",
      "parts": [{ "type": "text", "text": "What retrieval modes are available?" }]
    }
  }
}
```

**Response:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "id": "task-abc123",
    "status": { "state": "completed" },
    "artifacts": [{
      "parts": [{ "type": "text", "text": "Six retrieval modes are available: lexical, semantic_rerank, vector, hybrid, graph_rag, parent_child..." }],
      "index": 0,
      "lastChunk": true
    }]
  }
}
```

---

## tasks/sendSubscribe — SSE Stream

Same request body with `"method": "tasks/sendSubscribe"`. Returns `text/event-stream`.

Each SSE event is a full JSON-RPC response frame:

```
data: {"jsonrpc":"2.0","id":1,"result":{"id":"task-abc123","status":{"state":"working"},"final":false}}

data: {"jsonrpc":"2.0","id":1,"result":{"id":"task-abc123","artifact":{"parts":[{"type":"text","text":"Six retrieval modes..."}],"index":0,"lastChunk":true},"final":false}}

data: {"jsonrpc":"2.0","id":1,"result":{"id":"task-abc123","status":{"state":"completed"},"final":true}}
```

---

## Error Codes

| Code | Meaning |
|---|---|
| -32700 | Parse error (invalid JSON) |
| -32601 | Method not found |
| -32602 | Invalid params (e.g., empty message) |
| -32001 | Task not found |

## Registering External A2A Agents

When registering an external A2A agent via `POST /api/connections/registered/a2a`, connection errors are returned as human-readable HTTP 400 messages:

| Situation | Error message |
|---|---|
| Host does not respond | `Connection timed out — the host did not respond in time.` |
| Connection refused / unreachable | `Could not connect — host unreachable or refused the connection.` |
| HTTP error from server | `HTTP 404 from server.` |
| Agent card missing `url` field | `Agent card does not contain a 'url' field.` |

The test endpoint (`POST /api/connections/registered/{id}/test`) returns the same human-readable message in the `message` field on failure.

---

## Distributed Trace Logging

Every A2A request generates a `trace_id` (UUID) at the moment the inbound call arrives. All subsequent log entries for that request carry the same `trace_id`, giving a complete waterfall in the Logs page:

| Event | Direction | When |
|---|---|---|
| `inbound_call` | inbound | Request hits `/a2a` |
| `llm_tool_selection` | internal | Agent calls the LLM to pick a tool (once per iteration) |
| `tool_chosen` | internal | LLM returns tool calls — lists which tools were selected |
| `mcp_tool_call` | outbound | Agent sends request to MCP server |
| `mcp_tool_response` | inbound | MCP server returns result |
| `native_tool_call` | internal | Agent calls a built-in native tool |
| `outbound_response` | outbound | Final answer sent back to caller |

Click any **Trace** badge in the Logs page to filter the table to that single request.

Filter by trace ID via API: `GET /api/logs/connections?trace_id=<uuid>`

---

## Synthesis Mode

By default the agent runs a second LLM call after tool execution to produce a natural-language answer (`A2A_SYNTHESIZE=true`). When the caller has its own LLM for synthesis (e.g. OutSystems), this round-trip can be skipped:

```
A2A_SYNTHESIZE=false
```

When disabled, the raw tool result text is returned directly as the task artifact. Configurable from **Settings → Agent** in the UI without a restart.

> **Note:** `A2A_SYNTHESIZE` has **no effect on inbound A2A requests**, which now run tool-less in `platform_only` mode (documentation-grounded Q&A) and always return a single natural-language answer. The setting still applies to the general agent loop used by the Playground and the exposed MCP-server tool.

---

## Configuration

| Variable | Default | Description |
|---|---|---|
| `AGENT_BASE_URL` | `http://localhost:8002` | Base URL written into the Agent Card's `url` field |
| `A2A_SYNTHESIZE` | `true` | When `false`, skip the synthesis LLM call and return raw tool results directly |

**Local use:** leave `AGENT_BASE_URL` as default — works immediately for local agent-to-agent calls.

**ngrok:** start the tunnel from the Connections page. The ngrok URL becomes the effective public URL automatically when no custom URL is saved.

**Custom domain / multiple ngrok accounts:** enter your URL in the "Public Access" card on the Connections page and click Save. The custom URL always takes priority over the tunnel URL and persists through tunnel start/stop cycles.

**Production:** set `AGENT_BASE_URL` in `.env` as a baseline default.

---

## Testing Locally

```bash
# Fetch the agent card
curl http://localhost:8002/.well-known/agent.json

# Send a task
curl -X POST http://localhost:8002/a2a \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tasks/send",
    "params": {
      "id": "test-1",
      "message": {
        "role": "user",
        "parts": [{"type": "text", "text": "What chunking strategies are available?"}]
      }
    }
  }'

# Stream a task
curl -N -X POST http://localhost:8002/a2a \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tasks/sendSubscribe","params":{"id":"test-2","message":{"role":"user","parts":[{"type":"text","text":"Explain hybrid retrieval"}]}}}'
```

---

## Limitations

- Tasks are stored in memory only — lost on backend restart; `tasks/get` will return not found after restart
- No authentication (suitable for local/trusted environments)
- Single-turn only — no multi-turn session support in the A2A interface (use `/api/agent/chat` for multi-turn with history)
- The LLM call is blocking in `tasks/send`; the event loop is not blocked in `tasks/sendSubscribe` (runs in thread executor)
