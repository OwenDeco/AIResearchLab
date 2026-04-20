from __future__ import annotations

import logging
from typing import List

from sqlalchemy.orm import Session

from graph.store import GraphStore
from models.base import EmbeddingProvider, LLMProvider
from retrieval.base import BaseRetriever, RetrievedChunk

logger = logging.getLogger(__name__)


class GraphRAGRetriever(BaseRetriever):
    """
    Graph-augmented retriever.

    Extracts entity mentions from the query by matching against graph node
    labels, traverses the knowledge graph to collect related chunk IDs,
    and loads those chunks from the database.
    """

    def __init__(
        self,
        graph_store: GraphStore,
        db: Session,
        embedder: EmbeddingProvider,
        llm: LLMProvider,
        hops: int = 2,
    ) -> None:
        self._graph = graph_store
        self._db = db
        self._embedder = embedder
        self._llm = llm
        self._hops = hops

    @property
    def mode_name(self) -> str:
        return "graph_rag"

    def retrieve(self, query: str, top_k: int = 5) -> List[RetrievedChunk]:
        from models_db import Chunk as ChunkModel

        # Step 1: Find entity nodes that match query keywords
        query_words = [w.strip(".,;:!?\"'").lower() for w in query.split() if len(w) > 1]
        matched_node_ids: List[str] = []

        for word in query_words:
            node_ids = self._graph.find_entities_by_label(word)
            for nid in node_ids:
                if nid not in matched_node_ids:
                    matched_node_ids.append(nid)

        if not matched_node_ids:
            logger.debug("GraphRAGRetriever: no entity matches for query '%s'", query)
            return []

        # Step 2: Expand neighbourhood for each matched node
        all_chunk_ids: List[str] = []
        all_nodes: List[dict] = []
        all_edges: List[dict] = []

        seen_nodes: set = set()
        seen_edges: set = set()

        # Collect seed node labels for explainability
        seed_node_labels: List[str] = []
        for node_id in matched_node_ids[:5]:
            node_data = self._graph._graph.nodes.get(node_id, {})
            seed_node_labels.append(node_data.get("label", node_id))

        for node_id in matched_node_ids[:5]:  # Limit seed nodes to avoid explosion
            nodes, edges = self._graph.get_neighbours(node_id, hops=self._hops)
            for n in nodes:
                if n["id"] not in seen_nodes:
                    seen_nodes.add(n["id"])
                    all_nodes.append(n)
                    for cid in n.get("chunk_ids", []):
                        if cid not in all_chunk_ids:
                            all_chunk_ids.append(cid)
            for e in edges:
                edge_key = (e["source"], e["target"], e.get("predicate", ""))
                if edge_key not in seen_edges:
                    seen_edges.add(edge_key)
                    all_edges.append(e)
                    cid = e.get("chunk_id", "")
                    if cid and cid not in all_chunk_ids:
                        all_chunk_ids.append(cid)

        logger.info(
            "GraphRAGRetriever: seeds=%s nodes=%d edges=%d chunk_ids=%d",
            seed_node_labels, len(all_nodes), len(all_edges), len(all_chunk_ids),
        )

        if not all_chunk_ids:
            logger.debug("GraphRAGRetriever: no chunk_ids found in subgraph")
            return []

        # Step 3: Load chunk content from DB
        chunk_rows = (
            self._db.query(ChunkModel)
            .filter(ChunkModel.id.in_(all_chunk_ids[:top_k * 3]))
            .all()
        )

        if not chunk_rows:
            return []

        # Build graph summary for metadata
        node_label_map = {n["id"]: n.get("label", n["id"]) for n in all_nodes}
        node_labels = list(node_label_map.values())
        edge_summaries = [
            f"{node_label_map.get(e['source'], e['source'])} --[{e.get('predicate', 'related_to')}]--> {node_label_map.get(e['target'], e['target'])}"
            for e in all_edges[:20]
        ]
        graph_summary = "Relations: " + "; ".join(edge_summaries) if edge_summaries else ""

        results: List[RetrievedChunk] = []
        for row in chunk_rows[:top_k]:
            results.append(
                RetrievedChunk(
                    chunk_id=row.id,
                    doc_id=row.doc_id,
                    content=row.content,
                    score=1.0,
                    metadata={
                        "graph_summary": graph_summary,
                        "seed_entities": seed_node_labels,
                        "traversal_node_count": len(all_nodes),
                        "traversal_edge_count": len(all_edges),
                    },
                )
            )

        return results
