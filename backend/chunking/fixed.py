from __future__ import annotations

from typing import List

from chunking.base import BaseChunker, ChunkData


class FixedSizeChunker(BaseChunker):
    """Split text into fixed-size character chunks with optional overlap."""

    def __init__(self, chunk_size: int = 512, chunk_overlap: int = 50) -> None:
        self.chunk_size = max(1, chunk_size)
        self.chunk_overlap = max(0, min(chunk_overlap, chunk_size - 1))

    def chunk(self, text: str, doc_id: str) -> List[ChunkData]:
        chunks: List[ChunkData] = []
        start = 0
        index = 0
        text_len = len(text)

        while start < text_len:
            end = min(start + self.chunk_size, text_len)
            content = text[start:end]
            if content.strip():
                chunks.append(
                    ChunkData(
                        content=content,
                        chunk_index=index,
                        start_char=start,
                        end_char=end,
                        metadata={"chunker": "fixed", "chunk_size": self.chunk_size, "chunk_overlap": self.chunk_overlap},
                    )
                )
                index += 1

            # Advance start, accounting for overlap
            step = self.chunk_size - self.chunk_overlap
            start += step

        return chunks
