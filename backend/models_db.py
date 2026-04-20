from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, Column, DateTime, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import relationship

from database import Base


class Document(Base):
    __tablename__ = "documents"

    id: str = Column(String, primary_key=True, index=True)
    filename: str = Column(String, nullable=False)
    file_type: str = Column(String, nullable=False)  # pdf, txt, md
    created_at: datetime = Column(DateTime, default=datetime.utcnow, nullable=False)
    chunk_strategy: str = Column(String, nullable=False)
    chunk_count: int = Column(Integer, default=0, nullable=False)
    doc_metadata: str = Column(Text, default="{}", nullable=False)  # JSON text
    graph_extracted: bool = Column(Boolean, default=False, nullable=False)

    chunks = relationship("Chunk", back_populates="document", cascade="all, delete-orphan")


class Chunk(Base):
    __tablename__ = "chunks"

    id: str = Column(String, primary_key=True, index=True)
    doc_id: str = Column(String, ForeignKey("documents.id"), nullable=False, index=True)
    content: str = Column(Text, nullable=False)
    chunk_index: int = Column(Integer, nullable=False)
    parent_chunk_id: str | None = Column(String, nullable=True)  # for parent-child
    start_char: int = Column(Integer, default=0, nullable=False)
    end_char: int = Column(Integer, default=0, nullable=False)
    metadata_json: str = Column(Text, default="{}", nullable=False)

    document = relationship("Document", back_populates="chunks")


class Run(Base):
    __tablename__ = "runs"

    id: str = Column(String, primary_key=True, index=True)
    query: str = Column(Text, nullable=False)
    retrieval_mode: str = Column(String, nullable=False)
    model_name: str = Column(String, nullable=False)
    embed_model: str = Column(String, nullable=False)
    answer: str = Column(Text, nullable=False)
    context_json: str = Column(Text, default="[]", nullable=False)  # list of chunk texts used
    latency_ms: float = Column(Float, nullable=False)
    prompt_tokens: int = Column(Integer, default=0, nullable=False)
    completion_tokens: int = Column(Integer, default=0, nullable=False)
    estimated_cost_usd: float = Column(Float, default=0.0, nullable=False)
    stage_timings_json: str = Column(Text, default="{}", nullable=False)
    chunk_count: int = Column(Integer, default=0, nullable=False)
    graph_node_count: int = Column(Integer, default=0, nullable=False)
    created_at: datetime = Column(DateTime, default=datetime.utcnow, nullable=False)


class BenchmarkRun(Base):
    __tablename__ = "benchmark_runs"

    id: str = Column(String, primary_key=True, index=True)
    name: str = Column(String, nullable=False)
    status: str = Column(String, default="pending", nullable=False)  # pending, running, completed, failed
    config_json: str = Column(Text, default="[]", nullable=False)
    created_at: datetime = Column(DateTime, default=datetime.utcnow, nullable=False)
    completed_at: datetime | None = Column(DateTime, nullable=True)
    total_questions: int = Column(Integer, default=0, nullable=False)
    completed_questions: int = Column(Integer, default=0, nullable=False)

    results = relationship("BenchmarkResult", back_populates="benchmark_run", cascade="all, delete-orphan")


class BenchmarkResult(Base):
    __tablename__ = "benchmark_results"

    id: str = Column(String, primary_key=True, index=True)
    benchmark_run_id: str = Column(String, ForeignKey("benchmark_runs.id"), nullable=False, index=True)
    question: str = Column(Text, nullable=False)
    reference_answer: str = Column(Text, default="", nullable=False)
    config_label: str = Column(String, nullable=False)
    retrieval_mode: str = Column(String, nullable=False)
    model_name: str = Column(String, nullable=False)
    embed_model: str = Column(String, nullable=False)
    answer: str = Column(Text, nullable=False)
    context_precision: float = Column(Float, default=0.0, nullable=False)
    answer_relevance: float = Column(Float, default=0.0, nullable=False)
    # Enhanced metrics
    hit_rate: float = Column(Float, default=0.0, nullable=True)
    mrr: float = Column(Float, default=0.0, nullable=True)
    answer_correctness: float = Column(Float, default=0.0, nullable=True)
    faithfulness: float = Column(Float, default=0.0, nullable=True)
    chunks_retrieved: int = Column(Integer, default=0, nullable=True)
    source_doc_id: str = Column(String, nullable=True)  # expected document for MRR/Hit evaluation
    contexts_json: str = Column(Text, nullable=True)  # JSON list of {chunk_id, doc_id, content, score}
    latency_ms: float = Column(Float, default=0.0, nullable=False)
    estimated_cost_usd: float = Column(Float, default=0.0, nullable=False)
    created_at: datetime = Column(DateTime, default=datetime.utcnow, nullable=False)

    benchmark_run = relationship("BenchmarkRun", back_populates="results")


class AppState(Base):
    """Simple key-value store for persisting UI state across restarts."""
    __tablename__ = "app_state"

    key: str = Column(String, primary_key=True)
    value: str = Column(Text, nullable=False, default="{}")
    updated_at: datetime = Column(DateTime, default=datetime.utcnow, nullable=False)


class ConnectionLog(Base):
    """Audit log for all connection events (inbound calls, registrations, tunnel changes)."""
    __tablename__ = "connection_logs"

    id: str = Column(String, primary_key=True)
    timestamp: datetime = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)
    # Groups all events for one A2A request: inbound → LLM → tools → outbound
    trace_id: str | None = Column(String, nullable=True, index=True)
    # "registered", "deleted", "tested", "ngrok_start", "ngrok_stop",
    # "inbound_call", "outbound_call", "llm_tool_selection", "tool_chosen",
    # "mcp_tool_call", "mcp_tool_response", "native_tool_call"
    event_type: str = Column(String, nullable=False)
    # "inbound", "outbound", "internal", "system"
    direction: str = Column(String, nullable=False)
    # "a2a", "mcp", "ngrok", "agent"
    connection_type: str | None = Column(String, nullable=True)
    connection_name: str | None = Column(String, nullable=True)
    connection_id: str | None = Column(String, nullable=True)
    # IP or agent identifier for inbound calls
    caller: str | None = Column(String, nullable=True)
    summary: str = Column(String, nullable=False)
    details_json: str | None = Column(Text, nullable=True)
    run_id: str | None = Column(String, nullable=True, index=True)


class AgentSession(Base):
    """A named, persistent conversation session with the RAG Lab Agent."""
    __tablename__ = "agent_sessions"

    id: str = Column(String, primary_key=True)
    name: str = Column(String, nullable=False)
    created_at: datetime = Column(DateTime, default=datetime.utcnow, nullable=False)
    last_active: datetime = Column(DateTime, default=datetime.utcnow, nullable=False)
    message_count: int = Column(Integer, default=0, nullable=False)
    messages_json: str = Column(Text, default="[]", nullable=False)


class UnifiedRun(Base):
    __tablename__ = "unified_runs"
    id = Column(String, primary_key=True)
    parent_run_id = Column(String, nullable=True, index=True)
    experiment_id = Column(String, nullable=True)
    primary_domain = Column(String, nullable=False)
    run_type = Column(String, nullable=False)
    initiated_by = Column(String, default="user")
    status = Column(String, default="running")
    started_at = Column(DateTime, default=datetime.utcnow, index=True)
    ended_at = Column(DateTime, nullable=True)
    source_id = Column(String, nullable=True)
    source_table = Column(String, nullable=True)
    summary_json = Column(Text, nullable=True)


class RunStep(Base):
    __tablename__ = "run_steps"
    id = Column(String, primary_key=True)
    run_id = Column(String, index=True, nullable=False)
    parent_step_id = Column(String, nullable=True)
    domain = Column(String, nullable=False)
    step_type = Column(String, nullable=False)
    component = Column(String, nullable=True)
    started_at = Column(DateTime, nullable=False)
    ended_at = Column(DateTime, nullable=True)
    duration_ms = Column(Float, nullable=True)
    status = Column(String, default="completed")
    metrics_json = Column(Text, nullable=True)
    input_summary = Column(Text, nullable=True)
    output_summary = Column(Text, nullable=True)
    error_message = Column(Text, nullable=True)


class RunEvent(Base):
    __tablename__ = "run_events"
    id = Column(String, primary_key=True)
    run_id = Column(String, nullable=True, index=True)
    step_id = Column(String, nullable=True)
    event_type = Column(String, nullable=False)
    category = Column(String, nullable=False)
    severity = Column(String, default="info")
    timestamp = Column(DateTime, default=datetime.utcnow, index=True)
    payload_json = Column(Text, nullable=True)
    summary = Column(String, nullable=True)
    source = Column(String, nullable=True)
