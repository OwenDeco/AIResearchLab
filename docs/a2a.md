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
  "name": "AI Systems Lab Agent",
  "description": "Expert assistant for the AI Systems Lab platform...",
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
      "description": "Answer any question about the AI Systems Lab application...",
      "tags": ["rag", "documentation", "qa", "api-reference"]
    },
    {
      "id": "mcp-careplans",
      "name": "careplans",
      "description": "MCP server: careplans. Tools: fetch_careplan, list_careplans",
      "tags": ["mcp", "careplans"]
    }
  ]
}
```

**The `skills` list is dynamic.** It always includes:

1. **`project-qa`** — built-in Q&A over the project documentation
2. **6 native data skills** (`native-list_documents`, `native-list_runs`, `native-get_run_detail`, `native-list_benchmarks`, `native-get_benchmark_results`, `native-get_analytics_summary`) — live queries against the AI Systems Lab database
3. **One skill per registered MCP server connection** — external tools the agent can reach

If no MCP servers are registered, only the Q&A and native data skills appear.

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
