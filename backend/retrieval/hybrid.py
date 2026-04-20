from __future__ import annotations

import logging
from typing import Dict, List, Tuple

from models.base import EmbeddingProvider
from retrieval.base import BaseRetriever, RetrievedChunk
from retrieval.bm25_index import BM25Index
from retrieval.lexical import LexicalRetriever
from retrieval.vector import VectorRetriever

logger = logging.getLogger(__name__)


class HybridRetriever(BaseRetriever):
    """
    Hybrid retriever combining BM25 and vector search via Reciprocal Rank Fusion (RRF).

    alpha=0 means pure lexical, alpha=1 means pure vector.
    """

    def __init__(
        self,
        bm25_index: BM25Index,
        collection,
        embedder: EmbeddingProvider,
        alpha: float = 0.5,
        rrf_k: int = 60,
    ) -> None:
        self._lexical = LexicalRetriever(bm25_index)
        self._vector = VectorRetriever(collection, embedder)
        self._alpha = alpha
        self._rrf_k = rrf_k

    @property
    def mode_name(self) -> str:
        return "hybrid"

    def retrieve(self, query: str, top_k: int = 5) -> List[RetrievedChunk]:
        fetch_k = top_k * 3

        # Retrieve from both sources
        lexical_results = self._lexical.retrieve(query, top_k=fetch_k)
        vector_results = self._vector.retrieve(query, top_k=fetch_k)

        # Build chunk_id -> RetrievedChunk mapping
        chunk_map: Dict[str, RetrievedChunk] = {}
        for chunk in lexical_results:
            chunk_map[chunk.chunk_id] = chunk
        for chunk in vector_results:
            if chunk.chunk_id not in chunk_map:
                chunk_map[chunk.chunk_id] = chunk

        # Compute RRF scores
        rrf_scores: Dict[str, float] = {}
        k = self._rrf_k

        # Lexical ranks (weighted by 1-alpha)
        for rank, chunk in enumerate(lexical_results, start=1):
            rrf_scores[chunk.chunk_id] = rrf_scores.get(chunk.chunk_id, 0.0) + (
                (1.0 - self._alpha) * (1.0 / (k + rank))
            )

        # Vector ranks (weighted by alpha)
        for rank, chunk in enumerate(vector_results, start=1):
            rrf_scores[chunk.chunk_id] = rrf_scores.get(chunk.chunk_id, 0.0) + (
                self._alpha * (1.0 / (k + rank))
            )

        # Sort by fused score descending
        sorted_ids = sorted(rrf_scores.keys(), key=lambda cid: rrf_scores[cid], reverse=True)

        results: List[RetrievedChunk] = []
        for chunk_id in sorted_ids[:top_k]:
            chunk = chunk_map[chunk_id]
            results.append(
                RetrievedChunk(
                    chunk_id=chunk.chunk_id,
                    doc_id=chunk.doc_id,
                    content=chunk.content,
                    score=rrf_scores[chunk_id],
                    metadata=chunk.metadata,
                )
            )

        return results
