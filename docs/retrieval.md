# Retrieval Modes

Six retrieval strategies are available. They are selected per query via the `retrieval_mode` parameter.

## Overview

| Mode | Algorithm | Best For |
|---|---|---|
| `lexical` | BM25 keyword ranking | Exact term matching, proper nouns |
| `semantic_rerank` | BM25 → cross-encoder reranker | High precision when a reranker model is available |
| `vector` | Cosine similarity on embeddings | Semantic/conceptual queries |
| `hybrid` | BM25 + vector with score fusion | General purpose, balances recall and precision |
| `graph_rag` | Entity extraction → graph traversal → context assembly | Relationship-heavy queries, multi-hop reasoning |
| `parent_child` | Vector search on child chunks → return parent chunk content | Queries needing long context, used with parent_child chunking |

---

## lexical

Uses a BM25 index built from all ingested chunks. The index is rebuilt lazily when documents are added or deleted (marked dirty, rebuilt on first query after change).

**Parameters:**
- `top_k`: Number of chunks to return

**Limitations:** Keyword-only; misses synonyms and paraphrases.

---

## semantic_rerank

Two-stage: First retrieves a candidate set using BM25 (typically `top_k * 3` candidates), then reranks using a cross-encoder model.

**Parameters:**
- `top_k`: Final number of chunks after reranking
- Reranker model: configured in models registry (default: `cross-encoder/ms-marco-MiniLM-L-6-v2`)

**Requires:** A reranker model loaded via `models/registry.py`.

---

## vector

Pure embedding similarity search in ChromaDB. Query is embedded, and the nearest neighbors by cosine distance are returned.

**Parameters:**
- `top_k`: Number of chunks to return
- `embed_model`: Which embedding model to use for the query

**Limitations:** Requires embeddings to have been generated at ingestion time with the same (or compatible) model.

---

## hybrid

Combines BM25 scores and vector similarity scores using Reciprocal Rank Fusion (RRF) or weighted combination.

**Parameters:**
- `top_k`: Number of chunks to return
- `alpha`: Weight between 0 (pure lexical) and 1 (pure vector); default 0.5
- `embed_model`: Embedding model for vector component

---

## graph_rag

Multi-step retrieval using the knowledge graph:

1. Extract entities from the query (rule-based or LLM-based)
2. Find matching nodes in the graph
3. Traverse the graph N hops from each matched node (BFS)
4. Collect all chunk_ids referenced by traversed nodes/edges
5. Fetch those chunks from SQLite
6. Deduplicate and score by graph proximity

**Parameters:**
- `top_k`: Maximum chunks to return
- `graph_hops`: Number of BFS hops from matched entities (default 2, recommended 1–3)

**Requires:** Graph extraction must have been run on ingested documents.

**Strengths:** Discovers non-obvious connections between entities. Good for "who uses what" or "what depends on what" questions.

---

## parent_child

1. Embed query and search ChromaDB for matching **child** chunks
2. For each matched child, look up its `parent_chunk_id` in SQLite
3. Return the full **parent** chunk content instead of the small child

**Parameters:**
- `top_k`: Number of parent chunks to return (searches `top_k * 2` child chunks first to get `top_k` unique parents)

**Best used with:** `parent_child` chunking strategy at ingestion time.

**Strengths:** Precise matching (small children) + full context (large parent). Avoids truncated answers.

---

## QueryRequest Parameters (full reference)

```python
class QueryRequest(BaseModel):
    query: str                                    # The question or search string
    retrieval_mode: str = "vector"               # One of the six modes above
    model_name: str = "openai/gpt-4o-mini"       # LLM for answer generation
    embed_model: str = "openai/text-embedding-3-small"  # Embedding model
    top_k: int = 5                               # Chunks to retrieve
    graph_hops: int = 2                          # Hops for graph_rag only
    alpha: float = 0.5                           # Weight for hybrid only
```

---

## Retrieval Pipeline Flow

```
Query
  └─► Retriever.retrieve(query, top_k)
        └─► Returns List[ContextItem]
              └─► LLM.complete(system + context + question)
                    └─► QueryResponse (answer + contexts + tokens + cost + timings)
```

Each run is automatically saved to the `runs` table in SQLite.

---

## Retriever Factory

`retrieval/factory.py` exports `build_retriever(mode, embed_model, model_name, db, chroma, graph_store, bm25_index)` which returns the correct retriever instance based on mode. All retrievers implement the `BaseRetriever.retrieve(query, top_k)` interface.
