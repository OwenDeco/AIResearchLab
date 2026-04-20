# Configuration

## Environment Variables

All variables are loaded from `.env` in the `backend/` directory via `config.py` (Pydantic Settings).

### Required for OpenAI features

| Variable | Description |
|---|---|
| `OPENAI_API_KEY` | OpenAI API key for GPT and embedding models |

### Azure OpenAI (optional)

| Variable | Description |
|---|---|
| `AZURE_OPENAI_API_KEY` | Azure OpenAI API key |
| `AZURE_OPENAI_ENDPOINT` | e.g. `https://YOUR-RESOURCE.openai.azure.com` |
| `AZURE_OPENAI_DEPLOYMENT` | Deployment name (e.g. `gpt-4o`) |
| `AZURE_OPENAI_API_VERSION` | Default: `2024-02-01` — not configurable via Settings page, requires `.env` edit |

### Local LLM (optional)

| Variable | Description |
|---|---|
| `OLLAMA_BASE_URL` | Default: `http://localhost:11434` |

### Database

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | `sqlite:///./ragtool.db` | SQLAlchemy connection string |

### ChromaDB

| Variable | Default | Description |
|---|---|---|
| `CHROMA_PERSIST_DIR` | `./chroma_data` | Directory where ChromaDB persists embeddings |

### Graph store

| Variable | Default | Description |
|---|---|---|
| `GRAPH_PERSIST_PATH` | `./graph_data.json` | Path for NetworkX graph JSON persistence |
| `NEO4J_URI` | — | If set, uses Neo4j instead of NetworkX |
| `NEO4J_USER` | `neo4j` | Neo4j username |
| `NEO4J_PASSWORD` | — | Neo4j password |

### Application defaults

| Variable | Default | Description |
|---|---|---|
| `DEFAULT_LLM` | `openai/gpt-4o-mini` | Default LLM for queries when none specified |
| `DEFAULT_EMBED_MODEL` | `openai/text-embedding-3-small` | Default embedding model |

---

## AppState (runtime persistence)

AppState is a key-value table in SQLite for persisting UI/session state across restarts. Keys used:

| Key | Content |
|---|---|
| `custom_models` | JSON with `{llms: string[], embed_models: string[]}` — user-defined model name lists |
| `graph_entity_types` | JSON array of `{name, color}` entity type objects |
| `graph_predicates` | JSON array of `{name, description, enabled}` predicate objects |
| `graph_extraction_config` | JSON `{min_confidence: float, preprocess_text: bool}` |
| `agent_conversation` | JSON array of `{role, content}` messages (legacy single-session) |
| `agent_session_{id}` | JSON array of `{role, content}` messages per named session |
| `benchmark_lab_session` | JSON with `question_set` and `configs` arrays |

AppState rows are read/written via `/api/settings/*`, `/api/benchmarks/session`, `/api/agent/history`, and `/api/graph/*`.

---

## Backend Constants

These are in source code and require a code change to adjust:

| File | Constant | Value | Meaning |
|---|---|---|---|
| `ingestion/pipeline.py` | `_CHROMA_BATCH_SIZE` | 100 | Chunks per ChromaDB upsert batch |
| `ingestion/pipeline.py` | `_GRAPH_EXTRACTION_WORKERS` | 3 | Parallel LLM extraction threads (tune for TPM tier) |
| `ingestion/pipeline.py` | `_SAVE_EVERY` | 50 | Persist graph every N chunks during extraction |
| `graph/extractor.py` | `_MIN_CONFIDENCE` | 0.65 | Minimum triple confidence to keep |
| `graph/extractor.py` | `_MIN_RELATED_TO_CONFIDENCE` | 0.85 | Higher threshold for vague "related_to" predicate |
| `retrieval/hybrid.py` | `DEFAULT_ALPHA` | 0.5 | Default hybrid BM25/vector weight |

---

### A2A / Agent

| Variable | Default | Description |
|---|---|---|
| `AGENT_BASE_URL` | `http://localhost:8002` | Public base URL written into the A2A Agent Card. Set to your ngrok URL or production domain when exposing the agent externally. |
| `A2A_SYNTHESIZE` | `true` | When `false`, the agent skips the synthesis LLM call after tool execution and returns raw tool results directly. Set to `false` when the caller has its own LLM for synthesis. Configurable via **Settings → Agent** in the UI. |

---

## Ports

| Service | Default Port |
|---|---|
| FastAPI backend | 8002 |
| Vite dev frontend | 5173 |

Do NOT use port 8000 — it conflicts with other local services.
