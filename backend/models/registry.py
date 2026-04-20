from __future__ import annotations

import logging
from typing import Dict, List, Optional

from config import settings
from models.base import EmbeddingProvider, LLMProvider
from models.reranker import CrossEncoderReranker

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Lazy singleton caches
# ---------------------------------------------------------------------------

_llm_cache: Dict[str, LLMProvider] = {}
_embed_cache: Dict[str, EmbeddingProvider] = {}
_reranker_cache: Optional[CrossEncoderReranker] = None


# ---------------------------------------------------------------------------
# LLM registry
# ---------------------------------------------------------------------------

def get_llm(name: str) -> LLMProvider:
    """Return a cached LLMProvider for *name* (format: ``provider/model``)."""
    if name in _llm_cache:
        return _llm_cache[name]

    provider, _, model = name.partition("/")
    llm: LLMProvider

    if provider == "openai":
        if not settings.OPENAI_API_KEY:
            raise ValueError("OPENAI_API_KEY is not set.")
        from models.openai_provider import OpenAIProvider

        llm = OpenAIProvider(model=model, api_key=settings.OPENAI_API_KEY)

    elif provider == "azure":
        if not (settings.AZURE_OPENAI_API_KEY and settings.AZURE_OPENAI_ENDPOINT and settings.AZURE_OPENAI_DEPLOYMENT):
            raise ValueError("Azure OpenAI credentials are not fully configured.")
        from models.openai_provider import AzureOpenAIProvider

        llm = AzureOpenAIProvider(
            model=model,
            api_key=settings.AZURE_OPENAI_API_KEY,
            endpoint=settings.AZURE_OPENAI_ENDPOINT,
            deployment=settings.AZURE_OPENAI_DEPLOYMENT,
        )

    elif provider == "ollama":
        from models.ollama_provider import OllamaProvider

        llm = OllamaProvider(model=model, base_url=settings.OLLAMA_BASE_URL)

    else:
        raise ValueError(f"Unknown LLM provider: '{provider}'. Use openai/*, azure/*, or ollama/*.")

    _llm_cache[name] = llm
    return llm


# ---------------------------------------------------------------------------
# Embedding registry
# ---------------------------------------------------------------------------

def get_embedder(name: str) -> EmbeddingProvider:
    """Return a cached EmbeddingProvider for *name* (format: ``provider/model``)."""
    if name in _embed_cache:
        return _embed_cache[name]

    provider, _, model = name.partition("/")
    embedder: EmbeddingProvider

    if provider == "openai":
        if not settings.OPENAI_API_KEY:
            raise ValueError("OPENAI_API_KEY is not set.")
        from models.openai_provider import OpenAIEmbedding

        embedder = OpenAIEmbedding(model=model, api_key=settings.OPENAI_API_KEY)

    elif provider == "azure":
        if not (settings.AZURE_OPENAI_API_KEY and settings.AZURE_OPENAI_ENDPOINT and settings.AZURE_OPENAI_DEPLOYMENT):
            raise ValueError("Azure OpenAI credentials are not fully configured.")
        from models.openai_provider import AzureOpenAIEmbedding

        embedder = AzureOpenAIEmbedding(
            model=model,
            api_key=settings.AZURE_OPENAI_API_KEY,
            endpoint=settings.AZURE_OPENAI_ENDPOINT,
            deployment=settings.AZURE_OPENAI_DEPLOYMENT,
        )

    elif provider == "ollama":
        from models.ollama_provider import OllamaEmbedding

        embedder = OllamaEmbedding(model=model, base_url=settings.OLLAMA_BASE_URL)

    else:
        raise ValueError(f"Unknown embedding provider: '{provider}'. Use openai/*, azure/*, or ollama/*.")

    _embed_cache[name] = embedder
    return embedder


# ---------------------------------------------------------------------------
# Availability helpers
# ---------------------------------------------------------------------------

def available_llms() -> List[str]:
    """Return LLM provider keys whose required env vars are configured."""
    return settings.available_llms()


def available_embed_models() -> List[str]:
    """Return embedding provider keys whose required env vars are configured."""
    return settings.available_embed_models()


# ---------------------------------------------------------------------------
# Reranker
# ---------------------------------------------------------------------------

def clear_cache() -> None:
    """Invalidate all cached LLM and embedder instances (call after credential changes)."""
    global _reranker_cache
    _llm_cache.clear()
    _embed_cache.clear()
    _reranker_cache = None


def get_reranker() -> CrossEncoderReranker:
    """Return a lazily-loaded CrossEncoderReranker singleton."""
    global _reranker_cache
    if _reranker_cache is None:
        _reranker_cache = CrossEncoderReranker()
    return _reranker_cache
