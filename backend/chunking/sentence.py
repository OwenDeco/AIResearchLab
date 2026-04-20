from __future__ import annotations

import logging
from typing import List

from chunking.base import BaseChunker, ChunkData

logger = logging.getLogger(__name__)


def _ensure_punkt() -> None:
    """Download NLTK punkt tokenizer data if not already present."""
    import nltk  # type: ignore

    for resource in ("punkt", "punkt_tab"):
        try:
            nltk.data.find(f"tokenizers/{resource}")
        except LookupError:
            try:
                nltk.download(resource, quiet=True)
            except Exception:
                pass


class SentenceChunker(BaseChunker):
    """Group sentences into chunks up to *max_chunk_size* characters."""

    def __init__(self, max_chunk_size: int = 512) -> None:
        self.max_chunk_size = max(1, max_chunk_size)
        _ensure_punkt()

    def chunk(self, text: str, doc_id: str) -> List[ChunkData]:
        import nltk  # type: ignore

        try:
            sentences = nltk.sent_tokenize(text)
        except Exception:
            # Fallback: split on period + space
            sentences = [s.strip() for s in text.split(". ") if s.strip()]

        chunks: List[ChunkData] = []
        current_sentences: List[str] = []
        current_len = 0
        chunk_index = 0
        char_pos = 0
        chunk_start = 0

        for sentence in sentences:
            sentence_len = len(sentence)

            # If adding this sentence would exceed the limit, flush current buffer
            if current_sentences and current_len + sentence_len + 1 > self.max_chunk_size:
                content = " ".join(current_sentences)
                chunks.append(
                    ChunkData(
                        content=content,
                        chunk_index=chunk_index,
                        start_char=chunk_start,
                        end_char=chunk_start + len(content),
                        metadata={"chunker": "sentence", "max_chunk_size": self.max_chunk_size},
                    )
                )
                chunk_index += 1
                chunk_start += len(content) + 1  # +1 for separator
                current_sentences = []
                current_len = 0

            # If a single sentence exceeds the limit, emit it alone
            if sentence_len > self.max_chunk_size and not current_sentences:
                chunks.append(
                    ChunkData(
                        content=sentence,
                        chunk_index=chunk_index,
                        start_char=chunk_start,
                        end_char=chunk_start + sentence_len,
                        metadata={"chunker": "sentence", "max_chunk_size": self.max_chunk_size},
                    )
                )
                chunk_index += 1
                chunk_start += sentence_len + 1
                continue

            current_sentences.append(sentence)
            current_len += sentence_len + 1  # +1 for space

        # Flush remaining sentences
        if current_sentences:
            content = " ".join(current_sentences)
            chunks.append(
                ChunkData(
                    content=content,
                    chunk_index=chunk_index,
                    start_char=chunk_start,
                    end_char=chunk_start + len(content),
                    metadata={"chunker": "sentence", "max_chunk_size": self.max_chunk_size},
                )
            )

        return chunks
