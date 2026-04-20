from __future__ import annotations

import difflib
import logging
from typing import Dict, List

from graph.store import GraphStore

logger = logging.getLogger(__name__)


class GraphTraversal:
    """
    Higher-level traversal utilities on top of GraphStore.

    Provides fuzzy node lookup, neighbourhood expansion, chunk ID collection,
    and subgraph summarisation.
    """

    def __init__(self, graph_store: GraphStore) -> None:
        self._graph = graph_store

    # ------------------------------------------------------------------
    # Node lookup
    # ------------------------------------------------------------------

    def find_nodes_by_name(self, name: str, fuzzy: bool = True) -> List[str]:
        """
        Find node IDs whose labels match *name*.

        When *fuzzy* is True, uses :mod:`difflib` sequence matching to include
        close matches in addition to substring matches.
        """
        all_nodes = self._graph.get_all_nodes()
        name_lower = name.lower()
        exact_or_substring: List[str] = []
        fuzzy_matches: List[str] = []

        labels = {n["id"]: n["label"].lower() for n in all_nodes}

        for node_id, label in labels.items():
            if name_lower in label or label in name_lower:
                exact_or_substring.append(node_id)

        if exact_or_substring:
            return exact_or_substring

        if fuzzy:
            label_list = list(labels.values())
            close = difflib.get_close_matches(name_lower, label_list, n=5, cutoff=0.6)
            for node_id, label in labels.items():
                if label in close and node_id not in fuzzy_matches:
                    fuzzy_matches.append(node_id)

        return fuzzy_matches

    # ------------------------------------------------------------------
    # Neighbourhood
    # ------------------------------------------------------------------

    def get_neighborhood(self, node_id: str, hops: int = 2) -> Dict:
        """
        Return a subgraph dict with ``nodes`` and ``edges`` lists for the
        neighbourhood of *node_id* up to *hops* hops away.
        """
        nodes, edges = self._graph.get_neighbours(node_id, hops=hops)
        return {"nodes": nodes, "edges": edges}

    # ------------------------------------------------------------------
    # Chunk ID extraction
    # ------------------------------------------------------------------

    def get_chunk_ids_for_subgraph(self, node_ids: List[str]) -> List[str]:
        """
        Return all unique chunk_ids referenced by the nodes and edges
        in the subgraphs rooted at each node in *node_ids*.
        """
        all_chunk_ids: List[str] = []
        seen: set = set()

        # Collect chunk_ids from node attributes
        all_nodes = self._graph.get_all_nodes()
        node_map = {n["id"]: n for n in all_nodes}
        for node_id in node_ids:
            n = node_map.get(node_id)
            if n:
                for cid in n.get("chunk_ids", []):
                    if cid not in seen:
                        seen.add(cid)
                        all_chunk_ids.append(cid)

        # Collect chunk_ids from edges in the neighbourhood
        for node_id in node_ids:
            _, edges = self._graph.get_neighbours(node_id, hops=1)
            for edge in edges:
                cid = edge.get("chunk_id", "")
                if cid and cid not in seen:
                    seen.add(cid)
                    all_chunk_ids.append(cid)

        return all_chunk_ids

    # ------------------------------------------------------------------
    # Subgraph summary
    # ------------------------------------------------------------------

    def summarize_subgraph(self, node_ids: List[str]) -> str:
        """
        Produce a human-readable text summary of the entities and relations
        within the subgraph induced by *node_ids*.
        """
        if not node_ids:
            return "Empty subgraph."

        all_nodes = self._graph.get_all_nodes()
        node_map = {n["id"]: n for n in all_nodes}

        entity_lines: List[str] = []
        for nid in node_ids:
            n = node_map.get(nid)
            if n:
                entity_lines.append(
                    f"- {n['label']} (type: {n.get('type', 'entity')})"
                )

        # Gather edges that are entirely within node_ids
        node_id_set = set(node_ids)
        all_edges = self._graph.get_all_edges()
        relation_lines: List[str] = []
        for e in all_edges:
            if e["source"] in node_id_set and e["target"] in node_id_set:
                src_label = node_map.get(e["source"], {}).get("label", e["source"])
                tgt_label = node_map.get(e["target"], {}).get("label", e["target"])
                relation_lines.append(
                    f"- {src_label} --[{e.get('predicate', 'related_to')}]--> {tgt_label}"
                )

        parts: List[str] = []
        if entity_lines:
            parts.append("Entities:\n" + "\n".join(entity_lines))
        if relation_lines:
            parts.append("Relations:\n" + "\n".join(relation_lines))

        return "\n\n".join(parts) if parts else "No entities or relations found."
