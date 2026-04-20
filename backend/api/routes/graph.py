from __future__ import annotations

import json
import logging
from typing import List, Optional

from fastapi import APIRouter, Depends, Query, Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from api.deps import get_db, get_graph_store
from api.schemas import GraphEdge, GraphNode, GraphResponse
from graph.extractor import ALLOWED_PREDICATES as _EXTRACTOR_PREDICATES
from graph.store import GraphStore
from graph.traversal import GraphTraversal

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/graph", tags=["graph"])

_ENTITY_TYPES_KEY    = "graph_entity_types"
_PREDICATES_KEY      = "graph_predicates"
_EXTRACTION_CFG_KEY  = "graph_extraction_config"

DEFAULT_ENTITY_TYPES = [
    {"name": "Person",       "color": "#3b82f6"},
    {"name": "Organization", "color": "#22c55e"},
    {"name": "Technology",   "color": "#f97316"},
    {"name": "Concept",      "color": "#a855f7"},
    {"name": "Location",     "color": "#ef4444"},
    {"name": "Other",        "color": "#94a3b8"},
]

_PREDICATE_DESCRIPTIONS = {
    "is_a":              "X is a type or kind of Y",
    "part_of":           "X is a component or member of Y",
    "uses":              "X employs or uses Y",
    "created_by":        "X was created, authored, or developed by Y",
    "located_in":        "X is located or headquartered in Y",
    "works_for":         "Person X is employed by Y",
    "depends_on":        "X requires or depends on Y",
    "implements":        "X implements or applies Y",
    "based_on":          "X is derived from or based on Y",
    "causes":            "X causes, leads to, or results in Y",
    "evaluates":         "X measures, evaluates, or benchmarks Y",
    "collaborates_with": "X works together with Y",
}

DEFAULT_PREDICATES = [
    {"name": p, "description": _PREDICATE_DESCRIPTIONS.get(p, ""), "enabled": True}
    for p in _EXTRACTOR_PREDICATES
]


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class EntityTypeItem(BaseModel):
    name: str
    color: str = "#94a3b8"


class EntityTypesPayload(BaseModel):
    types: List[EntityTypeItem] = Field(default_factory=list)


class PredicateItem(BaseModel):
    name: str
    description: str = ""
    enabled: bool = True


class PredicatesPayload(BaseModel):
    predicates: List[PredicateItem] = Field(default_factory=list)


class ExtractionConfig(BaseModel):
    min_confidence: float = Field(0.65, ge=0.0, le=1.0)
    preprocess_text: bool = True


class GraphQueryRequest(BaseModel):
    query: str
    hops: int = 2


class GraphQueryResponse(BaseModel):
    nodes: List[GraphNode]
    edges: List[GraphEdge]
    chunk_ids: List[str]


class GraphStatsResponse(BaseModel):
    node_count: int
    edge_count: int
    top_entities: List[dict]
    doc_count: int


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _node_dict_to_schema(n: dict) -> GraphNode:
    return GraphNode(
        id=n["id"],
        label=n.get("label", n["id"]),
        type=n.get("type", "entity"),
        doc_ids=n.get("doc_ids", []),
        chunk_ids=n.get("chunk_ids", []),
    )


def _edge_dict_to_schema(e: dict) -> GraphEdge:
    return GraphEdge(
        source=e["source"],
        target=e["target"],
        predicate=e.get("predicate", "related_to"),
        chunk_id=e.get("chunk_id", ""),
        confidence=e.get("confidence", 1.0),
        evidence=e.get("evidence", ""),
    )


# ---------------------------------------------------------------------------
# GET /api/graph/entity-types
# PUT /api/graph/entity-types
# — must be before /{...} wildcard routes
# ---------------------------------------------------------------------------

@router.get("/entity-types", response_model=List[EntityTypeItem])
def get_entity_types(db: Session = Depends(get_db)):
    """Return configured entity types (name + color). Falls back to defaults."""
    from models_db import AppState
    row = db.query(AppState).filter(AppState.key == _ENTITY_TYPES_KEY).first()
    if row is None:
        return DEFAULT_ENTITY_TYPES
    try:
        data = json.loads(row.value)
        return data if isinstance(data, list) else DEFAULT_ENTITY_TYPES
    except Exception:
        return DEFAULT_ENTITY_TYPES


@router.put("/entity-types", status_code=204)
def update_entity_types(payload: EntityTypesPayload, db: Session = Depends(get_db)):
    """Persist the list of entity types (name + color)."""
    from models_db import AppState
    from datetime import datetime, timezone
    value = json.dumps([t.model_dump() for t in payload.types])
    row = db.query(AppState).filter(AppState.key == _ENTITY_TYPES_KEY).first()
    if row is None:
        row = AppState(key=_ENTITY_TYPES_KEY, value=value)
        db.add(row)
    else:
        row.value = value
        row.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
    db.commit()
    return Response(status_code=204)


# ---------------------------------------------------------------------------
# GET /api/graph/predicates
# PUT /api/graph/predicates
# ---------------------------------------------------------------------------

@router.get("/predicates", response_model=List[PredicateItem])
def get_predicates(db: Session = Depends(get_db)):
    """Return configured predicates with enabled/disabled status."""
    from models_db import AppState
    row = db.query(AppState).filter(AppState.key == _PREDICATES_KEY).first()
    if row is None:
        return DEFAULT_PREDICATES
    try:
        data = json.loads(row.value)
        return data if isinstance(data, list) else DEFAULT_PREDICATES
    except Exception:
        return DEFAULT_PREDICATES


@router.put("/predicates", status_code=204)
def update_predicates(payload: PredicatesPayload, db: Session = Depends(get_db)):
    """Persist the predicate enable/disable list."""
    from models_db import AppState
    from datetime import datetime, timezone
    value = json.dumps([p.model_dump() for p in payload.predicates])
    row = db.query(AppState).filter(AppState.key == _PREDICATES_KEY).first()
    if row is None:
        row = AppState(key=_PREDICATES_KEY, value=value)
        db.add(row)
    else:
        row.value = value
        row.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
    db.commit()
    return Response(status_code=204)


# ---------------------------------------------------------------------------
# GET /api/graph/extraction-config
# PUT /api/graph/extraction-config
# ---------------------------------------------------------------------------

@router.get("/extraction-config", response_model=ExtractionConfig)
def get_extraction_config(db: Session = Depends(get_db)):
    """Return extraction configuration (confidence threshold, preprocessing flag)."""
    from models_db import AppState
    row = db.query(AppState).filter(AppState.key == _EXTRACTION_CFG_KEY).first()
    if row is None:
        return ExtractionConfig()
    try:
        data = json.loads(row.value)
        return ExtractionConfig(**data)
    except Exception:
        return ExtractionConfig()


@router.put("/extraction-config", status_code=204)
def update_extraction_config(payload: ExtractionConfig, db: Session = Depends(get_db)):
    """Persist extraction configuration."""
    from models_db import AppState
    from datetime import datetime, timezone
    value = json.dumps(payload.model_dump())
    row = db.query(AppState).filter(AppState.key == _EXTRACTION_CFG_KEY).first()
    if row is None:
        row = AppState(key=_EXTRACTION_CFG_KEY, value=value)
        db.add(row)
    else:
        row.value = value
        row.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
    db.commit()
    return Response(status_code=204)


# ---------------------------------------------------------------------------
# GET /api/graph
# ---------------------------------------------------------------------------

@router.get("", response_model=GraphResponse)
def get_graph(
    doc_id: Optional[str] = Query(None, description="Filter nodes by document ID"),
    entity_type: Optional[str] = Query(None, description="Filter nodes by entity type"),
    predicate: Optional[str] = Query(None, description="Comma-separated predicate filter for edges"),
    graph_store: GraphStore = Depends(get_graph_store),
):
    """Return the full knowledge graph, with optional filtering."""
    all_nodes = graph_store.get_all_nodes()
    all_edges = graph_store.get_all_edges()

    if doc_id:
        all_nodes = [n for n in all_nodes if doc_id in n.get("doc_ids", [])]
        node_ids = {n["id"] for n in all_nodes}
        all_edges = [
            e for e in all_edges
            if e["source"] in node_ids or e["target"] in node_ids
        ]

    if entity_type:
        entity_type_lower = entity_type.lower()
        all_nodes = [
            n for n in all_nodes
            if n.get("type", "entity").lower() == entity_type_lower
        ]
        node_ids = {n["id"] for n in all_nodes}
        all_edges = [
            e for e in all_edges
            if e["source"] in node_ids and e["target"] in node_ids
        ]

    if predicate:
        allowed = {p.strip() for p in predicate.split(",")}
        all_edges = [e for e in all_edges if e.get("predicate") in allowed]

    return GraphResponse(
        nodes=[_node_dict_to_schema(n) for n in all_nodes],
        edges=[_edge_dict_to_schema(e) for e in all_edges],
    )


# ---------------------------------------------------------------------------
# GET /api/graph/stats
# ---------------------------------------------------------------------------

@router.get("/stats", response_model=GraphStatsResponse)
def get_graph_stats(graph_store: GraphStore = Depends(get_graph_store)):
    """Return high-level graph statistics."""
    all_nodes = graph_store.get_all_nodes()
    all_edges = graph_store.get_all_edges()

    degree: dict = {}
    for e in all_edges:
        degree[e["source"]] = degree.get(e["source"], 0) + 1
        degree[e["target"]] = degree.get(e["target"], 0) + 1

    node_map = {n["id"]: n for n in all_nodes}
    top_10 = sorted(degree.items(), key=lambda x: x[1], reverse=True)[:10]
    top_entities = [
        {
            "id":     nid,
            "label":  node_map.get(nid, {}).get("label", nid),
            "degree": deg,
            "type":   node_map.get(nid, {}).get("type", "entity"),
        }
        for nid, deg in top_10
    ]

    all_doc_ids: set = set()
    for n in all_nodes:
        for did in n.get("doc_ids", []):
            all_doc_ids.add(did)

    return GraphStatsResponse(
        node_count=graph_store.node_count,
        edge_count=graph_store.edge_count,
        top_entities=top_entities,
        doc_count=len(all_doc_ids),
    )


# ---------------------------------------------------------------------------
# POST /api/graph/query
# ---------------------------------------------------------------------------

@router.post("/query", response_model=GraphQueryResponse)
def query_graph(
    request: GraphQueryRequest,
    graph_store: GraphStore = Depends(get_graph_store),
):
    """Return the subgraph relevant to a natural-language query, plus chunk_ids."""
    traversal = GraphTraversal(graph_store)

    query_words = [
        w.strip(".,;:!?\"'").lower()
        for w in request.query.split()
        if len(w) > 1
    ]

    matched_node_ids: List[str] = []
    for word in query_words:
        for nid in traversal.find_nodes_by_name(word, fuzzy=True):
            if nid not in matched_node_ids:
                matched_node_ids.append(nid)

    if not matched_node_ids:
        return GraphQueryResponse(nodes=[], edges=[], chunk_ids=[])

    all_nodes: List[dict] = []
    all_edges: List[dict] = []
    seen_nodes: set = set()
    seen_edges: set = set()

    for node_id in matched_node_ids[:5]:
        subgraph = traversal.get_neighborhood(node_id, hops=request.hops)
        for n in subgraph["nodes"]:
            if n["id"] not in seen_nodes:
                seen_nodes.add(n["id"])
                all_nodes.append(n)
        for e in subgraph["edges"]:
            key = (e["source"], e["target"], e.get("predicate", ""))
            if key not in seen_edges:
                seen_edges.add(key)
                all_edges.append(e)

    chunk_ids = traversal.get_chunk_ids_for_subgraph(list(seen_nodes))

    return GraphQueryResponse(
        nodes=[_node_dict_to_schema(n) for n in all_nodes],
        edges=[_edge_dict_to_schema(e) for e in all_edges],
        chunk_ids=chunk_ids,
    )


# ---------------------------------------------------------------------------
# DELETE /api/graph  — clear all graph data
# ---------------------------------------------------------------------------

@router.delete("", status_code=204)
def clear_graph(graph_store: GraphStore = Depends(get_graph_store)):
    """Wipe all nodes and edges from the graph store and persist the empty state."""
    graph_store.clear()
    graph_store.save()
    return Response(status_code=204)
