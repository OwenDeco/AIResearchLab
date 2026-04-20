from __future__ import annotations

import json
import logging
import os
import re
from typing import Dict, List, Optional, Set, Tuple

import networkx as nx

logger = logging.getLogger(__name__)


class GraphStore:
    """
    In-memory knowledge graph backed by NetworkX with JSON persistence.

    Nodes represent entities; edges represent extracted relations.
    Both nodes and edges track the source documents and chunks they came from.
    """

    def __init__(self, persist_path: str = "./graph_data.json") -> None:
        self._path = persist_path
        self._graph: nx.DiGraph = nx.DiGraph()

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def load(self) -> None:
        """Load graph from the JSON persistence file (if it exists)."""
        if not os.path.exists(self._path):
            logger.info("GraphStore: no existing graph found at %s. Starting fresh.", self._path)
            return
        try:
            with open(self._path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
            self._graph = nx.node_link_graph(data, directed=True, multigraph=True)
            logger.info(
                "GraphStore: loaded %d nodes, %d edges from %s.",
                self._graph.number_of_nodes(),
                self._graph.number_of_edges(),
                self._path,
            )
        except Exception as exc:
            logger.error("GraphStore: failed to load graph from %s: %s", self._path, exc)
            self._graph = nx.DiGraph()

    def save(self) -> None:
        """Persist graph to JSON."""
        try:
            data = nx.node_link_data(self._graph)
            os.makedirs(os.path.dirname(os.path.abspath(self._path)), exist_ok=True)
            with open(self._path, "w", encoding="utf-8") as fh:
                json.dump(data, fh, indent=2)
            logger.debug("GraphStore: saved to %s.", self._path)
        except Exception as exc:
            logger.error("GraphStore: failed to save graph to %s: %s", self._path, exc)

    # ------------------------------------------------------------------
    # Mutation
    # ------------------------------------------------------------------

    @staticmethod
    def _normalize_label(label: str) -> str:
        """
        Normalize an entity label for deduplication.
        Strips leading articles, collapses whitespace, lowercases.
        E.g. "The OpenAI Company" → "openai company"
        """
        label = label.strip()
        label = re.sub(r"^(the|a|an)\s+", "", label, flags=re.IGNORECASE)
        label = re.sub(r"\s+", " ", label).strip()
        return label.lower()

    def _get_or_create_node(self, label: str, doc_id: str, chunk_id: str, node_type: str = "Other") -> str:
        """Return node id for *label*, creating the node if needed."""
        node_id = self._normalize_label(label).replace(" ", "_")
        if not self._graph.has_node(node_id):
            self._graph.add_node(
                node_id,
                label=label,
                type=node_type,
                doc_ids=[doc_id],
                chunk_ids=[chunk_id],
            )
        else:
            node_data = self._graph.nodes[node_id]
            # Upgrade type if we now have a more specific one
            if node_data.get("type") in ("entity", "Other") and node_type not in ("entity", "Other"):
                node_data["type"] = node_type
            if doc_id not in node_data.get("doc_ids", []):
                node_data.setdefault("doc_ids", []).append(doc_id)
            if chunk_id not in node_data.get("chunk_ids", []):
                node_data.setdefault("chunk_ids", []).append(chunk_id)
        return node_id

    def add_entity(self, label: str, doc_id: str, chunk_id: str, node_type: str = "Other") -> str:
        return self._get_or_create_node(label, doc_id, chunk_id, node_type=node_type)

    def add_triples(self, triples: list, doc_id: str) -> None:
        """Add a list of Triple objects (from EntityRelationExtractor) to the graph."""
        for triple in triples:
            subj_id = self._get_or_create_node(
                triple.subject, doc_id, triple.chunk_id, node_type=triple.subject_type
            )
            obj_id = self._get_or_create_node(
                triple.object_, doc_id, triple.chunk_id, node_type=triple.object_type
            )
            self._graph.add_edge(
                subj_id, obj_id,
                predicate=triple.predicate,
                chunk_id=triple.chunk_id,
                doc_id=doc_id,
                confidence=getattr(triple, "confidence", 1.0),
                evidence=getattr(triple, "evidence", ""),
            )

    def clear(self) -> None:
        """Reset the graph to empty."""
        self._graph = nx.DiGraph()
        logger.info("GraphStore: cleared.")

    # ------------------------------------------------------------------
    # Query
    # ------------------------------------------------------------------

    def get_neighbours(
        self,
        entity_id: str,
        hops: int = 2,
        predicate_filter: Optional[Set[str]] = None,
    ) -> Tuple[List[Dict], List[Dict]]:
        """
        BFS from *entity_id* up to *hops* hops.

        When *predicate_filter* is provided, only edges whose predicate is in
        the set are traversed and included in the result.

        Returns (nodes, edges) as dicts suitable for serialisation.
        """
        if not self._graph.has_node(entity_id):
            return [], []

        visited_nodes: Set[str] = set()
        visited_edges: List[Dict] = []
        frontier = {entity_id}

        def _collect_edge(u: str, v: str, edata: dict) -> bool:
            """Returns True if the edge passes the predicate filter."""
            pred = edata.get("predicate", "related_to")
            if predicate_filter is not None and pred not in predicate_filter:
                return False
            visited_edges.append({
                "source": u,
                "target": v,
                "predicate": pred,
                "chunk_id": edata.get("chunk_id", ""),
                "confidence": edata.get("confidence", 1.0),
                "evidence": edata.get("evidence", ""),
            })
            return True

        for _ in range(hops):
            next_frontier: Set[str] = set()
            for node in frontier:
                visited_nodes.add(node)
                for successor in self._graph.successors(node):
                    edge_data = self._graph.get_edge_data(node, successor) or {}
                    if isinstance(edge_data, dict) and edge_data:
                        first_val = next(iter(edge_data.values()))
                        if isinstance(first_val, dict):
                            for edata in edge_data.values():
                                _collect_edge(node, successor, edata)
                        else:
                            _collect_edge(node, successor, edge_data)
                    if successor not in visited_nodes:
                        next_frontier.add(successor)
                for predecessor in self._graph.predecessors(node):
                    edge_data = self._graph.get_edge_data(predecessor, node) or {}
                    if isinstance(edge_data, dict) and edge_data:
                        first_val = next(iter(edge_data.values()))
                        if isinstance(first_val, dict):
                            for edata in edge_data.values():
                                _collect_edge(predecessor, node, edata)
                        else:
                            _collect_edge(predecessor, node, edge_data)
                    if predecessor not in visited_nodes:
                        next_frontier.add(predecessor)
            frontier = next_frontier - visited_nodes

        visited_nodes.update(frontier)

        nodes = []
        for nid in visited_nodes:
            if self._graph.has_node(nid):
                ndata = dict(self._graph.nodes[nid])
                nodes.append({
                    "id": nid,
                    "label": ndata.get("label", nid),
                    "type": ndata.get("type", "entity"),
                    "doc_ids": ndata.get("doc_ids", []),
                    "chunk_ids": ndata.get("chunk_ids", []),
                })

        return nodes, visited_edges

    def find_entities_by_label(self, query: str) -> List[str]:
        """Return node ids whose labels contain *query* (case-insensitive)."""
        q = query.lower()
        return [
            nid
            for nid, data in self._graph.nodes(data=True)
            if q in data.get("label", "").lower()
        ]

    def get_all_nodes(self) -> List[Dict]:
        result = []
        for nid, data in self._graph.nodes(data=True):
            result.append({
                "id": nid,
                "label": data.get("label", nid),
                "type": data.get("type", "entity"),
                "doc_ids": data.get("doc_ids", []),
                "chunk_ids": data.get("chunk_ids", []),
            })
        return result

    def get_all_edges(self) -> List[Dict]:
        result = []
        for u, v, data in self._graph.edges(data=True):
            result.append({
                "source": u,
                "target": v,
                "predicate": data.get("predicate", "related_to"),
                "chunk_id": data.get("chunk_id", ""),
                "confidence": data.get("confidence", 1.0),
                "evidence": data.get("evidence", ""),
            })
        return result

    @property
    def node_count(self) -> int:
        return self._graph.number_of_nodes()

    @property
    def edge_count(self) -> int:
        return self._graph.number_of_edges()
