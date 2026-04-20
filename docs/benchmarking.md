# Benchmarking

The Benchmark Lab allows running multiple retrieval configurations against a question set and comparing quality metrics side-by-side.

---

## Concepts

### Question Set
A list of questions, each optionally with a reference answer and source document IDs. Questions can be typed manually or generated automatically from ingested documents.

### Config
A retrieval + model configuration to test. Multiple configs can be tested simultaneously against the same question set. Each config has:
- `label`: display name
- `retrieval_mode`: one of the six modes
- `model_name`: LLM provider key
- `embed_model`: embedding provider key
- `top_k`: chunks to retrieve

### Benchmark Run
A run executes every question against every config, producing one result per (question, config) pair. Results are stored in SQLite.

---

## Starting a Benchmark

### API

`POST /api/benchmarks/run` with `BenchmarkRunRequest`:
```json
{
  "name": "GPT-4o vs GPT-4o-mini",
  "question_set": [
    {
      "question": "What is BERT?",
      "reference_answer": "BERT is a transformer-based language model developed by Google.",
      "doc_ids": ["uuid-of-paper"],
      "source_chunk_id": "uuid-of-chunk"
    }
  ],
  "configs": [
    {
      "label": "Vector + GPT-4o-mini",
      "retrieval_mode": "vector",
      "model_name": "openai/gpt-4o-mini",
      "embed_model": "openai/text-embedding-3-small",
      "top_k": 5
    },
    {
      "label": "Hybrid + GPT-4o",
      "retrieval_mode": "hybrid",
      "model_name": "openai/gpt-4o",
      "embed_model": "openai/text-embedding-3-small",
      "top_k": 5
    }
  ]
}
```

Benchmark runs execute asynchronously. Poll `GET /api/benchmarks/{run_id}` to check `status` and `completed_questions`.

---

## Quality Metrics

Each result includes:

| Metric | Range | Description |
|---|---|---|
| `context_precision` | 0–1 | Fraction of retrieved chunks that are relevant to the question |
| `answer_relevance` | 0–1 | How relevant the generated answer is to the question (semantic similarity) |
| `hit_rate` | 0–1 | Whether at least one relevant chunk was retrieved (binary, averaged) |
| `mrr` | 0–1 | Mean Reciprocal Rank — position of first relevant chunk |
| `answer_correctness` | 0–1 | Semantic similarity between generated answer and reference answer (requires reference) |
| `faithfulness` | 0–1 | How much of the answer is grounded in the retrieved context (LLM-judged) |
| `chunks_retrieved` | int | Number of chunks actually returned by retriever |

**Note:** `answer_correctness` and `faithfulness` require reference answers. If no reference answer is provided, these will be null.

---

## Session Persistence

The Benchmark Lab session (current question set + configs) is saved automatically to AppState key `benchmark_lab_session` and restored on page reload. This prevents losing work when navigating away.

`GET /api/benchmarks/session` — load session
`PUT /api/benchmarks/session` — save session

---

## Benchmark Run Status

```json
{
  "id": "uuid",
  "name": "My Benchmark",
  "status": "running",       // pending, running, completed, failed
  "created_at": "...",
  "completed_at": null,
  "total_questions": 10,
  "completed_questions": 4,
  "configs": [{"label": "...", "retrieval_mode": "..."}]
}
```

---

## Results Format

`GET /api/benchmarks/{run_id}/results` returns an array of `BenchmarkResultResponse`:

```json
{
  "id": "uuid",
  "benchmark_run_id": "uuid",
  "question": "What is BERT?",
  "reference_answer": "...",
  "config_label": "Vector + GPT-4o-mini",
  "retrieval_mode": "vector",
  "model_name": "openai/gpt-4o-mini",
  "embed_model": "openai/text-embedding-3-small",
  "answer": "BERT is...",
  "context_precision": 0.82,
  "answer_relevance": 0.91,
  "hit_rate": 1.0,
  "mrr": 1.0,
  "answer_correctness": 0.78,
  "faithfulness": 0.85,
  "chunks_retrieved": 5,
  "source_doc_id": "uuid",
  "contexts": [...],
  "latency_ms": 1234.5,
  "estimated_cost_usd": 0.000142,
  "created_at": "..."
}
```

---

## Cost Estimation

Cost is estimated based on token counts and per-provider pricing rates defined in `observability/`. The estimated cost in USD is stored per run and per benchmark result.

---

## Limitations

- Benchmark runs are blocking — each question/config combination calls the full retrieval + generation pipeline
- No streaming; the UI polls for progress
- Large question sets × many configs can take significant time and incur API costs
- Faithfulness metric requires an LLM call (separate from the answer generation call), doubling LLM costs for that metric
