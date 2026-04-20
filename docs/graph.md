# Knowledge Graph

The graph layer extracts entities and relations from ingested documents and stores them in a directed multigraph backed by NetworkX, with JSON persistence.

---

## Architecture

```
graph/
  extractor.py   — LLM-powered entity/relation extraction
  store.py       — GraphStore: in-memory NetworkX graph + persistence
```

---

## Graph Store

**Class:** `GraphStore` in `graph/store.py`

Backed by a `networkx.DiGraph`. Persisted to JSON at `GRAPH_PERSIST_PATH` (default: `./graph_data.json`).

### Node structure

| Field | Description |
|---|---|
| `id` | Normalized label as node identifier (e.g., `bert`, `openai_company`) |
| `label` | Original display label (e.g., `BERT`, `OpenAI Company`) |
| `type` | Entity type (Person, Organization, Technology, Location, Other) |
| `doc_ids` | List of document IDs that mention this entity |
| `chunk_ids` | List of chunk IDs where this entity was found |

### Edge structure

| Field | Description |
|---|---|
| `source` | Subject node ID |
| `target` | Object node ID |
| `predicate` | Relation type (one of 12 allowed predicates) |
| `chunk_id` | Chunk where this relation was extracted |
| `doc_id` | Document this relation came from |
| `confidence` | Float 0–1, how clearly the relation is stated in text |
| `evidence` | Short verbatim quote (≤200 chars) from text supporting the relation |

### Node Deduplication

Entities are deduplicated via `_normalize_label()`:
1. Strip leading articles (the, a, an) case-insensitively
2. Collapse internal whitespace
3. Convert to lowercase
4. Replace spaces with underscores for the node ID

Example: `"The OpenAI Company"` → node ID `openai_company`, label preserved as `"OpenAI Company"`.

---

## Entity/Relation Extraction

**Class:** `EntityRelationExtractor` in `graph/extractor.py`

Uses an LLM call to extract typed entities and relations from each chunk. Returns a list of `Triple` objects.

### Allowed Predicates

Only these 12 predicates are accepted — the LLM is instructed to use no others:

| Predicate | Meaning |
|---|---|
| `is_a` | X is a type or kind of Y |
| `part_of` | X is a component or member of Y |
| `uses` | X employs or uses Y |
| `created_by` | X was created, authored, or developed by Y |
| `located_in` | X is located or headquartered in Y |
| `works_for` | Person X works for or is employed by Y |
| `depends_on` | X requires or depends on Y |
| `implements` | X implements or applies Y |
| `based_on` | X is derived from or based on Y |
| `causes` | X causes, leads to, or results in Y |
| `evaluates` | X measures, evaluates, or benchmarks Y |
| `collaborates_with` | X works together with Y |

Any predicate returned by the LLM that is not in this list is silently discarded.

### Entity Types

Default entity types with their default colors:

| Type | Color |
|---|---|
| `Person` | `#3b82f6` (blue) |
| `Organization` | `#22c55e` (green) |
| `Technology` | `#f97316` (orange) |
| `Concept` | `#a855f7` (purple) |
| `Location` | `#ef4444` (red) |
| `Other` | `#94a3b8` (slate) |

Users can configure entity types via the Graph Explorer → Entity Types panel (stored in AppState key `graph_entity_types`). Custom types are passed to the extraction prompt.

### Predicates

Predicates can be enabled or disabled individually via the Graph Explorer → Predicates panel (stored in AppState key `graph_predicates`). Disabled predicates are excluded from the extraction prompt so the LLM won't generate them.

### Extraction Config

Two extraction parameters are configurable at runtime via the Graph Explorer → Extraction Config panel (stored in AppState key `graph_extraction_config`):

| Parameter | Default | Description |
|---|---|---|
| `min_confidence` | `0.65` | Minimum confidence for triples to be kept |
| `preprocess_text` | `true` | Clean and normalize chunk text before extraction |

### Confidence Filtering

| Threshold | Applied To |
|---|---|
| `0.65` | All predicates (general minimum) |
| `0.85` | `related_to` predicate (stricter, as it's vague) |

Triples below threshold are logged at DEBUG level and discarded.

### Triple Dataclass

```python
@dataclass
class Triple:
    subject: str           # Entity name
    subject_type: str      # Entity type
    predicate: str         # One of ALLOWED_PREDICATES
    object_: str           # Entity name
    object_type: str       # Entity type
    chunk_id: str
    doc_id: str
    confidence: float = 1.0
    evidence: str = ""     # Verbatim quote from text (≤200 chars)
```

---

## Extraction Pipeline

Graph extraction runs as a background task after ingestion HTTP response is sent.

### Parallel extraction

- Workers: `_GRAPH_EXTRACTION_WORKERS = 3` concurrent LLM calls
- Thread-safe: graph mutations use `threading.Lock`
- Progress save: graph is persisted to disk every 50 chunks
- Rate limit handling: global shared backoff via `_rl_resume_at`

### Cancellation

Each document's extraction registers a `threading.Event` in `_active_extractions`. Calling `POST /api/documents/{doc_id}/cancel-graph` sets the event, causing workers to stop cleanly after their current chunk.

### Triggering extraction on existing documents

`POST /api/documents/{doc_id}/extract-graph` triggers extraction for a document that was ingested without graph extraction (or whose extraction was previously cancelled). It only processes chunks that exist in SQLite; it will process all chunks regardless of prior extraction state.

### Rule-based vs LLM extraction

`GraphStore` also has a `extract_and_add(text, doc_id, chunk_id)` method that uses simple regex patterns for entity and relation extraction without an LLM. This is a fallback / lightweight alternative used in some test paths, but the primary extraction path uses `EntityRelationExtractor` (LLM-based).

---

## Graph Queries

### `get_neighbours(entity_id, hops=2)`

BFS traversal from a node, following both outgoing and incoming edges. Returns `(nodes_list, edges_list)`.

### `find_entities_by_label(query)`

Case-insensitive substring search on node labels. Returns list of node IDs.

### `get_all_nodes()` / `get_all_edges()`

Return full graph as serializable dicts.

---

## Limitations

- No abbreviation deduplication (e.g., `BERT` and `Bidirectional Encoder Representations from Transformers` are separate nodes)
- No coreference resolution
- Extraction quality depends on chunk size — very short chunks may not contain enough context
- Large graphs (>10k nodes) may slow down the Graph Explorer visualization
- The graph is reloaded from JSON at startup; corrupted JSON will cause an empty graph to be initialized
