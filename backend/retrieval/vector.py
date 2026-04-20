from __future__ import annotations

import logging
from typing import List

from models.base import EmbeddingProvider
from retrieval.base import BaseRetriever, RetrievedChunk

logger = logging.getLogger(__name__)


class VectorRetriever(BaseRetriever):
    """Dense vector retriever backed by ChromaDB."""

    def __init__(self, collection, embedder: EmbeddingProvider) -> None:
        self._collection = collection
        self._embedder = embedder

    @property
    def mode_name(self) -> str:
        return "vector"

    def retrieve(self, query: str, top_k: int = 5) -> List[RetrievedChunk]:
        try:
            query_embedding = self._embedder.embed_query(query)
        except Exception as exc:
            logger.error("VectorRetriever: failed to embed query: %s", exc)
            return []

        try:
            results = self._collection.query(
                query_embeddings=[query_embedding],
                n_results=min(top_k, self._collection.count() or 1),
                include=["documents", "metadatas", "distances"],
            )
        except Exception as exc:
            logger.error("VectorRetriever: ChromaDB query failed: %s", exc)
            return []

        chunks: List[RetrievedChunk] = []
        if not results or not results.get("ids"):
            return chunks

        ids = results["ids"][0]
        documents = results["documents"][0] if results.get("documents") else [""] * len(ids)
        metadatas = results["metadatas"][0] if results.get("metadatas") else [{}] * len(ids)
        distances = results["distances"][0] if results.get("distances") else [0.0] * len(ids)

        for chunk_id, content, metadata, distance in zip(ids, documents, metadatas, distances):
            # ChromaDB cosine distance: 0 = identical, 2 = opposite
            # Convert to similarity score in [0, 1]
            score = 1.0 - (distance / 2.0)
            doc_id = (metadata or {}).get("doc_id", "")
            chunks.append(
                RetrievedChunk(
                    chunk_id=chunk_id,
                    doc_id=doc_id,
                    content=content or "",
                    score=score,
                    metadata=metadata or {},
                )
            )

        return chunks
