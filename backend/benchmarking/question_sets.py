from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass, field
from typing import List

logger = logging.getLogger(__name__)

_DEFAULT_BENCHMARK_PATH = os.path.join(
    os.path.dirname(os.path.dirname(__file__)),
    "data",
    "sample_benchmark.json",
)


@dataclass
class BenchmarkQuestion:
    question: str
    reference_answer: str = ""
    doc_ids: List[str] = field(default_factory=list)


def load_question_set(path: str) -> List[BenchmarkQuestion]:
    """
    Load a benchmark question set from a JSON file.

    The file should contain a JSON array of objects with keys:
    ``question``, ``reference_answer`` (optional), ``doc_ids`` (optional).
    """
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)

    if not isinstance(data, list):
        raise ValueError(f"Expected a JSON array in {path}, got {type(data).__name__}")

    questions: List[BenchmarkQuestion] = []
    for item in data:
        if not isinstance(item, dict):
            logger.warning("Skipping non-dict item in question set: %r", item)
            continue
        questions.append(
            BenchmarkQuestion(
                question=str(item.get("question", "")),
                reference_answer=str(item.get("reference_answer", "")),
                doc_ids=list(item.get("doc_ids", [])),
            )
        )

    return questions


def save_question_set(questions: List[BenchmarkQuestion], path: str) -> None:
    """Persist a question set to a JSON file."""
    data = [
        {
            "question": q.question,
            "reference_answer": q.reference_answer,
            "doc_ids": q.doc_ids,
        }
        for q in questions
    ]
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2, ensure_ascii=False)


def get_default_question_set() -> List[BenchmarkQuestion]:
    """Load and return the built-in sample benchmark question set."""
    return load_question_set(_DEFAULT_BENCHMARK_PATH)
