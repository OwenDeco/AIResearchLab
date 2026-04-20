from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Ingestion
# ---------------------------------------------------------------------------

class DocumentResponse(BaseModel):
    id: str
    filename: str
    file_type: str
    created_at: datetime
    chunk_strategy: str
    chunk_count: int
    doc_metadata: Dict[str, Any] = Field(default_factory=dict)
    graph_extracted: bool = False
    embedded_count: int = 0   # chunks successfully upserted into ChromaDB
    embedding_errors: int = 0  # batches that failed to embed

    model_config = {"from_attributes": True}


class ChunkResponse(BaseModel):
    id: str
    doc_id: str
    content: str
    chunk_index: int
    parent_chunk_id: Optional[str] = None
    start_char: int
    end_char: int
    metadata: Dict[str, Any] = Field(default_factory=dict)

    model_config = {"from_attributes": True}


# ---------------------------------------------------------------------------
# Query / Retrieval
# ---------------------------------------------------------------------------

class ContextItem(BaseModel):
    chunk_id: str
    doc_id: str
    content: str
    score: float
    metadata: Dict[str, Any] = Field(default_factory=dict)


class QueryRequest(BaseModel):
    query: str
    retrieval_mode: str = "vector"  # lexical, semantic_rerank, vector, hybrid, graph_rag, parent_child
    model_name: str = "openai/gpt-4o-mini"
    embed_model: str = "openai/text-embedding-3-small"
    top_k: int = 5
    graph_hops: int = 2
    alpha: float = 0.5  # hybrid retriever weight: 0=pure lexical, 1=pure vector
    # External connection routing (bypasses local retrieval when set)
    external_connection_id: Optional[str] = None
    external_connection_type: Optional[str] = None  # "a2a" or "mcp"


class QueryResponse(BaseModel):
    answer: str
    contexts: List[ContextItem]
    run_id: str
    latency_ms: float
    tokens: Dict[str, int] = Field(default_factory=dict)   # prompt, completion, total
    cost: float = 0.0
    stage_timings: Dict[str, float] = Field(default_factory=dict)
    retrieval_mode: str


# ---------------------------------------------------------------------------
# Run history
# ---------------------------------------------------------------------------

class RunResponse(BaseModel):
    id: str
    query: str
    retrieval_mode: str
    model_name: str
    embed_model: str
    answer: str
    contexts: List[ContextItem] = Field(default_factory=list)
    latency_ms: float
    prompt_tokens: int
    completion_tokens: int
    estimated_cost_usd: float
    stage_timings: Dict[str, float] = Field(default_factory=dict)
    chunk_count: int
    graph_node_count: int
    created_at: datetime

    model_config = {"from_attributes": True}


class RunListResponse(BaseModel):
    runs: List[RunResponse]
    total: int


# ---------------------------------------------------------------------------
# Benchmark
# ---------------------------------------------------------------------------

class BenchmarkQuestion(BaseModel):
    question: str
    reference_answer: str = ""
    doc_ids: List[str] = Field(default_factory=list)
    source_chunk_id: Optional[str] = None  # chunk the question was generated from


class BenchmarkConfig(BaseModel):
    label: str
    retrieval_mode: str
    model_name: str
    embed_model: str
    top_k: int = 5


class BenchmarkRunRequest(BaseModel):
    name: str
    question_set: List[BenchmarkQuestion]
    configs: List[BenchmarkConfig]


class BenchmarkRunResponse(BaseModel):
    id: str
    name: str
    status: str
    created_at: datetime
    completed_at: Optional[datetime] = None
    total_questions: int
    completed_questions: int
    configs: List[Dict[str, Any]] = Field(default_factory=list)

    model_config = {"from_attributes": True}


class BenchmarkResultResponse(BaseModel):
    id: str
    benchmark_run_id: str
    question: str
    reference_answer: str
    config_label: str
    retrieval_mode: str
    model_name: str
    embed_model: str
    answer: str
    context_precision: float
    answer_relevance: float
    hit_rate: Optional[float] = None
    mrr: Optional[float] = None
    answer_correctness: Optional[float] = None
    faithfulness: Optional[float] = None
    chunks_retrieved: Optional[int] = None
    source_doc_id: Optional[str] = None
    contexts: List[Dict[str, Any]] = Field(default_factory=list)
    latency_ms: float
    estimated_cost_usd: float
    created_at: datetime

    model_config = {"from_attributes": True}


# ---------------------------------------------------------------------------
# Graph
# ---------------------------------------------------------------------------

class GraphNode(BaseModel):
    id: str
    label: str
    type: str
    doc_ids: List[str] = Field(default_factory=list)
    chunk_ids: List[str] = Field(default_factory=list)


class GraphEdge(BaseModel):
    source: str
    target: str
    predicate: str
    chunk_id: str = ""
    confidence: float = 1.0
    evidence: str = ""


class GraphResponse(BaseModel):
    nodes: List[GraphNode]
    edges: List[GraphEdge]


# ---------------------------------------------------------------------------
# Session persistence
# ---------------------------------------------------------------------------

class BenchmarkSessionPayload(BaseModel):
    question_set: List[BenchmarkQuestion] = Field(default_factory=list)
    configs: List[BenchmarkConfig] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Models / Providers
# ---------------------------------------------------------------------------

class ModelsResponse(BaseModel):
    llms: List[str]
    embed_models: List[str]
    rerankers: List[str]
