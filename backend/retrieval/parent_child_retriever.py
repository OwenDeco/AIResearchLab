from __future__ import annotations

import logging
from typing import List

from sqlalchemy.orm import Session

from models.base import EmbeddingProvider
from retrieval.base import BaseRetriever, RetrievedChunk
from retrieval.vector import VectorRetriever

logger = logging.getLogger(__name__)


class ParentChildRetriever(BaseRetriever):
    """
    Retrieves child chunks via vector search, then returns their parent chunk
    content for richer context. Falls back to the child itself when no parent
    exists.
    """

    def __init__(self, db: Session, collection, embedder: EmbeddingProvider) -> None:
        self._db = db
        self._vector = VectorRetriever(collection, embedder)

    @property
    def mode_name(self) -> str:
        return "parent_child"

    def retrieve(self, query: str, top_k: int = 5) -> List[RetrievedChunk]:
        from models_db import Chunk as ChunkModel

        # Step 1: vector search for child chunks (fetch more to allow dedup after parent resolution)
        child_results = self._vector.retrieve(query, top_k=top_k * 2)
        if not child_results:
            return []

        seen_parent_ids: set = set()
        results: List[RetrievedChunk] = []

        for child_chunk in child_results:
            if len(results) >= top_k:
                break

            # Load the chunk row from DB to inspect parent_chunk_id
            chunk_row = (
                self._db.query(ChunkModel)
                .filter(ChunkModel.id == child_chunk.chunk_id)
                .first()
            )

            if chunk_row is None:
                # Not in DB — return the vector result as-is
                if child_chunk.chunk_id not in seen_parent_ids:
                    seen_parent_ids.add(child_chunk.chunk_id)
                    results.append(child_chunk)
                continue

            parent_id = chunk_row.parent_chunk_id

            if parent_id:
                # Deduplicate by parent
                if parent_id in seen_parent_ids:
                    continue
                seen_parent_ids.add(parent_id)

                parent_row = (
                    self._db.query(ChunkModel)
                    .filter(ChunkModel.id == parent_id)
                    .first()
                )
                if parent_row:
                    results.append(
                        RetrievedChunk(
                            chunk_id=parent_row.id,
                            doc_id=parent_row.doc_id,
                            content=parent_row.content,
                            score=child_chunk.score,
                            metadata={"sourced_from_child": child_chunk.chunk_id},
                        )
                    )
                else:
                    # Parent ID set but row missing — fall back to child
                    if chunk_row.id not in seen_parent_ids:
                        seen_parent_ids.add(chunk_row.id)
                        results.append(
                            RetrievedChunk(
                                chunk_id=chunk_row.id,
                                doc_id=chunk_row.doc_id,
                                content=chunk_row.content,
                                score=child_chunk.score,
                                metadata=child_chunk.metadata,
                            )
                        )
            else:
                # No parent — use the chunk itself
                if chunk_row.id not in seen_parent_ids:
                    seen_parent_ids.add(chunk_row.id)
                    results.append(
                        RetrievedChunk(
                            chunk_id=chunk_row.id,
                            doc_id=chunk_row.doc_id,
                            content=chunk_row.content,
                            score=child_chunk.score,
                            metadata=child_chunk.metadata,
                        )
                    )

        return results
