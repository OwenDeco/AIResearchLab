from __future__ import annotations

import logging
from typing import List

from retrieval.base import BaseRetriever, RetrievedChunk
from retrieval.bm25_index import BM25Index

logger = logging.getLogger(__name__)


class LexicalRetriever(BaseRetriever):
    """BM25-based lexical retriever."""

    def __init__(self, bm25_index: BM25Index) -> None:
        self._bm25 = bm25_index

    @property
    def mode_name(self) -> str:
        return "lexical"

    def retrieve(self, query: str, top_k: int = 5) -> List[RetrievedChunk]:
        results = self._bm25.search(query, top_k=top_k)
        chunks: List[RetrievedChunk] = []
        for doc_id, chunk_id, score in results:
            chunks.append(
                RetrievedChunk(
                    chunk_id=chunk_id,
                    doc_id=doc_id,
                    content="",  # content will be populated by the caller if needed
                    score=score,
                    metadata={},
                )
            )
        return chunks
