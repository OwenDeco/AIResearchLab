from __future__ import annotations

import logging
from typing import Optional

from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

_VALID_MODES = {
    "lexical", "vector", "hybrid", "semantic_rerank", "parent_child", "graph_rag"
}


def build_retriever(
    mode: str,
    embed_model: str,
    model_name: str,
    db: Session,
    chroma,
    graph_store,
    bm25_index,
    alpha: float = 0.5,
    graph_hops: int = 2,
):
    """
    Instantiate and return the appropriate retriever for *mode*.

    Single source of truth used by both the retrieval route and the
    benchmark runner.
    """
    from models.registry import get_embedder, get_llm, get_reranker

    if mode not in _VALID_MODES:
        raise ValueError(
            f"Unknown retrieval_mode '{mode}'. Valid: {', '.join(sorted(_VALID_MODES))}"
        )

    embedder = get_embedder(embed_model)

    if mode == "lexical":
        from retrieval.lexical import LexicalRetriever
        return LexicalRetriever(bm25_index)

    elif mode == "vector":
        from retrieval.vector import VectorRetriever
        return VectorRetriever(chroma, embedder)

    elif mode == "hybrid":
        from retrieval.hybrid import HybridRetriever
        return HybridRetriever(bm25_index, chroma, embedder, alpha=alpha)

    elif mode == "semantic_rerank":
        from retrieval.semantic_rerank import SemanticRerankRetriever
        reranker = get_reranker()
        retriever = SemanticRerankRetriever(bm25_index, reranker, fetch_k=50)
        retriever.set_db(db)
        return retriever

    elif mode == "parent_child":
        from retrieval.parent_child_retriever import ParentChildRetriever
        return ParentChildRetriever(db, chroma, embedder)

    elif mode == "graph_rag":
        from retrieval.graph_rag import GraphRAGRetriever
        llm = get_llm(model_name)
        return GraphRAGRetriever(graph_store, db, embedder, llm, hops=graph_hops)
