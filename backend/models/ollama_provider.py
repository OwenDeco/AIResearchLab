from __future__ import annotations

import logging
from typing import List

import httpx

from models.base import LLMResponse

logger = logging.getLogger(__name__)

_DEFAULT_TIMEOUT = 120.0  # seconds


class OllamaProvider:
    """LLM provider that calls a local Ollama server via its REST API."""

    def __init__(self, model: str = "llama3", base_url: str = "http://localhost:11434") -> None:
        self._model = model
        self._base_url = base_url.rstrip("/")

    @property
    def model_name(self) -> str:
        return f"ollama/{self._model}"

    def complete(
        self,
        messages: List[dict],
        temperature: float = 0.0,
        max_tokens: int = 2048,
    ) -> LLMResponse:
        url = f"{self._base_url}/api/chat"
        payload = {
            "model": self._model,
            "messages": messages,
            "stream": False,
            "options": {
                "temperature": temperature,
                "num_predict": max_tokens,
            },
        }
        try:
            with httpx.Client(timeout=_DEFAULT_TIMEOUT) as client:
                response = client.post(url, json=payload)
                response.raise_for_status()
                data = response.json()
        except httpx.HTTPError as exc:
            logger.error("OllamaProvider.complete failed: %s", exc)
            raise

        content = data.get("message", {}).get("content", "") or ""
        # Ollama doesn't always return token counts; estimate from text length
        prompt_text = " ".join(m.get("content", "") for m in messages)
        prompt_tokens = len(prompt_text) // 4
        completion_tokens = len(content) // 4

        return LLMResponse(
            content=content,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            model=self._model,
        )


class OllamaEmbedding:
    """Embedding provider that calls a local Ollama server."""

    def __init__(
        self,
        model: str = "nomic-embed-text",
        base_url: str = "http://localhost:11434",
    ) -> None:
        self._model = model
        self._base_url = base_url.rstrip("/")

    @property
    def model_name(self) -> str:
        return f"ollama/{self._model}"

    def embed(self, texts: List[str]) -> List[List[float]]:
        url = f"{self._base_url}/api/embeddings"
        embeddings: List[List[float]] = []
        with httpx.Client(timeout=_DEFAULT_TIMEOUT) as client:
            for text in texts:
                payload = {"model": self._model, "prompt": text}
                try:
                    response = client.post(url, json=payload)
                    response.raise_for_status()
                    data = response.json()
                    embeddings.append(data.get("embedding", []))
                except httpx.HTTPError as exc:
                    logger.error("OllamaEmbedding.embed failed for text snippet: %s", exc)
                    raise
        return embeddings

    def embed_query(self, text: str) -> List[float]:
        return self.embed([text])[0]
