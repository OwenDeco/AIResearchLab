from __future__ import annotations

import logging
from typing import List, Optional

import numpy as np

from chunking.base import BaseChunker, ChunkData
from chunking.fixed import FixedSizeChunker

logger = logging.getLogger(__name__)


def _cosine_distance(a: List[float], b: List[float]) -> float:
    """Return 1 - cosine_similarity between two vectors."""
    va = np.array(a, dtype=np.float32)
    vb = np.array(b, dtype=np.float32)
    norm_a = np.linalg.norm(va)
    norm_b = np.linalg.norm(vb)
    if norm_a == 0 or norm_b == 0:
        return 1.0
    return float(1.0 - np.dot(va, vb) / (norm_a * norm_b))


def _ensure_punkt() -> None:
    import nltk  # type: ignore

    for resource in ("punkt", "punkt_tab"):
        try:
            nltk.data.find(f"tokenizers/{resource}")
        except LookupError:
            try:
                nltk.download(resource, quiet=True)
            except Exception:
                pass


class SemanticChunker(BaseChunker):
    """
    Place chunk boundaries where consecutive sentences are semantically distant.

    Uses an *embedder* (any object with an ``embed(texts) -> list[list[float]]``
    method) to compute sentence embeddings, then finds cosine-distance peaks
    above *percentile_threshold* as split points.

    Any semantic chunk that still exceeds *max_chunk_tokens* characters is
    further split by :class:`FixedSizeChunker` so no chunk grows unboundedly.

    Falls back to :class:`FixedSizeChunker` when the embedder is ``None`` or
    when embedding raises an exception.
    """

    # 512 tokens ≈ 2 000 chars is the widely-accepted upper bound for most
    # embedding models (text-embedding-3-* supports 8 192 tokens, but keeping
    # chunks ≤ 512 tokens gives better retrieval precision in practice).
    DEFAULT_MAX_CHUNK_TOKENS: int = 512

    def __init__(
        self,
        embedder=None,
        percentile_threshold: int = 95,
        fallback_chunk_size: int = 512,
        max_chunk_tokens: int = DEFAULT_MAX_CHUNK_TOKENS,
    ) -> None:
        self.embedder = embedder
        self.percentile_threshold = percentile_threshold
        self.fallback_chunk_size = fallback_chunk_size
        # Approximate: 1 token ≈ 4 characters
        self.max_chunk_chars: int = max_chunk_tokens * 4
        _ensure_punkt()

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    def _get_sentences(self, text: str) -> List[str]:
        try:
            import nltk  # type: ignore

            return [s for s in nltk.sent_tokenize(text) if s.strip()]
        except Exception:
            return [s.strip() for s in text.split(". ") if s.strip()]

    def _embed_sentences(self, sentences: List[str]) -> Optional[List[List[float]]]:
        if self.embedder is None:
            return None
        try:
            return self.embedder.embed(sentences)
        except Exception as exc:
            logger.warning("SemanticChunker: embedding failed (%s), falling back to fixed chunking.", exc)
            return None

    def _split_oversized(self, chunks: List[ChunkData], doc_id: str) -> List[ChunkData]:
        """Force-split any chunk whose text exceeds max_chunk_chars."""
        result: List[ChunkData] = []
        splitter = FixedSizeChunker(chunk_size=self.fallback_chunk_size, chunk_overlap=0)
        for chunk in chunks:
            if len(chunk.content) <= self.max_chunk_chars:
                result.append(chunk)
            else:
                sub_chunks = splitter.chunk(chunk.content, doc_id)
                for sc in sub_chunks:
                    sc.metadata["chunker"] = "semantic_oversized_split"
                    sc.metadata["percentile_threshold"] = self.percentile_threshold
                result.extend(sub_chunks)
        return result

    def _find_split_indices(self, embeddings: List[List[float]]) -> List[int]:
        """Return sentence indices (0-based) where a new chunk should start."""
        if len(embeddings) < 2:
            return []

        distances = [
            _cosine_distance(embeddings[i], embeddings[i + 1])
            for i in range(len(embeddings) - 1)
        ]

        threshold = float(np.percentile(distances, self.percentile_threshold))
        split_indices: List[int] = []
        for i, dist in enumerate(distances):
            if dist >= threshold:
                split_indices.append(i + 1)  # i+1 is the first sentence of the new chunk

        return split_indices

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def chunk(self, text: str, doc_id: str) -> List[ChunkData]:
        sentences = self._get_sentences(text)

        if len(sentences) == 0:
            return []

        # Attempt semantic splitting
        embeddings = self._embed_sentences(sentences)

        if embeddings is None:
            # Fallback to fixed-size chunking
            logger.debug("SemanticChunker: using fixed fallback.")
            fallback = FixedSizeChunker(chunk_size=self.fallback_chunk_size, chunk_overlap=0)
            chunks = fallback.chunk(text, doc_id)
            for c in chunks:
                c.metadata["chunker"] = "semantic_fallback"
            return chunks

        split_indices = self._find_split_indices(embeddings)
        split_set = set(split_indices)

        # Build groups of sentences
        groups: List[List[str]] = []
        current_group: List[str] = []
        for i, sentence in enumerate(sentences):
            if i in split_set and current_group:
                groups.append(current_group)
                current_group = []
            current_group.append(sentence)
        if current_group:
            groups.append(current_group)

        # Convert groups to ChunkData
        chunks: List[ChunkData] = []
        char_pos = 0
        for chunk_index, group in enumerate(groups):
            content = " ".join(group)
            start = char_pos
            end = char_pos + len(content)
            chunks.append(
                ChunkData(
                    content=content,
                    chunk_index=chunk_index,
                    start_char=start,
                    end_char=end,
                    metadata={
                        "chunker": "semantic",
                        "percentile_threshold": self.percentile_threshold,
                        "sentence_count": len(group),
                    },
                )
            )
            char_pos = end + 1  # +1 for implicit space between chunks

        return self._split_oversized(chunks, doc_id)
