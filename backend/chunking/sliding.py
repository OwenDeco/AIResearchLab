from __future__ import annotations

from typing import List

from chunking.base import BaseChunker, ChunkData


class SlidingWindowChunker(BaseChunker):
    """Sliding window over characters with configurable window and step size."""

    def __init__(self, window_size: int = 512, step_size: int = 256) -> None:
        self.window_size = max(1, window_size)
        self.step_size = max(1, step_size)

    def chunk(self, text: str, doc_id: str) -> List[ChunkData]:
        chunks: List[ChunkData] = []
        start = 0
        index = 0
        text_len = len(text)

        while start < text_len:
            end = min(start + self.window_size, text_len)
            content = text[start:end]
            if content.strip():
                chunks.append(
                    ChunkData(
                        content=content,
                        chunk_index=index,
                        start_char=start,
                        end_char=end,
                        metadata={
                            "chunker": "sliding",
                            "window_size": self.window_size,
                            "step_size": self.step_size,
                        },
                    )
                )
                index += 1

            start += self.step_size

        return chunks
