from __future__ import annotations

import logging
import re
import time
from typing import List

from tenacity import (
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
)

from models.base import LLMResponse

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Rate limit helpers — used by pipeline for global backoff
# ---------------------------------------------------------------------------

def parse_retry_after(exc) -> float:
    """
    Extract the wait time (seconds) from a RateLimitError.
    Checks the Retry-After header first, then the error message text.
    Returns 20.0 as a safe fallback if nothing is found.
    """
    # 1. HTTP header
    try:
        val = exc.response.headers.get("retry-after", "")
        if val:
            return float(val) + 1.0
    except Exception:
        pass

    # 2. Error message: "Please try again in 1.234s" or "retry after 20 seconds"
    try:
        msg = str(exc)
        match = re.search(r"try again in\s+([\d.]+)\s*s", msg, re.IGNORECASE)
        if not match:
            match = re.search(r"retry after\s+([\d.]+)", msg, re.IGNORECASE)
        if match:
            return float(match.group(1)) + 1.0
    except Exception:
        pass

    return 20.0  # safe fallback


# ---------------------------------------------------------------------------
# Retry decorator — connection errors only, NOT rate limits
# Rate limits are handled globally at the pipeline level to avoid
# all workers independently retrying and amplifying the problem.
# ---------------------------------------------------------------------------

def _openai_retry(func):
    """Apply tenacity retry on APIConnectionError only."""
    try:
        from openai import APIConnectionError  # type: ignore
    except ImportError:
        return func

    return retry(
        retry=retry_if_exception_type(APIConnectionError),
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=2, max=10),
        reraise=True,
    )(func)


# ---------------------------------------------------------------------------
# OpenAI LLM
# ---------------------------------------------------------------------------

class OpenAIProvider:
    """LLM provider backed by the OpenAI API."""

    def __init__(self, model: str = "gpt-4o-mini", api_key: str = "") -> None:
        from openai import OpenAI  # type: ignore

        self._model = model
        # Disable SDK built-in retries — we handle rate limits ourselves so
        # the SDK doesn't fire 0.5 s retries that ignore the Retry-After header.
        self._client = OpenAI(api_key=api_key or None, max_retries=0)

    @property
    def model_name(self) -> str:
        return f"openai/{self._model}"

    def complete(
        self,
        messages: List[dict],
        temperature: float = 0.0,
        max_tokens: int = 2048,
    ) -> LLMResponse:
        from openai import RateLimitError  # type: ignore

        for attempt in range(6):
            try:
                return self._complete_with_retry(messages, temperature, max_tokens)
            except RateLimitError as exc:
                wait = parse_retry_after(exc)
                logger.warning(
                    "OpenAIProvider: rate-limited (attempt %d/6), waiting %.1fs — %s",
                    attempt + 1, wait, exc,
                )
                time.sleep(wait)
        # Final attempt — let the exception propagate
        return self._complete_with_retry(messages, temperature, max_tokens)

    @_openai_retry
    def _complete_with_retry(
        self,
        messages: List[dict],
        temperature: float,
        max_tokens: int,
    ) -> LLMResponse:
        response = self._client.chat.completions.create(
            model=self._model,
            messages=messages,
            temperature=temperature,
            max_completion_tokens=max_tokens,
        )
        choice = response.choices[0]
        usage = response.usage
        return LLMResponse(
            content=choice.message.content or "",
            prompt_tokens=usage.prompt_tokens if usage else 0,
            completion_tokens=usage.completion_tokens if usage else 0,
            model=self._model,
        )

    def complete_with_tools(
        self,
        messages: List[dict],
        tools: List[dict],
        temperature: float = 0.0,
        max_tokens: int = 2048,
    ) -> LLMResponse:
        from openai import RateLimitError  # type: ignore

        for attempt in range(6):
            try:
                return self._complete_with_tools_retry(messages, tools, temperature, max_tokens)
            except RateLimitError as exc:
                wait = parse_retry_after(exc)
                logger.warning(
                    "OpenAIProvider: rate-limited on tool call (attempt %d/6), waiting %.1fs",
                    attempt + 1, wait,
                )
                time.sleep(wait)
        return self._complete_with_tools_retry(messages, tools, temperature, max_tokens)

    @_openai_retry
    def _complete_with_tools_retry(
        self,
        messages: List[dict],
        tools: List[dict],
        temperature: float,
        max_tokens: int,
    ) -> LLMResponse:
        response = self._client.chat.completions.create(
            model=self._model,
            messages=messages,
            temperature=temperature,
            max_completion_tokens=max_tokens,
            tools=tools,
            tool_choice="auto",
        )
        choice = response.choices[0]
        usage = response.usage
        tool_calls = None
        if choice.message.tool_calls:
            tool_calls = [
                {
                    "id": tc.id,
                    "type": "function",
                    "function": {"name": tc.function.name, "arguments": tc.function.arguments},
                }
                for tc in choice.message.tool_calls
            ]
        return LLMResponse(
            content=choice.message.content or "",
            prompt_tokens=usage.prompt_tokens if usage else 0,
            completion_tokens=usage.completion_tokens if usage else 0,
            model=self._model,
            tool_calls=tool_calls,
        )


# ---------------------------------------------------------------------------
# Azure OpenAI LLM
# ---------------------------------------------------------------------------

class AzureOpenAIProvider:
    """LLM provider backed by Azure OpenAI."""

    def __init__(
        self,
        model: str,
        api_key: str,
        endpoint: str,
        deployment: str,
        api_version: str = "2024-02-01",
    ) -> None:
        from openai import AzureOpenAI  # type: ignore

        self._model = model
        self._deployment = deployment
        self._client = AzureOpenAI(
            api_key=api_key,
            azure_endpoint=endpoint,
            api_version=api_version,
            max_retries=0,
        )

    @property
    def model_name(self) -> str:
        return f"azure/{self._deployment}"

    def complete(
        self,
        messages: List[dict],
        temperature: float = 0.0,
        max_tokens: int = 2048,
    ) -> LLMResponse:
        from openai import RateLimitError  # type: ignore

        for attempt in range(6):
            try:
                return self._complete_with_retry(messages, temperature, max_tokens)
            except RateLimitError as exc:
                wait = parse_retry_after(exc)
                logger.warning(
                    "AzureOpenAIProvider: rate-limited (attempt %d/6), waiting %.1fs — %s",
                    attempt + 1, wait, exc,
                )
                time.sleep(wait)
        return self._complete_with_retry(messages, temperature, max_tokens)

    @_openai_retry
    def _complete_with_retry(
        self,
        messages: List[dict],
        temperature: float,
        max_tokens: int,
    ) -> LLMResponse:
        response = self._client.chat.completions.create(
            model=self._deployment,
            messages=messages,
            temperature=temperature,
            max_completion_tokens=max_tokens,
        )
        choice = response.choices[0]
        usage = response.usage
        return LLMResponse(
            content=choice.message.content or "",
            prompt_tokens=usage.prompt_tokens if usage else 0,
            completion_tokens=usage.completion_tokens if usage else 0,
            model=self._deployment,
        )

    def complete_with_tools(
        self,
        messages: List[dict],
        tools: List[dict],
        temperature: float = 0.0,
        max_tokens: int = 2048,
    ) -> LLMResponse:
        from openai import RateLimitError  # type: ignore

        for attempt in range(6):
            try:
                return self._complete_with_tools_retry(messages, tools, temperature, max_tokens)
            except RateLimitError as exc:
                wait = parse_retry_after(exc)
                logger.warning(
                    "AzureOpenAIProvider: rate-limited on tool call (attempt %d/6), waiting %.1fs",
                    attempt + 1, wait,
                )
                time.sleep(wait)
        return self._complete_with_tools_retry(messages, tools, temperature, max_tokens)

    @_openai_retry
    def _complete_with_tools_retry(
        self,
        messages: List[dict],
        tools: List[dict],
        temperature: float,
        max_tokens: int,
    ) -> LLMResponse:
        response = self._client.chat.completions.create(
            model=self._deployment,
            messages=messages,
            temperature=temperature,
            max_completion_tokens=max_tokens,
            tools=tools,
            tool_choice="auto",
        )
        choice = response.choices[0]
        usage = response.usage
        tool_calls = None
        if choice.message.tool_calls:
            tool_calls = [
                {
                    "id": tc.id,
                    "type": "function",
                    "function": {"name": tc.function.name, "arguments": tc.function.arguments},
                }
                for tc in choice.message.tool_calls
            ]
        return LLMResponse(
            content=choice.message.content or "",
            prompt_tokens=usage.prompt_tokens if usage else 0,
            completion_tokens=usage.completion_tokens if usage else 0,
            model=self._deployment,
            tool_calls=tool_calls,
        )


# ---------------------------------------------------------------------------
# OpenAI Embedding
# ---------------------------------------------------------------------------

class OpenAIEmbedding:
    """Embedding provider backed by the OpenAI API."""

    def __init__(
        self,
        model: str = "text-embedding-3-small",
        api_key: str = "",
    ) -> None:
        from openai import OpenAI  # type: ignore

        self._model = model
        self._client = OpenAI(api_key=api_key or None, max_retries=0)

    @property
    def model_name(self) -> str:
        return f"openai/{self._model}"

    def embed(self, texts: List[str]) -> List[List[float]]:
        from openai import RateLimitError  # type: ignore

        for attempt in range(6):
            try:
                return self._embed_with_retry(texts)
            except RateLimitError as exc:
                wait = parse_retry_after(exc)
                logger.warning(
                    "OpenAIEmbedding: rate-limited (attempt %d/6), waiting %.1fs",
                    attempt + 1, wait,
                )
                time.sleep(wait)
        return self._embed_with_retry(texts)

    def embed_query(self, text: str) -> List[float]:
        return self.embed([text])[0]

    @_openai_retry
    def _embed_with_retry(self, texts: List[str]) -> List[List[float]]:
        response = self._client.embeddings.create(model=self._model, input=texts)
        return [item.embedding for item in response.data]


# ---------------------------------------------------------------------------
# Azure OpenAI Embedding
# ---------------------------------------------------------------------------

class AzureOpenAIEmbedding:
    """Embedding provider backed by Azure OpenAI."""

    def __init__(
        self,
        model: str,
        api_key: str,
        endpoint: str,
        deployment: str,
        api_version: str = "2024-02-01",
    ) -> None:
        from openai import AzureOpenAI  # type: ignore

        self._model = model
        self._deployment = deployment
        self._client = AzureOpenAI(
            api_key=api_key,
            azure_endpoint=endpoint,
            api_version=api_version,
            max_retries=0,
        )

    @property
    def model_name(self) -> str:
        return f"azure/{self._deployment}"

    def embed(self, texts: List[str]) -> List[List[float]]:
        from openai import RateLimitError  # type: ignore

        for attempt in range(6):
            try:
                return self._embed_with_retry(texts)
            except RateLimitError as exc:
                wait = parse_retry_after(exc)
                logger.warning(
                    "AzureOpenAIEmbedding: rate-limited (attempt %d/6), waiting %.1fs",
                    attempt + 1, wait,
                )
                time.sleep(wait)
        return self._embed_with_retry(texts)

    def embed_query(self, text: str) -> List[float]:
        return self.embed([text])[0]

    @_openai_retry
    def _embed_with_retry(self, texts: List[str]) -> List[List[float]]:
        response = self._client.embeddings.create(model=self._deployment, input=texts)
        return [item.embedding for item in response.data]
