from __future__ import annotations

import logging
from typing import List

from retrieval.base import BaseRetriever, RetrievedChunk
from retrieval.bm25_index import BM25Index

logger = logging.getLogger(__name__)


class _ChunkProxy:
    """Thin wrapper so CrossEncoderReranker can access .content on BM25 results."""

    def __init__(self, chunk_id: str, doc_id: str, content: str) -> None:
        self.chunk_id = chunk_id
        self.doc_id = doc_id
        self.content = content


class SemanticRerankRetriever(BaseRetriever):
    """
    BM25 fetch + CrossEncoder rerank retriever.

    Fetches fetch_k candidates from BM25, then reranks them with a cross-encoder
    to return the top_k most semantically relevant chunks.
    """

    def __init__(self, bm25_index: BM25Index, reranker, fetch_k: int = 50) -> None:
        self._bm25 = bm25_index
        self._reranker = reranker
        self._fetch_k = fetch_k
        # DB session will be injected so we can load chunk content
        self._db = None

    def set_db(self, db) -> None:
        """Inject a DB session for content loading."""
        self._db = db

    @property
    def mode_name(self) -> str:
        return "semantic_rerank"

    def retrieve(self, query: str, top_k: int = 5) -> List[RetrievedChunk]:
        # Step 1: Fetch candidates via BM25
        bm25_results = self._bm25.search(query, top_k=self._fetch_k)
        if not bm25_results:
            return []

        # Step 2: Load chunk content from DB (if available)
        proxies: List[_ChunkProxy] = []
        if self._db is not None:
            from models_db import Chunk as ChunkModel

            chunk_ids = [cid for _, cid, _ in bm25_results]
            chunk_rows = (
                self._db.query(ChunkModel)
                .filter(ChunkModel.id.in_(chunk_ids))
                .all()
            )
            chunk_content_map = {row.id: row for row in chunk_rows}

            for doc_id, chunk_id, _score in bm25_results:
                row = chunk_content_map.get(chunk_id)
                content = row.content if row else ""
                proxies.append(_ChunkProxy(chunk_id=chunk_id, doc_id=doc_id, content=content))
        else:
            # No DB — content will be empty; reranker will still rank by query
            for doc_id, chunk_id, _score in bm25_results:
                proxies.append(_ChunkProxy(chunk_id=chunk_id, doc_id=doc_id, content=""))

        if not proxies:
            return []

        # Step 3: CrossEncoder rerank
        try:
            reranked = self._reranker.rerank(query, proxies, top_k=top_k)
        except Exception as exc:
            logger.error("SemanticRerankRetriever: reranker failed: %s", exc)
            # Fall back to BM25 ordering
            results = []
            for proxy in proxies[:top_k]:
                results.append(
                    RetrievedChunk(
                        chunk_id=proxy.chunk_id,
                        doc_id=proxy.doc_id,
                        content=proxy.content,
                        score=0.0,
                        metadata={},
                    )
                )
            return results

        results: List[RetrievedChunk] = []
        for proxy, score in reranked:
            results.append(
                RetrievedChunk(
                    chunk_id=proxy.chunk_id,
                    doc_id=proxy.doc_id,
                    content=proxy.content,
                    score=float(score),
                    metadata={},
                )
            )
        return results
