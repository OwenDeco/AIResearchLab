# Chunking Strategies

Documents are split into chunks during ingestion. The chunking strategy is chosen per-document at upload time. The selected strategy affects retrieval quality significantly.

## Strategies

### fixed
**Class:** `FixedSizeChunker`

Splits text into fixed-length non-overlapping (or overlapping) windows by character count.

| Parameter | Default | Description |
|---|---|---|
| chunk_size | 512 | Target chunk size in characters |
| chunk_overlap | 50 | Overlap between consecutive chunks |

**Best for:** General-purpose use. Predictable chunk sizes. Fast.

---

### sliding
**Class:** `SlidingWindowChunker`

Similar to fixed, but the step size is `chunk_size - chunk_overlap`, creating a sliding window.

| Parameter | Default | Description |
|---|---|---|
| window_size | 512 | Window size in characters (= chunk_size) |
| step_size | max(1, chunk_size - chunk_overlap) | How far to advance each step |

**Best for:** Dense text where context spans chunk boundaries.

---

### sentence
**Class:** `SentenceChunker`

Splits text at sentence boundaries, grouping sentences until `max_chunk_size` is reached.

| Parameter | Default | Description |
|---|---|---|
| max_chunk_size | 512 | Maximum characters per chunk |

**Best for:** Preserving sentence integrity. Good for Q&A where facts are sentence-level.

---

### semantic
**Class:** `SemanticChunker`

Uses embedding similarity to find natural topic boundaries in the text. Splits where the cosine similarity between adjacent sentence embeddings drops below a threshold.

| Parameter | Default | Description |
|---|---|---|
| percentile_threshold | 95 | Percentile of similarity drops used as split boundary |
| max_chunk_tokens | 512 | Hard upper limit on tokens per chunk |
| fallback_chunk_size | 512 | Fallback if embedder is unavailable |

**Requires:** An embedder must be available. Falls back to fixed-size if embedder fails.

**Best for:** Long documents with distinct topic sections. Produces semantically coherent chunks.

---

### parent_child
**Class:** `ParentChildChunker`

Creates two levels of chunks:
- **Parent chunks**: large (default `max(chunk_size * 2, 1024)` chars), stored with `is_parent=True` metadata
- **Child chunks**: small (default `max(chunk_size // 2, 128)` chars), linked to their parent via `parent_chunk_id`

Only child chunks are embedded and stored in ChromaDB. When retrieved, the parent chunk's full content is returned instead of the child.

| Parameter | Default | Description |
|---|---|---|
| parent_size | max(chunk_size * 2, 1024) | Parent chunk size in characters |
| child_size | max(chunk_size // 2, 128) | Child chunk size in characters |

**Best for:** Long-context retrieval where precise matching (small child) should return full context (large parent). Works best with the `parent_child` retrieval mode.

---

## ChunkData Object

All chunkers return `ChunkData` objects:
```python
@dataclass
class ChunkData:
    content: str          # chunk text
    chunk_index: int      # position in document
    start_char: int       # character offset in original text
    end_char: int         # end character offset
    parent_chunk_id: str  # UUID of parent chunk (parent_child strategy only)
    metadata: dict        # strategy-specific metadata
```

## Chunk Metadata Fields

| Field | Strategies | Description |
|---|---|---|
| `is_parent` | parent_child | True for parent chunks (not embedded) |
| `_chunk_uuid` | parent_child | Pre-assigned UUID to link parent/child |
| `chunk_size` | fixed, sliding | Configured chunk size |
| `chunk_overlap` | fixed, sliding | Configured overlap |
