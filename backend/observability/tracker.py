from __future__ import annotations

import time
from typing import Dict, Optional


# ---------------------------------------------------------------------------
# Cost table (USD per 1 000 tokens)
# ---------------------------------------------------------------------------

COST_PER_1K_TOKENS: Dict[str, Dict[str, float]] = {
    # OpenAI
    "gpt-4o": {"prompt": 0.0025, "completion": 0.01},
    "gpt-4o-mini": {"prompt": 0.00015, "completion": 0.0006},
    "gpt-4": {"prompt": 0.03, "completion": 0.06},
    "gpt-4-turbo": {"prompt": 0.01, "completion": 0.03},
    "gpt-3.5-turbo": {"prompt": 0.0005, "completion": 0.0015},
    # Azure mirrors (same pricing as base model)
    "azure/gpt-4o": {"prompt": 0.0025, "completion": 0.01},
    "azure/gpt-4o-mini": {"prompt": 0.00015, "completion": 0.0006},
    "azure/gpt-4": {"prompt": 0.03, "completion": 0.06},
    # Ollama – local, free
    "ollama": {"prompt": 0.0, "completion": 0.0},
    # Anthropic / Claude
    "claude-opus-4-7":          {"prompt": 0.015,   "completion": 0.075},
    "claude-sonnet-4-6":        {"prompt": 0.003,   "completion": 0.015},
    "claude-haiku-4-5":         {"prompt": 0.0008,  "completion": 0.004},
    "claude-3-5-sonnet-20241022": {"prompt": 0.003, "completion": 0.015},
    "claude-3-5-haiku-20241022":  {"prompt": 0.0008,"completion": 0.004},
    "claude-3-opus-20240229":     {"prompt": 0.015,  "completion": 0.075},
}

_FALLBACK_COST = {"prompt": 0.001, "completion": 0.002}


def _lookup_cost(model: str) -> Dict[str, float]:
    """Return cost table entry for *model*, falling back gracefully."""
    # Exact match
    if model in COST_PER_1K_TOKENS:
        return COST_PER_1K_TOKENS[model]
    # Strip provider prefix (openai/gpt-4o-mini → gpt-4o-mini)
    _, _, bare = model.rpartition("/")
    if bare in COST_PER_1K_TOKENS:
        return COST_PER_1K_TOKENS[bare]
    # Ollama family
    if model.startswith("ollama"):
        return COST_PER_1K_TOKENS["ollama"]
    return _FALLBACK_COST


def _estimate_cost(prompt_tokens: int, completion_tokens: int, model: str) -> float:
    costs = _lookup_cost(model)
    return (prompt_tokens / 1000.0) * costs["prompt"] + (completion_tokens / 1000.0) * costs["completion"]


# ---------------------------------------------------------------------------
# StageTimer – context manager
# ---------------------------------------------------------------------------

class StageTimer:
    """Context manager that records elapsed wall-clock time for a named stage."""

    def __init__(self, name: str, tracker: "RunTracker") -> None:
        self.name = name
        self._tracker = tracker
        self._start: float = 0.0

    def __enter__(self) -> "StageTimer":
        self._start = time.perf_counter()
        return self

    def __exit__(self, *_) -> None:
        elapsed_ms = (time.perf_counter() - self._start) * 1000.0
        self._tracker._stage_timings[self.name] = elapsed_ms


# ---------------------------------------------------------------------------
# RunTracker
# ---------------------------------------------------------------------------

class RunTracker:
    """Accumulates all metrics for a single query run."""

    def __init__(self) -> None:
        self._stage_timings: Dict[str, float] = {}
        self._prompt_tokens: int = 0
        self._completion_tokens: int = 0
        self._model: str = ""
        self._graph_node_count: int = 0
        self._chunk_count: int = 0
        self._run_start: float = time.perf_counter()

    # ------------------------------------------------------------------
    # Stage timing
    # ------------------------------------------------------------------

    def start_stage(self, name: str) -> StageTimer:
        """Return a context manager that records elapsed time for *name*."""
        return StageTimer(name=name, tracker=self)

    # ------------------------------------------------------------------
    # Token / cost tracking
    # ------------------------------------------------------------------

    def record_tokens(self, prompt: int, completion: int, model: str) -> None:
        self._prompt_tokens += prompt
        self._completion_tokens += completion
        if model:
            self._model = model

    # ------------------------------------------------------------------
    # Retrieval metrics
    # ------------------------------------------------------------------

    def record_graph_nodes(self, count: int) -> None:
        self._graph_node_count = count

    def record_chunks(self, count: int) -> None:
        self._chunk_count = count

    # ------------------------------------------------------------------
    # Serialisation
    # ------------------------------------------------------------------

    def to_dict(self) -> dict:
        """Return a flat dict with all tracked metrics."""
        total_elapsed_ms = (time.perf_counter() - self._run_start) * 1000.0
        cost = _estimate_cost(self._prompt_tokens, self._completion_tokens, self._model)
        return {
            "stage_timings": self._stage_timings,
            "prompt_tokens": self._prompt_tokens,
            "completion_tokens": self._completion_tokens,
            "total_tokens": self._prompt_tokens + self._completion_tokens,
            "estimated_cost_usd": cost,
            "model": self._model,
            "graph_node_count": self._graph_node_count,
            "chunk_count": self._chunk_count,
            "total_elapsed_ms": total_elapsed_ms,
        }
