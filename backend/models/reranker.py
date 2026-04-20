from __future__ import annotations

import logging
from typing import List, Optional, Tuple

logger = logging.getLogger(__name__)

_CROSS_ENCODER_MODEL = "cross-encoder/ms-marco-MiniLM-L-6-v2"


class CrossEncoderReranker:
    """
    Re-rank retrieved chunks using a cross-encoder model.

    The underlying :class:`sentence_transformers.CrossEncoder` is loaded
    lazily on the first call to :meth:`rerank` to avoid paying the import
    cost at startup.
    """

    def __init__(self, model_name: str = _CROSS_ENCODER_MODEL) -> None:
        self._model_name = model_name
        self._model: Optional[object] = None  # loaded lazily

    # ------------------------------------------------------------------
    # Lazy loader
    # ------------------------------------------------------------------

    def _load_model(self) -> None:
        if self._model is not None:
            return
        try:
            from sentence_transformers import CrossEncoder  # type: ignore

            logger.info("Loading cross-encoder model: %s", self._model_name)
            self._model = CrossEncoder(self._model_name)
            logger.info("Cross-encoder model loaded.")
        except Exception as exc:
            logger.error("Failed to load CrossEncoder model %s: %s", self._model_name, exc)
            raise

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def rerank(
        self,
        query: str,
        chunks,  # list[ChunkData] — avoid circular import with type annotation
        top_k: int = 5,
    ) -> List[Tuple[object, float]]:
        """
        Score each chunk against *query* and return top-k (chunk, score) pairs,
        sorted descending by score.

        Parameters
        ----------
        query:
            The user query string.
        chunks:
            List of :class:`~chunking.base.ChunkData` (or any object with a
            ``content`` attribute).
        top_k:
            Maximum number of results to return.

        Returns
        -------
        list of (chunk, score) tuples sorted by score descending.
        """
        if not chunks:
            return []

        self._load_model()

        pairs = [(query, chunk.content) for chunk in chunks]

        import math

        try:
            raw_scores: List[float] = self._model.predict(pairs).tolist()  # type: ignore[union-attr]
        except Exception as exc:
            logger.error("CrossEncoderReranker.rerank prediction failed: %s", exc)
            raise

        # Normalize raw logits to [0, 1] via sigmoid so scores are interpretable
        scores = [1.0 / (1.0 + math.exp(-s)) for s in raw_scores]

        scored = sorted(zip(chunks, scores), key=lambda x: x[1], reverse=True)
        return scored[:top_k]
