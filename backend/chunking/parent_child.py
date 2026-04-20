from __future__ import annotations

import uuid
from typing import List

from chunking.base import BaseChunker, ChunkData


class ParentChildChunker(BaseChunker):
    """
    Create large parent chunks, then split each into smaller child chunks.

    Children store the parent's chunk id in *parent_chunk_id*.
    Parents are returned with ``is_parent=True`` in their metadata.
    Both parents and children are returned in the list (parents first,
    then children grouped by parent).
    """

    def __init__(self, parent_size: int = 1024, child_size: int = 256) -> None:
        self.parent_size = max(1, parent_size)
        self.child_size = max(1, child_size)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _split_fixed(self, text: str, size: int) -> List[tuple[int, int]]:
        """Return list of (start, end) character spans of *size* length."""
        spans: List[tuple[int, int]] = []
        start = 0
        while start < len(text):
            end = min(start + size, len(text))
            spans.append((start, end))
            start += size
        return spans

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def chunk(self, text: str, doc_id: str) -> List[ChunkData]:
        chunks: List[ChunkData] = []
        global_chunk_index = 0

        parent_spans = self._split_fixed(text, self.parent_size)

        for parent_span_start, parent_span_end in parent_spans:
            parent_text = text[parent_span_start:parent_span_end]
            if not parent_text.strip():
                continue

            parent_id = str(uuid.uuid4())

            # Emit parent chunk
            parent_chunk = ChunkData(
                content=parent_text,
                chunk_index=global_chunk_index,
                start_char=parent_span_start,
                end_char=parent_span_end,
                parent_chunk_id=None,
                metadata={
                    "chunker": "parent_child",
                    "is_parent": True,
                    "parent_id": parent_id,
                    "parent_size": self.parent_size,
                    "child_size": self.child_size,
                },
            )
            # Attach the stable id so children can reference it
            parent_chunk.metadata["_chunk_uuid"] = parent_id
            chunks.append(parent_chunk)
            global_chunk_index += 1

            # Emit child chunks
            child_spans = self._split_fixed(parent_text, self.child_size)
            for child_start_rel, child_end_rel in child_spans:
                child_text = parent_text[child_start_rel:child_end_rel]
                if not child_text.strip():
                    continue

                abs_start = parent_span_start + child_start_rel
                abs_end = parent_span_start + child_end_rel

                child_chunk = ChunkData(
                    content=child_text,
                    chunk_index=global_chunk_index,
                    start_char=abs_start,
                    end_char=abs_end,
                    parent_chunk_id=parent_id,
                    metadata={
                        "chunker": "parent_child",
                        "is_parent": False,
                        "parent_id": parent_id,
                        "parent_size": self.parent_size,
                        "child_size": self.child_size,
                    },
                )
                chunks.append(child_chunk)
                global_chunk_index += 1

        return chunks
