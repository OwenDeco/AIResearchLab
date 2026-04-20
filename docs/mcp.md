# MCP (Model Context Protocol) Server

The RAG Lab exposes an MCP server that allows Claude Desktop, Claude.ai, and other MCP-compatible clients to call the `ask_rag_lab` tool directly — answering any question about the application using the same LLM + documentation pipeline as the A2A agent.

---

## Transport

The server supports both **SSE** and **Streamable HTTP** transports, mounted at `/mcp`:

| Endpoint | Transport | Purpose |
|---|---|---|
| `GET /mcp/sse` | SSE | SSE stream — clients connect here |
| `POST /mcp/messages` | SSE | Client-to-server messages |
| `POST /mcp/mcp` | Streamable HTTP | Single endpoint for all messages |

Local URLs:
- SSE: `http://localhost:8002/mcp/sse`
- Streamable HTTP: `http://localhost:8002/mcp/mcp`

When exposed via ngrok, replace `http://localhost:8002` with the tunnel URL.

**Protocol versions supported:** `2024-11-05`, `2025-03-26`, `2025-06-18`, `2025-11-25`. The server negotiates the version requested by the client during the `initialize` handshake.

---

## Tools

### ask_rag_lab

**Description:** Answer any question about the RAG Lab application using the project documentation and live data tools.

**Input:**
| Parameter | Type | Description |
|---|---|---|
| `query` | string | The question to answer |

**Output:** A detailed text answer — may involve calling one or more data tools before synthesising the response.

**Covers:**
- REST API endpoints and parameters
- Retrieval modes, chunking strategies, graph extraction, benchmarking metrics
- Model providers: OpenAI, Azure OpenAI, Ollama
- Environment variables and all frontend pages
- Live data queries (see native data tools below)

---

### Native data tools

These tools are also exposed via MCP so any connected client can call them directly:

| Tool | Description |
|---|---|
| `list_documents` | All ingested documents — filename, type, chunk count, graph extraction status |
| `list_runs` | Recent retrieval runs — query, mode, model, latency, cost |
| `get_run_detail` | Full detail for one run by ID or prefix — answer, tokens, timings, cost |
| `list_benchmarks` | All benchmark runs — name, status, question counts, IDs |
| `get_benchmark_results` | Aggregated metrics per config for a benchmark (MRR, hit rate, faithfulness, etc.) |
| `get_analytics_summary` | Run counts, avg latency, avg/total cost grouped by retrieval mode |

---

## Claude Desktop Configuration

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "rag-lab": {
      "transport": {
        "type": "sse",
        "url": "http://localhost:8002/mcp/sse"
      }
    }
  }
}
```

For remote access via ngrok, replace `http://localhost:8002` with the ngrok tunnel URL.

---

## Connections Page

The MCP server is listed in the **Exposed** section of the Connections page with status `active`. The SSE and messages endpoints are shown with clickable URLs.

---

## Relationship to A2A

Both A2A and MCP expose the same underlying `ask_rag_lab` capability:

| | A2A | MCP |
|---|---|---|
| Protocol | JSON-RPC 2.0 over HTTP | MCP SSE / Streamable HTTP |
| Discovery | `/.well-known/agent.json` | Tool schema auto-generated |
| Clients | AI agents, orchestrators (LangGraph, ADK) | Claude Desktop, Claude.ai, MCP clients |
| Streaming | Yes (`tasks/sendSubscribe`) | Yes (SSE transport) |
| Multi-turn | No (single task per call) | Managed by client |

---

## Logging

Every `ask_rag_lab` call is recorded in the connection logs (visible on the **Logs** page) with:
- Direction: inbound
- Type: mcp
- Summary: first 100 characters of the query
- Details: full query, success flag

---

## Limitations

- No authentication (suitable for local/trusted environments)
- Does not expose retrieval or ingestion operations (read-only data tools only)
- The LLM call is synchronous within the tool handler
