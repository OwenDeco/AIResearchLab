from __future__ import annotations

import logging
from typing import Dict, List, Tuple

logger = logging.getLogger(__name__)


class BM25Index:
    """
    Wrapper around rank_bm25.BM25Okapi that maintains a corpus of
    (doc_id, chunk_id, text) entries.

    The index is rebuilt lazily whenever ``dirty`` is True and a query
    is issued.  Call ``rebuild()`` explicitly (or use the ``dirty`` flag
    via :func:`api.deps.get_bm25_index`) to trigger a rebuild.
    """

    def __init__(self) -> None:
        self._documents: List[Dict[str, str]] = []  # {"doc_id", "chunk_id", "text"}
        self._bm25 = None  # rank_bm25.BM25Okapi instance
        self.dirty: bool = False

    # ------------------------------------------------------------------
    # Mutation
    # ------------------------------------------------------------------

    def add_document(self, doc_id: str, chunk_id: str, text: str) -> None:
        """Append a document to the corpus and mark the index as dirty."""
        self._documents.append({"doc_id": doc_id, "chunk_id": chunk_id, "text": text})
        self.dirty = True

    def remove_by_doc_id(self, doc_id: str) -> None:
        """Remove all entries for *doc_id* and mark index dirty."""
        self._documents = [d for d in self._documents if d["doc_id"] != doc_id]
        self.dirty = True

    def rebuild(self) -> None:
        """Rebuild the BM25 index from the current corpus."""
        if not self._documents:
            self._bm25 = None
            self.dirty = False
            return
        try:
            from rank_bm25 import BM25Okapi  # type: ignore

            tokenised = [doc["text"].lower().split() for doc in self._documents]
            self._bm25 = BM25Okapi(tokenised)
            self.dirty = False
            logger.info("BM25Index: rebuilt with %d documents.", len(self._documents))
        except Exception as exc:
            logger.error("BM25Index.rebuild failed: %s", exc)
            self._bm25 = None
            self.dirty = False

    def load_from_db(self, db) -> None:
        """Populate the index from all Chunk records in the database."""
        from models_db import Chunk  # avoid circular import

        self._documents = []
        chunks = db.query(Chunk).all()
        for chunk in chunks:
            # Skip parent chunks — only index leaf / embeddable chunks
            import json
            try:
                meta = json.loads(chunk.metadata_json or "{}")
            except Exception:
                meta = {}
            if meta.get("is_parent"):
                continue
            self._documents.append({
                "doc_id": chunk.doc_id,
                "chunk_id": chunk.id,
                "text": chunk.content,
            })
        self.dirty = True
        self.rebuild()
        logger.info("BM25Index: loaded %d chunks from database.", len(self._documents))

    # ------------------------------------------------------------------
    # Query
    # ------------------------------------------------------------------

    def search(self, query: str, top_k: int = 5) -> List[Tuple[str, str, float]]:
        """
        Search the index for *query*.

        Returns
        -------
        list of (doc_id, chunk_id, score) tuples sorted by descending score.
        """
        if self.dirty:
            self.rebuild()
        if self._bm25 is None or not self._documents:
            return []

        tokens = query.lower().split()
        scores = self._bm25.get_scores(tokens)

        ranked = sorted(
            zip(range(len(scores)), scores),
            key=lambda x: x[1],
            reverse=True,
        )[:top_k]

        results: List[Tuple[str, str, float]] = []
        for idx, score in ranked:
            if score > 0:
                doc = self._documents[idx]
                results.append((doc["doc_id"], doc["chunk_id"], float(score)))

        return results
