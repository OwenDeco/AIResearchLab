# Models & Providers

All LLM, embedding, and reranker models are accessed through a provider abstraction layer in `models/`. This allows swapping providers without changing retrieval or generation code.

---

## Provider Keys

Models are referenced by string keys in the format `provider/model-name`:

| Prefix | Provider |
|---|---|
| `openai/` | OpenAI API |
| `azure/` | Azure OpenAI API |
| `ollama/` | Local Ollama server |

Examples:
- `openai/gpt-4o-mini`
- `openai/gpt-4o`
- `openai/gpt-5.4`
- `openai/text-embedding-3-small`
- `openai/text-embedding-3-large`
- `azure/my-deployment`
- `ollama/llama3`
- `ollama/mistral`

---

## LLM Providers

### OpenAI (`openai/`)

**Class:** `OpenAIProvider` in `models/openai_provider.py`

Uses `openai.OpenAI` client. Calls `chat.completions.create` with `max_completion_tokens` (not `max_tokens` — the older parameter is unsupported on newer models).

**Retry behavior:** Automatically retries on `APIConnectionError` up to 3 times with exponential backoff (2s–10s). Does NOT auto-retry on rate limit errors — rate limits are managed globally at the pipeline level.

**Parameters per call:**
- `temperature`: float (default 0.0)
- `max_tokens`: int passed as `max_completion_tokens` (default 2048)

---

### Azure OpenAI (`azure/`)

**Class:** `AzureOpenAIProvider` in `models/openai_provider.py`

Uses `openai.AzureOpenAI` client. Requires `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT`, and a deployment name. The deployment name is used as the model identifier.

---

### Ollama (`ollama/`)

**Class:** `OllamaProvider` in `models/ollama_provider.py`

Calls the local Ollama HTTP API at `OLLAMA_BASE_URL`. No API key required. Model must be pulled locally (`ollama pull llama3`).

---

## Embedding Providers

### OpenAI Embeddings (`openai/`)

**Class:** `OpenAIEmbedding` in `models/openai_provider.py`

Methods:
- `embed(texts: List[str]) -> List[List[float]]` — batch embedding
- `embed_query(text: str) -> List[float]` — single query embedding

---

### Azure OpenAI Embeddings (`azure/`)

**Class:** `AzureOpenAIEmbedding` in `models/openai_provider.py`

Same interface as OpenAI, uses Azure endpoint.

---

### Ollama Embeddings (`ollama/`)

**Class:** `OllamaEmbedding` in `models/ollama_provider.py`

Uses Ollama's `/api/embeddings` endpoint. Requires a model that supports embeddings (e.g., `nomic-embed-text`).

---

## Reranker Providers

**Class:** `CrossEncoderReranker` in `models/reranker.py`

Uses `sentence-transformers` library with a cross-encoder model. The model is loaded locally.

Default model: `cross-encoder/ms-marco-MiniLM-L-6-v2`

Method: `rerank(query: str, chunks: List[ContextItem], top_k: int) -> List[ContextItem]`

---

## Model Registry

`models/registry.py` exports:

```python
def get_llm(model_name: str) -> LLMProvider
def get_embedder(model_name: str) -> EmbeddingProvider
def get_reranker(model_name: str) -> RerankerProvider
```

These functions parse the provider prefix, look up API keys from config, and return the appropriate provider instance. Custom models defined in AppState (`custom_models` key) are also supported.

---

## Available Models (single source of truth)

`custom_models` in AppState is the **single source of truth** for which models appear in all dropdowns (Playground, Benchmark Lab, Agent LLM picker).

`GET /api/models` returns this list directly. On the first call (when the AppState row does not yet exist), the backend auto-seeds the list from `settings.available_llms()` / `settings.available_embed_models()` so existing users don't lose their models on upgrade.

Users manage the list via the **Available Models** section in Settings (or `PUT /api/models/custom`):

```json
{
  "llms": ["openai/gpt-4-turbo", "azure/my-deployment", "ollama/llama3.1:70b"],
  "embed_models": ["openai/text-embedding-ada-002", "ollama/nomic-embed-text"]
}
```

Each string follows `provider/model-name` format. Credentials must be configured separately.

### Model Suggestions

`GET /api/models/suggestions` returns per-provider curated lists of models **not already in the custom list**. Only configured providers appear. Azure is excluded from chips (deployment names are user-specific) and shows a note instead.

Response shape:
```json
{
  "openai": { "configured": true, "llms": [...], "embed_models": [...] },
  "azure":  { "configured": true, "llms": [], "embed_models": [], "note": "..." },
  "ollama": { "configured": true, "llms": [...], "embed_models": [...] }
}
```

The Settings page renders these as clickable chips under each model card — clicking adds the model to the list instantly (without requiring a save first). Chips disappear once the model is in the list.

---

## LLMResponse

All LLM providers return `LLMResponse`:
```python
@dataclass
class LLMResponse:
    content: str             # Generated text
    prompt_tokens: int       # Input tokens
    completion_tokens: int   # Output tokens
    model: str               # Model identifier used
```

---

## Rate Limiting

When OpenAI returns a 429 rate limit error during graph extraction:
1. The error is caught in the pipeline worker
2. `parse_retry_after(exc)` reads the `Retry-After` header or parses the wait time from the error message
3. A global `_rl_resume_at` timestamp is set (shared across all workers)
4. All workers check `_wait_if_rate_limited()` before each LLM call and sleep until the resume time
5. The triggering worker retries the extraction once after the wait
6. Default fallback wait: 20 seconds if no retry-after info found

This prevents all workers from firing simultaneously after a rate limit, which would cause thousands of retry attempts.
