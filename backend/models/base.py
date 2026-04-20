from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, List, Optional, runtime_checkable
from typing import Protocol


@dataclass
class LLMResponse:
    content: str
    prompt_tokens: int
    completion_tokens: int
    model: str
    tool_calls: Optional[List[Any]] = field(default=None)


@runtime_checkable
class LLMProvider(Protocol):
    def complete(
        self,
        messages: List[dict],
        temperature: float = 0.0,
        max_tokens: int = 2048,
    ) -> LLMResponse:
        ...

    @property
    def model_name(self) -> str:
        ...


@runtime_checkable
class EmbeddingProvider(Protocol):
    def embed(self, texts: List[str]) -> List[List[float]]:
        ...

    def embed_query(self, text: str) -> List[float]:
        ...

    @property
    def model_name(self) -> str:
        ...
