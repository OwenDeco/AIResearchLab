# Frontend

The frontend is built with React + Vite + TypeScript, using Tailwind CSS for styling.

**Dev server:** `http://localhost:5173`
**API base URL:** `http://localhost:8002/api`

---

## Pages

### 1. Dashboard (`/`)

Overview of system activity:
- Recent query run history (last N runs)
- Recent benchmark runs
- Cost/latency summary charts (Recharts)
- Quick stats: total documents, chunks, graph nodes/edges

---

### 2. Document Ingestion (`/ingestion`)

Upload and manage documents.

**Features:**
- Multi-file drag-and-drop or browse; files ingested one at a time with per-file status: pending → uploading → done / error
- Success message per file: "42 chunks · 42 embedded" (with warning if any embedding batches failed)
- **Sample Dataset panel**: collapsible panel listing all files in the `raw/` directory; select individual files (or all) and ingest them directly without uploading — uses the same config settings as the upload form; shows per-file status and marks already-ingested files
- Chunking strategy selector: fixed, sliding, sentence, semantic, parent_child
- Chunk size and overlap inputs (hidden for semantic strategy)
- Split Percentile and Max Chunk Tokens inputs (visible for semantic strategy only)
- Embedding model selector
- "Extract Graph" toggle — if checked, graph extraction is automatically scheduled after ingestion completes
- Document table with:
  - Filename, type, strategy, chunk count, graph status, upload date, delete button
  - **Graph status column:**
    - **Blue spinner + "N/M chunks"**: extraction running — shows live progress from per-doc polling
    - **Amber spinner + "rate limited — Xs"**: extraction paused waiting for token budget to reset; countdown updates every 8 s
    - **"extract" link**: extraction not yet started; click to schedule
    - **Green checkmark "yes"**: extraction complete
    - **✕ button**: cancel a running or rate-limited extraction
  - "Extract Graph for All" button (visible when any document has not been extracted and is not currently extracting)
  - Delete button per document
- Chunk inspector: click a document row to see its chunks with pagination
- **Graph extraction progress polling:**
  - Only polls `/api/documents/{doc_id}/extract-progress` for documents that have an active extraction in the UI state
  - Poll interval: **2 s** while running, **8 s** while rate-limited (no benefit checking more often during a ~60 s wait)
  - Automatically refreshes the document list when an extraction finishes (404 from the progress endpoint signals completion)
  - Extraction state (`extractProgress`) is stored in the global Zustand store so it survives page navigation; polling resumes automatically when the Ingestion page is re-mounted

---

### 3. Runtime Playground (`/playground`)

Interactive query interface for testing retrieval modes.

**Features:**
- Query input
- Retrieval mode selector (all 6 modes)
- LLM model selector
- Embedding model selector
- Top-K slider
- Graph hops slider (for graph_rag mode)
- Alpha slider (for hybrid mode)
- **External connection toggle**: "Use registered connection" checkbox — when enabled, all local retrieval options are bypassed and a dropdown shows all registered A2A agents and MCP servers. The query is forwarded entirely to the selected external agent. When no connections are registered, an instructional note is shown.
- Answer display with streaming-style rendering
- Context panel: shows retrieved chunks with scores; shows "External agent — no local context retrieved" note when an external connection was used
- Stage timings breakdown (retrieval vs generation)
- Token count and cost display

---

### 4. Benchmark Lab (`/benchmark`)

Define question sets, configure test configs, and run comparative benchmarks.

**Features:**
- Question editor (add/edit/delete questions with optional reference answers)
- Config editor (add multiple retrieval+model configs to compare)
- Run button: launches benchmark, shows progress polling
- Results table: side-by-side metric comparison
- Chart view: bar charts of metrics per config
- Session auto-saved to AppState (persists on reload)

---

### 5. Graph Explorer (`/graph`)

Interactive visualization of the knowledge graph.

**Features:**
- Force-directed graph (react-force-graph-2d)
- Node color by entity type
- Click node: highlights neighbours, shows entity details panel
- Click edge: shows predicate, confidence, evidence quote
- Search: find nodes by label substring
- Filter by entity type, document, or confidence threshold
- Stats panel: node/edge count, top entities by degree

---

### 6. Analytics (`/analytics`)

Comprehensive analytics across runs, connections, tokens/cost, and platform health.

**Date range filter:** 7d / 30d / All — applies client-side to all time-series charts. Top-right tab bar switches between the four analysis views.

**Tab 1 — RAG Queries:**
- KPI row: total runs, avg latency, total cost, avg tokens/run
- Line chart: runs per day
- Bar charts: avg latency by retrieval mode, avg cost by retrieval mode
- Stacked bar: total token usage by model (prompt vs completion)
- Summary table: mode, runs, avg latency, avg cost, avg chunks used
- Latency percentiles card: p50 / p90 / p99
- Export runs as CSV button

**Tab 2 — Connections:**
- KPI row: total events, inbound calls, outbound calls, internal events
- Stacked bar: agent calls per day (UI calls vs A2A calls)
- Horizontal bar: events by type, sorted by count
- Dual-line chart: errors per day vs total events
- Table: per-connection breakdown (name, type, inbound, outbound, errors, error rate %)

**Tab 3 — Token & Cost:**
- KPI row: total prompt tokens, total completion tokens, total cost USD, avg cost per run
- Area chart: daily cost over time
- Stacked area chart: daily token usage (prompt vs completion)
- Bar charts: total cost by model, total tokens by model

**Tab 4 — Platform:**
- KPI row: documents ingested, total chunks, benchmark runs, agent sessions
- Bar chart: documents and chunks ingested per day
- Risk signals panel: red cards (error) / amber cards (warning) for issues detected in the last 24h; "All clear" if none
  - Checks: MCP tool call errors, A2A tool call errors, high latency (p90 > 10s), ngrok tunnel going down, > 5 failed inbound calls
- System events timeline: scrollable log of ngrok start/stop, connection registered/deleted/tested events
- Agent activity summary: session and message totals

**Data source:** All analytics data is fetched from a single `GET /api/analytics/summary` endpoint that aggregates across `runs`, `connection_logs`, `documents`, `benchmark_runs`, and `agent_sessions` tables.

---

### 7. Settings (`/settings`)

Configuration panel.

**Sections:**
- **Providers**: OpenAI, Azure OpenAI, Ollama API keys and endpoints. Written to `.env` and applied immediately.
- **Agent**: A2A behaviour toggles. Currently: **Synthesize A2A responses** — when off, the agent skips the synthesis LLM call and returns raw tool results directly (for callers that have their own LLM). Written to `.env` and applied immediately.
- **Models**: Add custom LLM/embedding model IDs (`provider/model-name` format). Persisted to AppState and appear in all model dropdowns.

---

### 8. Connections (`/connections`)

Overview of all protocols exposed by the lab and external services it consumes.

**Exposed connections:**
- **REST API** — base URL and link to OpenAPI `/docs`
- **A2A Agent** — agent card URLs, task endpoint URL, all supported JSON-RPC methods
- **MCP Server** — active; SSE stream URL (`/mcp/sse`) and messages URL (`/mcp/messages`), tool list (`ask_rag_lab`)

**Consumed connections:**
- **OpenAI API** — configured/not configured, models listed
- **Azure OpenAI** — configured/not configured, deployment shown
- **Ollama** — live-pinged to check if local server is reachable
- **ChromaDB** — local, live vector count
- **SQLite** — local, live document + chunk counts
- **Graph Store** — local, live node + edge counts

Each card shows: status badge, endpoint URLs with copy and external link buttons, methods/models chips, and live stats. A Refresh button re-pings all connections.

**Loading behaviour:** The page renders immediately using fast DB reads (registered connections, ngrok status). The Exposed and Consumed sections fetch network status checks in the background and update in place when ready, indicated by a small spinner next to each section header.

**ngrok Tunnel panel** (within the Exposed section):
A dedicated control panel for managing a public HTTPS tunnel via ngrok, without using the terminal:
- Shows tunnel status (Active / Stopped) with a WiFi icon indicator
- **Start tunnel** button: launches `ngrok http 8002` as a subprocess, polls until the public URL is available (up to 12 s). The URL is shown with a copy button.
- **Stop tunnel** button: terminates the ngrok subprocess.
- After starting or stopping, connection data is automatically refreshed so A2A card endpoint URLs reflect the new tunnel URL.
- If ngrok is not installed or authentication is missing, an error message is shown inline.
- The effective public URL is the active ngrok URL, or `http://localhost:8002` when the tunnel is stopped.

**Registered Connections section:**
Third panel for managing external A2A agents and MCP servers:
- Tab bar: **A2A Agents** | **MCP Servers**
- **A2A tab**: register by Name + Agent Card URL. On registration the backend fetches the agent card to extract the task URL and skill list. Each registered connection shows name, task URL, skills chips, description, and Test / Delete buttons.
- **MCP tab**: register by Name + Server URL (optionally Description). On registration the backend connects and discovers available tools. Each registered connection shows name, server URL, tools chips, and Test / Delete buttons.
- **Test button**: pings the live connection and shows a status badge (active / error) with a message.
- Registered connections appear in the Playground's External Connection dropdown.

---

### 9. Agent (`/agent`)

Full-page chat interface with the RAG Lab Agent, with persistent named sessions.

**Layout:** Sessions sidebar (left) + chat area (right).

**Sessions sidebar:**
- **New session** button — creates a new empty session with an auto-generated name (e.g. "Session Apr 5, 14:32")
- Session list sorted by last-active time; each item shows name, message count, and date
- Click a session to load its messages into the chat
- Hover to reveal **rename** (pencil icon — inline edit, Enter to save) and **delete** buttons
- Deleting all sessions automatically creates a fresh one

**Chat area:**
- Multi-turn conversation tied to the active session
- Shows answer latency per message
- Source toggle (shows retrieved sources per assistant turn)
- Messages are saved to the active session after every exchange and survive page reloads

---

### 10. Logs (`/logs`)

Audit trail for all connection events.

**Features:**
- Full-page table showing up to 500 most recent events, newest first
- Direction filter tabs: **All** | **Inbound** | **Outbound** | **Internal** | **System**
- Each row: timestamp, **trace badge**, direction badge, connection type badge, event type, summary, caller IP
- **Trace column**: every A2A request gets a `trace_id`. The Trace column shows a color-coded 8-char short ID. Click it to filter the whole table to that single request (waterfall view). Click again or ✕ to clear.
- **Run column**: each log entry shows a short `run_id` badge (first 8 chars); click it to filter the table to all events from that run; a ✕ chip clears the filter
- **Events captured:** A2A inbound call, LLM tool-selection calls, tool chosen, MCP tool call (outbound), MCP tool response (inbound), native tool calls, outbound A2A response; plus registration/deletion/test events and ngrok tunnel start/stop
- **Refresh** button re-fetches from the backend
- **Clear all** button deletes all log entries

---

### 11. Runs (`/runs`)

Cross-domain run browser — every execution across the platform in one view.

**Features:**
- Domain filter tabs: All | Orchestration | Evaluation | Interoperability | Context Engineering | Governance
- Run type dropdown: All Types | Runtime Test | Retrieval Test | Benchmark Run | Connection Test | Agent Session
- Status filter: All | Running | Completed | Failed
- Table: domain badge, run type + name, status badge, started-at timestamp, duration, total tokens, total cost, step count
- Click any row to expand an inline detail panel with three sections:
  1. **Run Summary** — KPI cards (latency, tokens, cost, errors) + output preview; benchmark name shown as heading
  2. **Steps Timeline** — ordered step list with colored dots (blue=retrieve_chunks, purple=llm_call, amber=tool_call, green=score_answer), component name, proportional duration bar, and status
  3. **Events log** — fine-grained events table with category badges (execution, data, ai, connection, evaluation, governance), event type, severity, and summary

**Data source:** `GET /api/unified-runs` and `GET /api/unified-runs/{id}/steps|events`

---

## Agent Widget

A floating chat button (bottom-right corner, Bot icon) is available on every page. It opens a 560px-tall chat panel.

**Features:**
- Gradient header with title "RAG Lab Agent"
- Multi-turn conversation with history
- Shows latency per assistant response
- Sources list per response (scrollable, all sources shown)
- Maximize button → navigates to `/agent` page
- Green dot indicator when conversation history exists
- Shares the **active session** with the Agent page via Zustand store (`activeSessionId`). Switching sessions on the Agent page also updates the widget, and clearing the widget (new session) is reflected on the Agent page. Messages survive page reloads.

---

## Sidebar Navigation

The sidebar is organised into 7 domain groups:
- **Overview** — Dashboard
- **Context Engineering** — Ingest, Graph Explorer
- **Orchestration & Runtime** — Runtime Playground, Agent
- **Interoperability** — Connections
- **Evaluation & Benchmarking** — Benchmark Lab
- **Governance & Observability** — Analytics, Runs, Logs
- **Platform Configuration** — Settings

---

## Frontend Architecture

```
frontend/src/
  api/
    client.ts          Single Axios instance + all API methods
  components/
    AgentWidget.tsx    Floating chat widget (global, every page)
    Layout.tsx         Sidebar navigation wrapper
    Badge.tsx          Status badge component
    Spinner.tsx        Loading spinner
    ErrorAlert.tsx     Inline error display
    ...
  pages/
    Dashboard.tsx
    Ingestion.tsx
    Playground.tsx
    BenchmarkLab.tsx
    GraphExplorer.tsx
    Analytics.tsx
    Settings.tsx
    Connections.tsx
    Agent.tsx
    Logs.tsx
    Runs.tsx
  store/
    useAppStore.ts     Zustand global state
  types/
    index.ts           Shared TypeScript interfaces
  App.tsx              Route definitions
  main.tsx             Entry point
```

---

## State Management

Global state uses **Zustand** (`store/useAppStore.ts`). The store holds:
- `models` — available LLM models, embedding models, rerankers (fetched from `/api/models/` on startup)
- `documents` — current document list
- `activeSessionId` — the currently selected agent session ID, shared between the Agent page and the floating widget
- `extractProgress` — per-doc graph extraction progress (`Record<docId, ProgressEntry | true>`). Stored globally so navigation away from the Ingestion page does not lose live progress; polling resumes on re-mount.

After any server-side change that affects the models list (e.g., adding custom models in Settings), components trigger a refresh via the Zustand store.

---

## Build

```bash
# Development (hot reload)
npm run dev

# Production build (output to dist/)
npm run build
```

**Important:** The FastAPI backend serves the production `dist/` directory. If you modify frontend source files, you MUST run `npm run build` again — the dev server changes are not reflected in the production build automatically.
