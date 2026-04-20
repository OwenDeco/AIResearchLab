from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import List, Optional


@dataclass
class ChunkData:
    content: str
    chunk_index: int
    start_char: int
    end_char: int
    parent_chunk_id: Optional[str] = None
    metadata: dict = field(default_factory=dict)


class BaseChunker(ABC):
    """Abstract base for all chunking strategies."""

    @abstractmethod
    def chunk(self, text: str, doc_id: str) -> List[ChunkData]:
        """Split *text* into chunks and return a list of ChunkData objects."""
        ...
