"""
CRUD + chat endpoints for user-defined agent configurations.
Stored in AppState (SQLite key-value store) as JSON.
"""
from __future__ import annotations

import json
import logging
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

from api.deps import get_db, get_chroma, get_bm25_index, get_graph_store
from config import settings

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/agent-configs", tags=["agent-configs"])

_CONFIGS_KEY = "agent_configs"


# ---------------------------------------------------------------------------
# Storage helpers
# ---------------------------------------------------------------------------

def _load_configs(db: Session) -> List[Dict]:
    from models_db import AppState
    row = db.query(AppState).filter(AppState.key == _CONFIGS_KEY).first()
    if row is None:
        return []
    try:
        return json.loads(row.value) or []
    except Exception:
        return []


def _save_configs(db: Session, data: List[Dict]) -> None:
    from models_db import AppState
    value = json.dumps(data)
    row = db.query(AppState).filter(AppState.key == _CONFIGS_KEY).first()
    if row is None:
        db.add(AppState(key=_CONFIGS_KEY, value=value))
    else:
        row.value = value
        row.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
    db.commit()


def _now() -> str:
    return datetime.now(timezone.utc).replace(tzinfo=None).isoformat()


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

class AgentToolsConfig(BaseModel):
    mcp_connection_ids: List[str] = []
    a2a_connection_ids: List[str] = []
    agent_ids: List[str] = []
    use_own_a2a: bool = False


class AgentRAGConfig(BaseModel):
    enabled: bool = False
    retrieval_mode: str = "hybrid"
    model_name: str = ""
    embed_model: str = ""
    top_k: int = 5


class AgentConfigCreate(BaseModel):
    name: str
    role: str = ""
    system_prompt: str = ""
    tools: AgentToolsConfig = AgentToolsConfig()
    rag: AgentRAGConfig = AgentRAGConfig()


class AgentConfigUpdate(AgentConfigCreate):
    pass


class AgentChatMessage(BaseModel):
    role: str
    content: str


class AgentConfigChatRequest(BaseModel):
    message: str
    history: List[AgentChatMessage] = []
    parent_run_id: Optional[str] = None  # set internally when called as a sub-agent


# ---------------------------------------------------------------------------
# CRUD
# ---------------------------------------------------------------------------

@router.get("")
def list_configs(db: Session = Depends(get_db)):
    return _load_configs(db)


@router.post("", status_code=201)
def create_config(body: AgentConfigCreate, db: Session = Depends(get_db)):
    configs = _load_configs(db)
    now = _now()
    new_cfg: Dict[str, Any] = {
        "id": str(uuid.uuid4()),
        "name": body.name.strip() or "Unnamed Agent",
        "role": body.role,
        "system_prompt": body.system_prompt,
        "tools": body.tools.model_dump(),
        "rag": body.rag.model_dump(),
        "created_at": now,
        "updated_at": now,
    }
    configs.append(new_cfg)
    _save_configs(db, configs)
    return new_cfg


@router.get("/{config_id}")
def get_config(config_id: str, db: Session = Depends(get_db)):
    configs = _load_configs(db)
    cfg = next((c for c in configs if c["id"] == config_id), None)
    if cfg is None:
        raise HTTPException(status_code=404, detail="Agent config not found.")
    return cfg


@router.put("/{config_id}")
def update_config(config_id: str, body: AgentConfigUpdate, db: Session = Depends(get_db)):
    configs = _load_configs(db)
    idx = next((i for i, c in enumerate(configs) if c["id"] == config_id), None)
    if idx is None:
        raise HTTPException(status_code=404, detail="Agent config not found.")
    configs[idx].update({
        "name": body.name.strip() or configs[idx]["name"],
        "role": body.role,
        "system_prompt": body.system_prompt,
        "tools": body.tools.model_dump(),
        "rag": body.rag.model_dump(),
        "updated_at": _now(),
    })
    _save_configs(db, configs)
    return configs[idx]


@router.delete("/{config_id}", status_code=204)
def delete_config(config_id: str, db: Session = Depends(get_db)):
    configs = _load_configs(db)
    configs = [c for c in configs if c["id"] != config_id]
    _save_configs(db, configs)


@router.post("/{config_id}/a2a")
async def agent_a2a_endpoint(config_id: str, request: Request, db: Session = Depends(get_db)):
    body = await request.json()
    parts = body.get("message", {}).get("parts", [])
    text = "".join(part.get("text", "") for part in parts if isinstance(part, dict))
    chat_req = AgentConfigChatRequest(message=text, history=[])
    result = await chat_with_agent(config_id, chat_req, request, db)
    return {
        "id": str(uuid.uuid4()),
        "result": {"parts": [{"text": result["answer"]}]},
        "metadata": {"latency_ms": result["latency_ms"], "run_id": result["run_id"]},
    }


# ---------------------------------------------------------------------------
# Run tracking helpers
# ---------------------------------------------------------------------------

def _create_run(db: Session, cfg: Dict, message: str, parent_run_id: Optional[str] = None) -> str:
    from models_db import UnifiedRun, RunEvent
    from api.conn_log import log_conn_event
    run_id = str(uuid.uuid4())
    now = datetime.utcnow()
    db.add(UnifiedRun(
        id=run_id,
        parent_run_id=parent_run_id,
        primary_domain="orchestration",
        run_type="agent_chat",
        initiated_by="user",
        status="running",
        started_at=now,
        source_id=cfg["id"],
        source_table="agent_configs",
        summary_json=json.dumps({
            "name": cfg.get("name", ""),
            "message_preview": message,
        }),
    ))
    db.add(RunEvent(
        id=str(uuid.uuid4()),
        run_id=run_id,
        event_type="started",
        category="execution",
        severity="info",
        timestamp=now,
        summary=f"[{cfg.get('name','')}] {message}",
        source="agent_config",
    ))
    db.commit()
    log_conn_event(
        db,
        event_type="agent_chat_started",
        direction="inbound",
        connection_type="agent",
        connection_name=cfg.get("name", ""),
        summary=f"[{cfg.get('name','')}] {message}",
        trace_id=run_id,
        run_id=run_id,
        details={"message": message, "agent_id": cfg["id"]},
        write_run_event=False,
    )
    return run_id


def _add_step(
    db: Session,
    run_id: str,
    step_type: str,
    component: str,
    started_at: datetime,
    ended_at: datetime,
    status: str = "completed",
    input_summary: Optional[str] = None,
    output_summary: Optional[str] = None,
    error_message: Optional[str] = None,
    metrics: Optional[Dict] = None,
    domain: str = "orchestration",
) -> str:
    from models_db import RunStep, RunEvent
    step_id = str(uuid.uuid4())
    duration_ms = round((ended_at - started_at).total_seconds() * 1000, 1)
    db.add(RunStep(
        id=step_id,
        run_id=run_id,
        domain=domain,
        step_type=step_type,
        component=component,
        started_at=started_at,
        ended_at=ended_at,
        duration_ms=duration_ms,
        status=status,
        input_summary=input_summary,
        output_summary=output_summary,
        error_message=error_message,
        metrics_json=json.dumps(metrics) if metrics else None,
    ))
    brief = f"{step_type.replace('_', ' ')} — {component}"
    if output_summary:
        brief += f" · {output_summary[:80]}"
    elif error_message:
        brief += f" · {error_message[:80]}"

    payload: Dict[str, Any] = {"duration_ms": duration_ms}
    if input_summary:
        payload["input"] = input_summary
    if output_summary:
        payload["output"] = output_summary
    if error_message:
        payload["error"] = error_message
    if metrics:
        payload["metrics"] = metrics

    from api.conn_log import log_conn_event
    category = "ai" if "llm" in step_type else "data" if "rag" in step_type else "connection"
    db.add(RunEvent(
        id=str(uuid.uuid4()),
        run_id=run_id,
        step_id=step_id,
        event_type=step_type,
        category=category,
        severity="error" if status == "failed" else "info",
        timestamp=ended_at,
        summary=brief,
        payload_json=json.dumps(payload) if payload else None,
        source="agent_config",
    ))
    db.commit()

    # Map step types to connection log directions/types
    _direction = "outbound" if step_type in ("mcp_tool_call", "a2a_tool_call") else "internal"
    _conn_type = "mcp" if "mcp" in step_type else "a2a" if "a2a" in step_type else "agent"
    log_conn_event(
        db,
        event_type=step_type,
        direction=_direction,
        connection_type=_conn_type,
        connection_name=component,
        summary=brief,
        trace_id=run_id,
        run_id=run_id,
        details=payload if payload else None,
        write_run_event=False,  # RunEvent already written above with step_id link
    )
    return step_id


def _finish_run(db: Session, run_id: str, status: str, summary_extra: Dict) -> None:
    from models_db import UnifiedRun, RunEvent, RunStep
    from api.conn_log import log_conn_event
    now = datetime.utcnow()
    row = db.query(UnifiedRun).filter(UnifiedRun.id == run_id).first()
    agent_name = ""
    if row:
        existing = json.loads(row.summary_json or "{}")
        agent_name = existing.get("name", "")
        step_count = db.query(RunStep).filter(RunStep.run_id == run_id).count()
        existing.update(summary_extra)
        existing["step_count"] = step_count
        row.status = status
        row.ended_at = now
        row.summary_json = json.dumps(existing)
    finish_summary = f"Run {status} — {summary_extra.get('total_latency_ms', '?')} ms"
    db.add(RunEvent(
        id=str(uuid.uuid4()),
        run_id=run_id,
        event_type="completed" if status == "completed" else "failed",
        category="execution",
        severity="info" if status == "completed" else "error",
        timestamp=now,
        summary=finish_summary,
        source="agent_config",
    ))
    db.commit()
    log_conn_event(
        db,
        event_type="agent_chat_completed" if status == "completed" else "agent_chat_failed",
        direction="outbound",
        connection_type="agent",
        connection_name=agent_name,
        summary=finish_summary,
        trace_id=run_id,
        run_id=run_id,
        details={"status": status, **{k: v for k, v in summary_extra.items() if k != "final_output"}},
        write_run_event=False,
    )


# ---------------------------------------------------------------------------
# Chat endpoint
# ---------------------------------------------------------------------------

_MAX_TOOL_ITERATIONS = 8


@router.post("/{config_id}/chat")
async def chat_with_agent(
    config_id: str,
    body: AgentConfigChatRequest,
    request: Request,
    db: Session = Depends(get_db),
):
    from models.registry import get_llm
    from connections.mcp_client import _call_tool_async, _unwrap_exception
    from connections.a2a_client import call_agent
    from api.routes.a2a import _build_agent_tools, _build_a2a_tools
    import asyncio as _asyncio

    t_start = time.monotonic()

    # Load config
    configs = _load_configs(db)
    cfg = next((c for c in configs if c["id"] == config_id), None)
    if cfg is None:
        raise HTTPException(status_code=404, detail="Agent config not found.")

    rag_cfg = cfg.get("rag", {})
    tools_cfg = cfg.get("tools", {})

    # ---- Create UnifiedRun ------------------------------------------------
    run_id = _create_run(db, cfg, body.message, parent_run_id=body.parent_run_id)

    # ---- 1. System prompt ------------------------------------------------
    base_prompt = cfg.get("system_prompt", "").strip()
    if not base_prompt:
        role = cfg.get("role", "general purpose assistant")
        base_prompt = f"You are a helpful AI assistant. Your role: {role}."

    # ---- 2. RAG context (optional) ---------------------------------------
    rag_context = ""
    rag_chunk_count = 0
    if rag_cfg.get("enabled"):
        rag_start = datetime.utcnow()
        rag_status = "completed"
        rag_error: Optional[str] = None
        try:
            from retrieval.factory import build_retriever
            from retrieval.base import RetrievedChunk
            from models_db import Chunk as ChunkModel

            retriever = build_retriever(
                mode=rag_cfg.get("retrieval_mode", "hybrid"),
                embed_model=rag_cfg.get("embed_model") or settings.DEFAULT_EMBED_MODEL,
                model_name=rag_cfg.get("model_name") or settings.DEFAULT_LLM,
                db=db,
                chroma=request.app.state.chroma_collection,
                bm25_index=request.app.state.bm25_index,
                graph_store=request.app.state.graph_store,
            )
            chunks: List[RetrievedChunk] = retriever.retrieve(body.message, top_k=int(rag_cfg.get("top_k", 5)))

            needs_content = [c for c in chunks if not c.content]
            if needs_content:
                rows = db.query(ChunkModel).filter(
                    ChunkModel.id.in_([c.chunk_id for c in needs_content])
                ).all()
                row_map = {r.id: r for r in rows}
                for chunk in needs_content:
                    row = row_map.get(chunk.chunk_id)
                    if row:
                        chunk.content = row.content
                        chunk.doc_id = row.doc_id or chunk.doc_id

            if chunks:
                rag_context = "\n\n".join(
                    f"[{i+1}] (doc: {c.doc_id})\n{c.content}"
                    for i, c in enumerate(chunks) if c.content
                )
                rag_chunk_count = len(chunks)
        except Exception as exc:
            rag_status = "failed"
            rag_error = str(exc)
            logger.warning("Agent config chat: RAG retrieval failed: %s", exc)

        _add_step(
            db, run_id,
            step_type="rag_retrieval",
            component=rag_cfg.get("retrieval_mode", "hybrid"),
            started_at=rag_start,
            ended_at=datetime.utcnow(),
            status=rag_status,
            input_summary=body.message,
            output_summary=rag_context if rag_context else "No chunks found",
            error_message=rag_error,
            metrics={"chunks_retrieved": rag_chunk_count, "top_k": int(rag_cfg.get("top_k", 5))},
        )

    system_content = base_prompt
    if rag_context:
        system_content += (
            "\n\n## Retrieved context\n"
            "Use the following retrieved passages to answer the user's question:\n\n"
            + rag_context
        )

    # ---- 3. Message list -------------------------------------------------
    messages: List[Dict] = [{"role": "system", "content": system_content}]
    for turn in body.history:
        messages.append({"role": turn.role, "content": turn.content})
    messages.append({"role": "user", "content": body.message})

    # ---- 4. Build tool list with name maps for dispatch ------------------
    all_tools: List[Dict] = []
    mcp_name_map: Dict[str, Any] = {}
    a2a_name_map: Dict[str, Any] = {}
    agent_name_map: Dict[str, Any] = {}

    mcp_ids = set(tools_cfg.get("mcp_connection_ids", []))
    a2a_ids = set(tools_cfg.get("a2a_connection_ids", []))
    sub_agent_ids = set(tools_cfg.get("agent_ids", []))

    try:
        if mcp_ids:
            from api.routes.registered_connections import _load_list, _MCP_KEY
            all_mcp = _load_list(db, _MCP_KEY)
            selected_mcp = [c for c in all_mcp if c.get("id") in mcp_ids and c.get("tool_schemas")]
            mcp_tools, mcp_name_map = _build_agent_tools(selected_mcp)
            all_tools.extend(mcp_tools)

        if a2a_ids:
            from api.routes.registered_connections import _load_list, _A2A_KEY
            all_a2a = _load_list(db, _A2A_KEY)
            selected_a2a = [c for c in all_a2a if c.get("id") in a2a_ids and c.get("task_url")]
            a2a_tools, a2a_name_map = _build_a2a_tools(selected_a2a)
            all_tools.extend(a2a_tools)

        if sub_agent_ids:
            import re as _re
            all_cfgs = _load_configs(db)
            sub_agents = [c for c in all_cfgs if c.get("id") in sub_agent_ids and c["id"] != config_id]
            for sub in sub_agents:
                safe = _re.sub(r'[^a-zA-Z0-9_-]', '_', sub['name'])[:50]
                tool_name = f"agent__{safe}"[:64]
                desc = sub.get('role') or (sub.get('system_prompt', '')[:120])
                full_desc = f"[Sub-agent: {sub['name']}] {desc}".strip()
                all_tools.append({
                    "type": "function",
                    "function": {
                        "name": tool_name,
                        "description": full_desc,
                        "parameters": {
                            "type": "object",
                            "properties": {
                                "query": {"type": "string", "description": "The task or question to delegate to this agent"},
                            },
                            "required": ["query"],
                        },
                    },
                })
                agent_name_map[tool_name] = sub
    except Exception as exc:
        logger.warning("Agent config chat: tool list build failed: %s", exc)

    # ---- 5. LLM selection ------------------------------------------------
    model_name = rag_cfg.get("model_name") or settings.AGENT_MODEL or settings.DEFAULT_LLM
    try:
        llm = get_llm(model_name)
    except Exception:
        try:
            llm = get_llm(settings.DEFAULT_LLM)
            model_name = settings.DEFAULT_LLM
        except Exception as exc:
            _finish_run(db, run_id, "failed", {"error": str(exc)})
            raise HTTPException(status_code=503, detail=f"Could not load LLM: {exc}")

    # ---- 6. Tool-calling loop or plain completion ------------------------
    answer = ""
    total_prompt_tokens = 0
    total_completion_tokens = 0
    run_status = "completed"

    try:
        if all_tools and hasattr(llm, "complete_with_tools"):
            for iteration in range(_MAX_TOOL_ITERATIONS):
                llm_start = datetime.utcnow()
                response = llm.complete_with_tools(
                    messages=messages,
                    tools=all_tools,
                    temperature=0.3,
                    max_tokens=2048,
                )
                llm_end = datetime.utcnow()
                prompt_tokens = getattr(response, "prompt_tokens", 0) or 0
                completion_tokens = getattr(response, "completion_tokens", 0) or 0
                total_prompt_tokens += prompt_tokens
                total_completion_tokens += completion_tokens

                llm_input = f"Query: {body.message}"
                if rag_context:
                    llm_input += f"\n\nRAG context ({rag_chunk_count} chunks):\n{rag_context}"
                _add_step(
                    db, run_id,
                    step_type="llm_call",
                    component=model_name,
                    started_at=llm_start,
                    ended_at=llm_end,
                    input_summary=llm_input,
                    output_summary=response.content if response.content else f"{len(response.tool_calls or [])} tool call(s) requested",
                    metrics={
                        "prompt_tokens": prompt_tokens,
                        "completion_tokens": completion_tokens,
                        "iteration": iteration + 1,
                        "tool_calls": len(response.tool_calls or []),
                    },
                )

                if not response.tool_calls:
                    answer = response.content
                    break

                messages.append({
                    "role": "assistant",
                    "content": response.content or None,
                    "tool_calls": response.tool_calls,
                })

                async def _dispatch_tc(tc) -> tuple:
                    fn_name = tc["function"]["name"]
                    try:
                        fn_args = json.loads(tc["function"].get("arguments") or "{}")
                    except Exception:
                        fn_args = {}
                    tool_call_id = tc.get("id", fn_name)

                    tool_start = datetime.utcnow()
                    result_str = ""
                    tool_status = "completed"
                    tool_error: Optional[str] = None
                    step_component = fn_name
                    step_type = "tool_call"

                    # Write "dispatching" event immediately so live polling can see it
                    from models_db import RunEvent as _RE
                    _label = (
                        mcp_name_map[fn_name][0]["name"] if fn_name in mcp_name_map
                        else a2a_name_map[fn_name]["name"] if fn_name in a2a_name_map
                        else agent_name_map[fn_name]["name"] if fn_name in agent_name_map
                        else fn_name
                    )
                    db.add(_RE(
                        id=str(uuid.uuid4()),
                        run_id=run_id,
                        event_type="dispatching",
                        category="connection",
                        severity="info",
                        timestamp=tool_start,
                        summary=f"Dispatching → {_label}",
                        source="agent_config",
                        payload_json=json.dumps({"tool": fn_name, "args": fn_args}),
                    ))
                    db.commit()

                    try:
                        if fn_name in mcp_name_map:
                            conn, original_name = mcp_name_map[fn_name]
                            result_str = str(await _call_tool_async(
                                conn["server_url"],
                                conn.get("transport", "sse"),
                                original_name,
                                fn_args,
                            ))
                            step_component = f"{conn['name']}/{original_name}"
                            step_type = "mcp_tool_call"
                        elif fn_name in a2a_name_map:
                            agent_conn = a2a_name_map[fn_name]
                            query = fn_args.get("query", "")
                            result_str = str(await _asyncio.to_thread(
                                call_agent, agent_conn["task_url"], query
                            ))
                            step_component = agent_conn["name"]
                            step_type = "a2a_tool_call"
                        elif fn_name in agent_name_map:
                            sub_cfg = agent_name_map[fn_name]
                            query = fn_args.get("query", "")
                            sub_req = AgentConfigChatRequest(message=query, history=[], parent_run_id=run_id)
                            sub_result = await chat_with_agent(sub_cfg["id"], sub_req, request, db)
                            result_str = sub_result["answer"]
                            step_component = sub_cfg["name"]
                            step_type = "a2a_tool_call"
                        else:
                            result_str = f"Unknown tool: {fn_name}"
                            step_component = fn_name
                            step_type = "unknown_tool_call"
                            tool_status = "failed"
                            tool_error = result_str
                    except BaseException as exc:
                        result_str = f"Tool error: {_unwrap_exception(exc)}"
                        tool_status = "failed"
                        tool_error = result_str
                        step_component = fn_name
                        step_type = "tool_call"
                        logger.warning("Agent config: tool %s failed: %s", fn_name, result_str)

                    tool_end = datetime.utcnow()
                    return (tool_call_id, result_str, step_type, step_component,
                            tool_status, tool_error, fn_name, fn_args, tool_start, tool_end)

                dispatch_results = await _asyncio.gather(
                    *[_dispatch_tc(tc) for tc in response.tool_calls],
                    return_exceptions=False,
                )

                for (tool_call_id, result_str, step_type, step_component,
                     tool_status, tool_error, fn_name, fn_args, tool_start, tool_end) in dispatch_results:
                    _add_step(
                        db, run_id,
                        step_type=step_type,
                        component=step_component,
                        started_at=tool_start,
                        ended_at=tool_end,
                        status=tool_status,
                        input_summary=json.dumps(fn_args, indent=2),
                        output_summary=result_str,
                        error_message=tool_error,
                        metrics={"tool_name": fn_name},
                    )

                    messages.append({
                        "role": "tool",
                        "tool_call_id": tool_call_id,
                        "content": result_str,
                    })
            else:
                answer = "Reached maximum tool iterations without a final answer."
        else:
            llm_start = datetime.utcnow()
            response = llm.complete(messages=messages, temperature=0.3, max_tokens=2048)
            llm_end = datetime.utcnow()
            answer = response.content
            prompt_tokens = getattr(response, "prompt_tokens", 0) or 0
            completion_tokens = getattr(response, "completion_tokens", 0) or 0
            total_prompt_tokens += prompt_tokens
            total_completion_tokens += completion_tokens

            llm_input = f"Query: {body.message}"
            if rag_context:
                llm_input += f"\n\nRAG context ({rag_chunk_count} chunks):\n{rag_context}"
            _add_step(
                db, run_id,
                step_type="llm_call",
                component=model_name,
                started_at=llm_start,
                ended_at=llm_end,
                input_summary=llm_input,
                output_summary=answer,
                metrics={
                    "prompt_tokens": prompt_tokens,
                    "completion_tokens": completion_tokens,
                },
            )

    except Exception as exc:
        run_status = "failed"
        logger.error("Agent config chat: LLM failed: %s", exc, exc_info=True)
        answer = f"Error: {exc}"

    latency_ms = round((time.monotonic() - t_start) * 1000, 1)

    from observability.tracker import _estimate_cost
    _finish_run(db, run_id, run_status, {
        "total_latency_ms": latency_ms,
        "total_tokens": total_prompt_tokens + total_completion_tokens,
        "total_cost_usd": _estimate_cost(total_prompt_tokens, total_completion_tokens, model_name),
        "final_output": answer,
        "rag_chunks": rag_chunk_count,
        "model": model_name,
    })

    return {
        "answer": answer,
        "latency_ms": latency_ms,
        "rag_used": bool(rag_context),
        "run_id": run_id,
    }
