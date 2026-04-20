from __future__ import annotations

import logging
import math
from typing import List, Optional

logger = logging.getLogger(__name__)

# Common English stopwords for keyword overlap
_STOPWORDS = {
    "the", "a", "an", "in", "on", "of", "to", "for", "is", "are", "was",
    "were", "it", "its", "this", "that", "these", "those", "with", "and",
    "or", "but", "not", "from", "by", "as", "at", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "can",
    "could", "should", "may", "might", "shall", "must", "also", "such",
    "each", "which", "who", "whom", "when", "where", "how", "what",
    "i", "we", "you", "he", "she", "they", "them", "their", "our", "your",
    "about", "into", "than", "then", "so", "if", "all", "any", "some",
    "there", "their", "they", "one", "two", "more", "other",
}


def _tokenize(text: str) -> set:
    """Lowercase, split on whitespace and punctuation, remove stopwords."""
    import re
    tokens = re.findall(r"[a-z0-9]+", text.lower())
    return {t for t in tokens if t not in _STOPWORDS and len(t) > 1}


def keyword_overlap(text1: str, text2: str) -> float:
    """
    Jaccard similarity of the meaningful word sets of *text1* and *text2*.

    Returns a float in [0.0, 1.0].
    """
    words1 = _tokenize(text1)
    words2 = _tokenize(text2)
    if not words1 and not words2:
        return 1.0
    if not words1 or not words2:
        return 0.0
    intersection = words1 & words2
    union = words1 | words2
    return len(intersection) / len(union)


def _is_relevant(chunk_text: str, reference_answer: str) -> bool:
    """True if the chunk shares at least one meaningful keyword with the reference answer."""
    ref_words = _tokenize(reference_answer)
    chunk_words = _tokenize(chunk_text)
    return bool(ref_words and chunk_words and ref_words & chunk_words)


def context_precision(
    retrieved_chunks: List[str],
    reference_answer: str,
) -> float:
    """
    Fraction of retrieved chunks that are relevant to the reference answer.
    Range: [0.0, 1.0].
    """
    if not retrieved_chunks or not reference_answer.strip():
        return 0.0
    relevant = sum(1 for c in retrieved_chunks if _is_relevant(c, reference_answer))
    return relevant / len(retrieved_chunks)


def hit_rate(retrieved_chunks: List[str], reference_answer: str) -> float:
    """
    1.0 if at least one retrieved chunk is relevant to the reference answer, else 0.0.
    Equivalent to Recall@K when K = len(retrieved_chunks).
    """
    if not retrieved_chunks or not reference_answer.strip():
        return 0.0
    return 1.0 if any(_is_relevant(c, reference_answer) for c in retrieved_chunks) else 0.0


def mrr(retrieved_chunks: List[str], reference_answer: str) -> float:
    """
    Reciprocal rank of the first relevant chunk.
    MRR = 1/rank if a relevant chunk is found, else 0.
    """
    if not retrieved_chunks or not reference_answer.strip():
        return 0.0
    for i, chunk in enumerate(retrieved_chunks):
        if _is_relevant(chunk, reference_answer):
            return 1.0 / (i + 1)
    return 0.0


def answer_correctness(
    answer: str,
    reference_answer: str,
    embedder=None,
) -> float:
    """
    Semantic similarity between the generated answer and the reference answer.
    Uses embedding cosine similarity when an embedder is available, otherwise
    falls back to keyword overlap.  Range: [0.0, 1.0].
    """
    if not answer.strip() or not reference_answer.strip():
        return 0.0
    if embedder is not None:
        try:
            embeddings = embedder.embed([answer, reference_answer])
            return _cosine_similarity(embeddings[0], embeddings[1])
        except Exception as exc:
            logger.warning("answer_correctness: embedding failed, using keyword overlap: %s", exc)
    return keyword_overlap(answer, reference_answer)


def faithfulness(answer: str, retrieved_chunks: List[str]) -> float:
    """
    Fraction of answer keywords that appear in the retrieved context.
    Approximates whether the answer is grounded in the retrieved chunks.
    Range: [0.0, 1.0].
    """
    if not answer.strip() or not retrieved_chunks:
        return 0.0
    answer_words = _tokenize(answer)
    if not answer_words:
        return 0.0
    context_words: set = set()
    for chunk in retrieved_chunks:
        context_words |= _tokenize(chunk)
    return len(answer_words & context_words) / len(answer_words)


def answer_relevance(
    answer: str,
    question: str,
    embedder=None,
) -> float:
    """
    Measure how relevant *answer* is to *question*.

    If *embedder* is provided, computes cosine similarity between their
    embeddings.  Otherwise falls back to keyword overlap (Jaccard).

    Returns a float in [0.0, 1.0].
    """
    if not answer.strip() or not question.strip():
        return 0.0

    if embedder is not None:
        try:
            embeddings = embedder.embed([answer, question])
            vec_a = embeddings[0]
            vec_q = embeddings[1]
            return _cosine_similarity(vec_a, vec_q)
        except Exception as exc:
            logger.warning(
                "answer_relevance: embedding failed, falling back to keyword overlap: %s", exc
            )

    return keyword_overlap(answer, question)


def _cosine_similarity(vec_a: List[float], vec_b: List[float]) -> float:
    """Compute cosine similarity between two vectors."""
    if not vec_a or not vec_b or len(vec_a) != len(vec_b):
        return 0.0
    dot = sum(a * b for a, b in zip(vec_a, vec_b))
    mag_a = math.sqrt(sum(a * a for a in vec_a))
    mag_b = math.sqrt(sum(b * b for b in vec_b))
    if mag_a == 0.0 or mag_b == 0.0:
        return 0.0
    similarity = dot / (mag_a * mag_b)
    # Clamp to [0, 1] — cosine can be negative but relevance shouldn't be
    return max(0.0, min(1.0, (similarity + 1.0) / 2.0))
