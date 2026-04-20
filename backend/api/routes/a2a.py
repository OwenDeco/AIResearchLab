"""
A2A (Agent-to-Agent) protocol implementation for the RAG Lab Agent.

Spec: https://google.github.io/A2A/specification/

Exposes two routes (mounted at root, not /api):
  GET  /.well-known/agent.json   — Agent Card discovery
  POST /a2a                      — JSON-RPC 2.0 task endpoint

Supported JSON-RPC methods:
  tasks/send            — synchronous: returns completed Task
  tasks/sendSubscribe   — streaming:   SSE stream of status + artifact events
  tasks/get             — retrieve a task by ID (ephemeral in-memory store)
  tasks/cancel          — cancel a task (no-op for completed sync tasks)
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import time
import uuid
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, StreamingResponse

from config import settings

logger = logging.getLogger(__name__)

router = APIRouter(tags=["a2a"])

# ---------------------------------------------------------------------------
# Ephemeral in-memory task store (process lifetime only)
# ---------------------------------------------------------------------------
_tasks: Dict[str, Dict] = {}


# ---------------------------------------------------------------------------
# Agent Card
# ---------------------------------------------------------------------------

def _agent_card() -> Dict[str, Any]:
    from api.routes.connections import get_effective_base_url
    base = get_effective_base_url().rstrip("/")

    skills = [
        {
            "id": "project-qa",
            "name": "Project Q&A",
            "description": (
                "Answer any question about the RAG Lab application: "
                "API endpoints, retrieval modes, chunking strategies, "
                "graph extraction, benchmarking, model providers, "
                "environment variables, and frontend pages."
            ),
            "tags": ["rag", "documentation", "qa", "api-reference"],
            "examples": [
                "What retrieval modes are available?",
                "How do I configure Azure OpenAI?",
                "What does the alpha parameter do in hybrid retrieval?",
                "Which API endpoint lists all documents?",
                "How does graph extraction work?",
                "What metrics does the benchmark produce?",
            ],
        }
    ]

    # Append one skill per native data tool
    try:
        from api.routes.mcp_server import NATIVE_TOOL_SCHEMAS
        for schema in NATIVE_TOOL_SCHEMAS:
            fn = schema["function"]
            skills.append({
                "id": f"native-{fn['name']}",
                "name": fn["name"].replace("_", " ").title(),
                "description": fn["description"],
                "tags": ["native", "data"],
            })
    except Exception:
        pass

    # Append one skill per enabled MCP connection
    for conn in _load_mcp_connections():
        tool_names = [s["name"] for s in conn.get("tool_schemas", [])]
        skills.append({
            "id": f"mcp-{_safe_tool_name(conn['name'])}",
            "name": conn["name"],
            "description": conn.get("description", f"External MCP connection: {conn['name']}"),
            "tags": ["mcp", "external"],
            "examples": tool_names[:3],
        })

    # Append one skill per enabled A2A agent
    for agent in _load_a2a_connections():
        skills.append({
            "id": f"a2a-{_safe_tool_name(agent['name'])}",
            "name": agent["name"],
            "description": agent.get("description", f"External A2A agent: {agent['name']}"),
            "tags": ["a2a", "external"],
            "examples": agent.get("skills", [])[:3],
        })

    return {
        "name": "RAG Lab Agent",
        "description": (
            "Expert assistant for the RAG Lab platform. "
            "Answers questions about API endpoints and parameters, retrieval modes "
            "(lexical, vector, hybrid, graph_rag, parent_child, semantic_rerank), "
            "chunking strategies, graph extraction, benchmarking metrics, "
            "model configuration, environment variables, and all frontend features. "
            "Also connects to registered external MCP servers as tools."
        ),
        "url": f"{base}/a2a",
        "version": "1.0.0",
        "capabilities": {
            "streaming": True,
            "pushNotifications": False,
            "stateTransitionHistory": False,
            "methods": ["tasks/send", "message/send", "tasks/sendSubscribe", "message/stream"],
        },
        "authentication": {
            "schemes": ["None"],
        },
        "defaultInputModes": ["text/plain"],
        "defaultOutputModes": ["text/plain"],
        "skills": skills,
    }


def _agent_card_response():
    return JSONResponse(
        content=_agent_card(),
        headers={"ngrok-skip-browser-warning": "true"},
    )


@router.get("/.well-known/agent.json")
def get_agent_card():
    """Serve the A2A Agent Card for discovery."""
    return _agent_card_response()


@router.get("/.well-known/agent-card.json")
def get_agent_card_alias():
    """Alias used by some A2A clients (e.g. OutSystems)."""
    return _agent_card_response()


# ---------------------------------------------------------------------------
# Helpers — A2A message/task building
# ---------------------------------------------------------------------------

def _text_from_message(message: Dict) -> str:
    """Extract plain text from an A2A message object."""
    parts = message.get("parts", [])
    texts = []
    for part in parts:
        if isinstance(part, dict):
            if part.get("type") == "text":
                texts.append(part.get("text", ""))
            elif "text" in part:          # lenient fallback
                texts.append(part["text"])
    return "\n".join(texts).strip()


def _make_task(task_id: str, state: str, answer: str = "", context_id: str = "") -> Dict:
    task: Dict[str, Any] = {
        "id": task_id,
        "contextId": context_id or task_id,
        "status": {"state": state},
    }
    if answer:
        task["artifacts"] = [
            {
                "artifactId": str(uuid.uuid4()),
                "parts": [{"type": "text", "text": answer}],
                "index": 0,
                "lastChunk": True,
            }
        ]
    return task


def _jsonrpc_result(rpc_id: Any, result: Any) -> Dict:
    return {"jsonrpc": "2.0", "id": rpc_id, "result": result}


def _jsonrpc_error(rpc_id: Any, code: int, message: str) -> Dict:
    return {"jsonrpc": "2.0", "id": rpc_id, "error": {"code": code, "message": message}}


# ---------------------------------------------------------------------------
# MCP tool helpers
# ---------------------------------------------------------------------------

_MAX_TOOL_ITERATIONS = 10


def _log_trace(
    trace_id: Optional[str],
    *,
    event_type: str,
    direction: str,
    summary: str,
    run_id: Optional[str] = None,
    **kwargs,
) -> None:
    """Fire-and-forget connection log entry tagged with a trace_id."""
    try:
        from database import SessionLocal
        from api.conn_log import log_conn_event
        db = SessionLocal()
        try:
            log_conn_event(db, event_type=event_type, direction=direction,
                           summary=summary, trace_id=trace_id, run_id=run_id, **kwargs)
        finally:
            db.close()
    except Exception as exc:
        logger.warning("A2A trace log failed: %s", exc)


def _safe_tool_name(name: str) -> str:
    """Sanitize to OpenAI tool name format ([a-zA-Z0-9_-], max 64 chars)."""
    return re.sub(r"[^a-zA-Z0-9_-]", "_", name)[:40]


def _load_mcp_connections() -> List[Dict]:
    """Load registered MCP connections that are enabled as agent tools."""
    try:
        from database import SessionLocal
        from api.routes.registered_connections import _load_list, _MCP_KEY
        db = SessionLocal()
        try:
            return [
                c for c in _load_list(db, _MCP_KEY)
                if c.get("tool_schemas") and c.get("agent_tool_enabled", True)
            ]
        finally:
            db.close()
    except Exception as exc:
        logger.warning("Could not load MCP connections: %s", exc)
        return []


def _load_a2a_connections() -> List[Dict]:
    """Load registered A2A agents that are enabled as agent tools."""
    try:
        from database import SessionLocal
        from api.routes.registered_connections import _load_list, _A2A_KEY
        db = SessionLocal()
        try:
            return [
                c for c in _load_list(db, _A2A_KEY)
                if c.get("task_url") and c.get("agent_tool_enabled", True)
            ]
        finally:
            db.close()
    except Exception as exc:
        logger.warning("Could not load A2A connections: %s", exc)
        return []


def _build_a2a_tools(agents: List[Dict]) -> Tuple[List[Dict], Dict[str, Dict]]:
    """
    Build OpenAI tool schemas for registered A2A agents.
    Each agent becomes a single tool with one 'query' string parameter.
    Returns (openai_tools, name_map) where name_map maps tool name → agent entry.
    """
    tools: List[Dict] = []
    name_map: Dict[str, Dict] = {}

    for agent in agents:
        tool_name = f"a2a__{_safe_tool_name(agent['name'])}"[:64]
        skills = ", ".join(agent.get("skills", [])[:5])
        description = agent.get("description", "")
        full_desc = f"[A2A Agent: {agent['name']}] {description}"
        if skills:
            full_desc += f" Skills: {skills}."

        tools.append({
            "type": "function",
            "function": {
                "name": tool_name,
                "description": full_desc.strip(),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {"type": "string", "description": "The question or task to send to the agent"},
                    },
                    "required": ["query"],
                },
            },
        })
        name_map[tool_name] = agent

    return tools, name_map


def _build_agent_tools(connections: List[Dict]) -> Tuple[List[Dict], Dict[str, Tuple[Dict, str]]]:
    """
    Build OpenAI tool schemas from registered MCP connections.
    Tool names are namespaced as {conn_safe}__{tool_safe} so the LLM
    knows which connection each tool belongs to.
    Returns (openai_tools, name_map) where name_map maps the namespaced
    tool name back to (connection_entry, original_tool_name).
    """
    tools: List[Dict] = []
    name_map: Dict[str, Tuple[Dict, str]] = {}

    for conn in connections:
        conn_safe = _safe_tool_name(conn["name"])
        conn_desc = conn.get("description", "")

        for schema in conn.get("tool_schemas", []):
            tool_safe = _safe_tool_name(schema["name"])
            namespaced = f"{conn_safe}__{tool_safe}"[:64]

            # Rich description: connection context + tool description so the
            # LLM understands *which system* this tool talks to and what it does.
            tool_desc = schema.get("description", "")
            full_desc = f"[{conn['name']} — {conn_desc}] {tool_desc}".strip(" —")

            tools.append({
                "type": "function",
                "function": {
                    "name": namespaced,
                    "description": full_desc,
                    "parameters": schema.get("inputSchema") or {"type": "object", "properties": {}},
                },
            })
            name_map[namespaced] = (conn, schema["name"])

    return tools, name_map


# ---------------------------------------------------------------------------
# Core: agentic tool-calling loop
# ---------------------------------------------------------------------------

async def _run_agent_loop(
    messages: List[Dict],
    trace_id: Optional[str] = None,
    run_id: Optional[str] = None,
) -> str:
    """
    Full tool-calling agent loop.

    messages — conversation turns WITHOUT the system prompt (list of
    {"role": "user"|"assistant", "content": "..."} dicts).

    Uses LLM function calling to decide which native data tools or registered
    external MCP tools to invoke, then synthesises a final answer.
    Falls back to plain Q&A completion when the configured LLM doesn't support
    tool calling (e.g. Ollama models).
    """
    from api.routes.agent import _build_system_prompt
    from api.routes.mcp_server import NATIVE_TOOL_SCHEMAS, NATIVE_TOOL_FNS
    from connections.mcp_client import _call_tool_async, _unwrap_exception
    from models.registry import get_llm

    connections = _load_mcp_connections()
    mcp_openai_tools, mcp_name_map = _build_agent_tools(connections)
    a2a_agents = _load_a2a_connections()
    a2a_openai_tools, a2a_name_map = _build_a2a_tools(a2a_agents)
    all_tools = NATIVE_TOOL_SCHEMAS + mcp_openai_tools + a2a_openai_tools

    full_messages: List[Dict] = [
        {"role": "system", "content": _build_system_prompt()}
    ] + list(messages)

    agent_model = settings.AGENT_MODEL
    try:
        llm = get_llm(agent_model)
        active_model = agent_model
    except Exception as exc:
        logger.warning("Agent: could not load %s (%s), falling back to DEFAULT_LLM", agent_model, exc)
        try:
            llm = get_llm(settings.DEFAULT_LLM)
            active_model = settings.DEFAULT_LLM
        except Exception as exc2:
            return f"Error: could not load any LLM — {exc2}"

    # If the provider doesn't support tool calling, fall back to plain Q&A
    if not hasattr(llm, "complete_with_tools") or not all_tools:
        try:
            response = llm.complete(messages=full_messages, temperature=0.2, max_tokens=2048)
        except Exception as exc:
            return f"Error: {exc}"
        _log_trace(trace_id, event_type="llm_tool_selection", direction="internal",
                   connection_type="agent",
                   summary=f"LLM call (no tools) — {active_model}",
                   details={"model": active_model, "tool_count": 0, "iteration": 0,
                            "prompt_tokens": response.prompt_tokens,
                            "completion_tokens": response.completion_tokens})
        return response.content

    for iteration in range(_MAX_TOOL_ITERATIONS):
        _log_trace(trace_id, event_type="llm_tool_selection", direction="internal",
                   connection_type="agent",
                   summary=f"LLM tool-selection call — {active_model} (iteration {iteration + 1})",
                   details={"model": active_model, "tool_count": len(all_tools), "iteration": iteration + 1})

        try:
            response = llm.complete_with_tools(
                messages=full_messages,
                tools=all_tools,
                temperature=0.2,
                max_tokens=2048,
            )
        except Exception as exc:
            logger.error("Agent: LLM call failed on iteration %d: %s", iteration, exc)
            return f"Error: {exc}"

        if not response.tool_calls:
            _log_trace(trace_id, event_type="llm_tool_selection", direction="internal",
                       connection_type="agent",
                       summary=f"LLM returned final answer (no more tools) — iteration {iteration + 1}",
                       details={"model": active_model, "iteration": iteration + 1, "tool_calls": 0,
                                "prompt_tokens": response.prompt_tokens,
                                "completion_tokens": response.completion_tokens})
            return response.content

        chosen_names = [tc["function"]["name"] for tc in response.tool_calls]
        _log_trace(trace_id, event_type="tool_chosen", direction="internal",
                   connection_type="agent",
                   summary=f"Tools chosen: {', '.join(chosen_names)}",
                   details={"model": active_model, "iteration": iteration + 1, "tools": chosen_names,
                            "prompt_tokens": response.prompt_tokens,
                            "completion_tokens": response.completion_tokens})

        # Append assistant turn with tool calls
        full_messages.append({
            "role": "assistant",
            "content": response.content or None,
            "tool_calls": response.tool_calls,
        })

        # Execute each tool call and collect results
        iteration_results: List[str] = []
        for tc in response.tool_calls:
            fn_name = tc["function"]["name"]
            fn_args = json.loads(tc["function"]["arguments"] or "{}")
            tool_call_id = tc["id"]

            try:
                if fn_name in NATIVE_TOOL_FNS:
                    _log_trace(trace_id, event_type="native_tool_call", direction="internal",
                               connection_type="agent",
                               summary=f"Native tool call: {fn_name}",
                               details={"tool": fn_name, "args": fn_args})
                    result = await NATIVE_TOOL_FNS[fn_name](**fn_args)
                    logger.info("Agent: native tool '%s' called", fn_name)
                elif fn_name in mcp_name_map:
                    conn, original_name = mcp_name_map[fn_name]
                    _log_trace(trace_id, event_type="mcp_tool_call", direction="outbound",
                               connection_type="mcp",
                               connection_name=conn["name"],
                               summary=f"MCP tool call → {conn['name']}: {original_name}",
                               details={"tool": original_name, "connection": conn["name"],
                                        "server_url": conn.get("server_url", ""), "args": fn_args})
                    result = await _call_tool_async(
                        conn["server_url"],
                        conn.get("transport", "sse"),
                        original_name,
                        fn_args,
                    )
                    result_preview = str(result)[:200]
                    _log_trace(trace_id, event_type="mcp_tool_response", direction="inbound",
                               connection_type="mcp",
                               connection_name=conn["name"],
                               summary=f"MCP tool response ← {conn['name']}: {original_name}",
                               details={"tool": original_name, "connection": conn["name"],
                                        "result_preview": result_preview})
                    logger.info("Agent: MCP tool '%s' on '%s' called", original_name, conn["name"])
                elif fn_name in a2a_name_map:
                    import asyncio
                    from connections.a2a_client import call_agent
                    agent_conn = a2a_name_map[fn_name]
                    query = fn_args.get("query", "")
                    _log_trace(trace_id, event_type="a2a_tool_call", direction="outbound",
                               connection_type="a2a",
                               connection_name=agent_conn["name"],
                               summary=f"A2A agent call → {agent_conn['name']}: {query[:80]}",
                               details={"agent": agent_conn["name"],
                                        "task_url": agent_conn.get("task_url", ""), "query": query})
                    result = await asyncio.to_thread(call_agent, agent_conn["task_url"], query)
                    result_preview = str(result)[:200]
                    _log_trace(trace_id, event_type="a2a_tool_response", direction="inbound",
                               connection_type="a2a",
                               connection_name=agent_conn["name"],
                               summary=f"A2A agent response ← {agent_conn['name']}",
                               details={"agent": agent_conn["name"], "result_preview": result_preview})
                    logger.info("Agent: A2A tool '%s' called", agent_conn["name"])
                else:
                    result = f"Unknown tool: {fn_name}"
            except BaseException as exc:
                result = f"Tool error: {_unwrap_exception(exc)}"
                logger.warning("Agent: tool '%s' failed: %s", fn_name, result)

            result_str = str(result)
            iteration_results.append(result_str)
            full_messages.append({
                "role": "tool",
                "tool_call_id": tool_call_id,
                "content": result_str,
            })

        # Record RunStep entries for each tool call in this iteration
        if run_id:
            try:
                from database import SessionLocal as _SL
                from models_db import RunStep as _RS
                _step_db = _SL()
                try:
                    for tc in response.tool_calls:
                        _fn = tc["function"]
                        _step_db.add(_RS(
                            id=str(uuid.uuid4()),
                            run_id=run_id,
                            domain="interoperability",
                            step_type="tool_call",
                            component=_fn.get("name", ""),
                            started_at=datetime.utcnow(),
                            ended_at=datetime.utcnow(),
                            status="completed",
                            metrics_json=json.dumps({
                                "prompt_tokens": response.prompt_tokens,
                                "completion_tokens": response.completion_tokens,
                            }),
                            input_summary=f"Tool: {_fn.get('name', '')}",
                        ))
                    _step_db.commit()
                finally:
                    _step_db.close()
            except Exception:
                pass

        # Skip synthesis LLM call — return raw tool results as plain text.
        # The caller (e.g. OutSystems) is expected to synthesize the answer itself.
        if not settings.A2A_SYNTHESIZE:
            _log_trace(trace_id, event_type="llm_tool_selection", direction="internal",
                       connection_type="agent",
                       summary="Synthesis skipped (A2A_SYNTHESIZE=false) — returning raw tool results",
                       details={"tool_count": len(iteration_results)})
            return "\n\n".join(iteration_results)

    return "I reached the maximum number of tool calls without a final answer."


async def _run_agent_async(
    user_text: str,
    trace_id: Optional[str] = None,
    run_id: Optional[str] = None,
) -> str:
    """Single-turn entry point — used by A2A endpoint and MCP server tool."""
    return await _run_agent_loop(
        [{"role": "user", "content": user_text}],
        trace_id=trace_id,
        run_id=run_id,
    )


# ---------------------------------------------------------------------------
# JSON-RPC method handlers
# ---------------------------------------------------------------------------

async def _handle_tasks_send(
    params: Dict,
    rpc_id: Any,
    trace_id: Optional[str] = None,
    run_id: Optional[str] = None,
) -> Dict:
    task_id = params.get("id") or str(uuid.uuid4())
    context_id = params.get("contextId") or task_id
    message = params.get("message", {})
    user_text = _text_from_message(message)

    if not user_text:
        return _jsonrpc_error(rpc_id, -32602, "No text content in message.")

    working_task = _make_task(task_id, "working", context_id=context_id)
    _tasks[task_id] = working_task

    answer = await _run_agent_async(user_text, trace_id=trace_id, run_id=run_id)

    completed_task = _make_task(task_id, "completed", answer, context_id=context_id)
    _tasks[task_id] = completed_task

    return _jsonrpc_result(rpc_id, completed_task)


async def _stream_tasks_send_subscribe(
    params: Dict,
    rpc_id: Any,
    trace_id: Optional[str] = None,
    run_id: Optional[str] = None,
):
    """
    SSE generator for tasks/sendSubscribe.

    Emits:
      1. TaskStatusUpdateEvent  — state: working
      2. TaskArtifactUpdateEvent — the answer text
      3. TaskStatusUpdateEvent  — state: completed (final=true)
    """
    task_id = params.get("id") or str(uuid.uuid4())
    context_id = params.get("contextId") or task_id
    message = params.get("message", {})
    user_text = _text_from_message(message)

    def _sse(data: Dict) -> str:
        return f"data: {json.dumps(data)}\n\n"

    if not user_text:
        err = _jsonrpc_error(rpc_id, -32602, "No text content in message.")
        yield _sse(err)
        return

    # 1. working status
    yield _sse(_jsonrpc_result(rpc_id, {
        "id": task_id,
        "contextId": context_id,
        "status": {"state": "working"},
        "final": False,
    }))
    await asyncio.sleep(0)

    _tasks[task_id] = _make_task(task_id, "working", context_id=context_id)

    answer = await _run_agent_async(user_text, trace_id=trace_id, run_id=run_id)

    artifact_id = str(uuid.uuid4())

    # 2. Artifact event
    yield _sse(_jsonrpc_result(rpc_id, {
        "id": task_id,
        "contextId": context_id,
        "artifact": {
            "artifactId": artifact_id,
            "parts": [{"type": "text", "text": answer}],
            "index": 0,
            "lastChunk": True,
        },
        "final": False,
    }))
    await asyncio.sleep(0)

    # 3. completed status (final)
    completed_task = _make_task(task_id, "completed", answer, context_id=context_id)
    _tasks[task_id] = completed_task

    yield _sse(_jsonrpc_result(rpc_id, {
        "id": task_id,
        "contextId": context_id,
        "status": {"state": "completed"},
        "final": True,
    }))


def _handle_tasks_get(params: Dict, rpc_id: Any) -> Dict:
    task_id = params.get("id", "")
    task = _tasks.get(task_id)
    if task is None:
        return _jsonrpc_error(rpc_id, -32001, f"Task '{task_id}' not found.")
    return _jsonrpc_result(rpc_id, task)


def _handle_tasks_cancel(params: Dict, rpc_id: Any) -> Dict:
    task_id = params.get("id", "")
    task = _tasks.get(task_id)
    if task is None:
        return _jsonrpc_error(rpc_id, -32001, f"Task '{task_id}' not found.")
    # If already completed, cancellation is a no-op
    if task.get("status", {}).get("state") == "completed":
        return _jsonrpc_result(rpc_id, task)
    cancelled_task = _make_task(task_id, "canceled")
    _tasks[task_id] = cancelled_task
    return _jsonrpc_result(rpc_id, cancelled_task)


# ---------------------------------------------------------------------------
# POST /a2a — JSON-RPC 2.0 dispatcher
# ---------------------------------------------------------------------------

@router.post("/a2a")
async def a2a_endpoint(request: Request):
    """A2A JSON-RPC 2.0 task endpoint."""
    try:
        body = await request.json()
    except Exception:
        return JSONResponse(
            status_code=400,
            content=_jsonrpc_error(None, -32700, "Parse error: invalid JSON."),
        )

    rpc_id = body.get("id")
    method = body.get("method", "")
    params = body.get("params", {})

    logger.info("A2A request: method=%s task_id=%s", method, params.get("id", "-"))

    # One trace_id groups all log entries for this request
    trace_id = str(uuid.uuid4())

    # Create a UnifiedRun to track this inbound A2A request
    _ur_id: Optional[str] = None
    _ur = None
    try:
        from database import SessionLocal as _SL
        from models_db import UnifiedRun as _UR
        _ur_db = _SL()
        try:
            _ur_id = str(uuid.uuid4())
            _ur = _UR(
                id=_ur_id,
                primary_domain="interoperability",
                run_type="connection_test",
                initiated_by="api",
                status="running",
                started_at=datetime.utcnow(),
                summary_json=json.dumps({"type": "a2a_inbound", "method": method}),
            )
            _ur_db.add(_ur)
            _ur_db.commit()
            _ur_db.refresh(_ur)
        finally:
            _ur_db.close()
    except Exception:
        _ur_id = None
        _ur = None

    # Log inbound call
    caller_ip = request.client.host if request.client else "unknown"
    # Extract a short query preview for display
    _query_preview = ""
    if method in ("tasks/send", "message/send"):
        _msg = params.get("message") or (params.get("messages") or [{}])[-1]
        if isinstance(_msg, dict):
            _parts = _msg.get("parts", [])
            _text = " ".join(p.get("text", "") for p in _parts if isinstance(p, dict))
            _query_preview = _text[:120]
    _log_trace(trace_id,
               event_type="inbound_call",
               direction="inbound",
               connection_type="a2a",
               caller=caller_ip,
               run_id=_ur_id,
               summary=f"Inbound A2A call [{method}] from {caller_ip}" + (f": {_query_preview}" if _query_preview else ""),
               details={"method": method, "caller_ip": caller_ip, "query_preview": _query_preview, "trace_id": trace_id})

    def _log_outbound(summary: str, details: dict):
        _log_trace(trace_id,
                   event_type="outbound_response",
                   direction="outbound",
                   connection_type="a2a",
                   caller=caller_ip,
                   run_id=_ur_id,
                   summary=summary,
                   details={**details, "trace_id": trace_id})

    def _finalize_run(status: str = "completed") -> None:
        if _ur_id:
            try:
                from database import SessionLocal as _SL2
                from models_db import UnifiedRun as _UR2
                _fin_db = _SL2()
                try:
                    _fin_row = _fin_db.query(_UR2).filter(_UR2.id == _ur_id).first()
                    if _fin_row:
                        _fin_row.status = status
                        _fin_row.ended_at = datetime.utcnow()
                        _fin_db.commit()
                finally:
                    _fin_db.close()
            except Exception:
                pass

    if method in ("tasks/send", "message/send"):
        result = await _handle_tasks_send(params, rpc_id, trace_id=trace_id, run_id=_ur_id)
        state = result.get("result", {}).get("status", {}).get("state", "")
        answer_preview = ""
        for artifact in result.get("result", {}).get("artifacts", []):
            for part in artifact.get("parts", []):
                if part.get("type") == "text":
                    answer_preview = part.get("text", "")[:120]
                    break
        _log_outbound(
            f"Outbound A2A response [{method}] to {caller_ip}: {state}" + (f" — {answer_preview}" if answer_preview else ""),
            {"method": method, "state": state, "answer_preview": answer_preview},
        )
        _finalize_run("completed")
        return JSONResponse(content=result)

    elif method in ("tasks/sendSubscribe", "message/sendSubscribe", "message/stream"):
        _log_outbound(
            f"Outbound A2A stream [{method}] to {caller_ip}",
            {"method": method, "streaming": True},
        )
        _finalize_run("completed")
        return StreamingResponse(
            _stream_tasks_send_subscribe(params, rpc_id, trace_id=trace_id, run_id=_ur_id),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "X-Accel-Buffering": "no",
            },
        )

    elif method in ("tasks/get", "message/get"):
        result = _handle_tasks_get(params, rpc_id)
        _log_outbound(
            f"Outbound A2A response [tasks/get] to {caller_ip}",
            {"method": method},
        )
        _finalize_run("completed")
        return JSONResponse(content=result)

    elif method in ("tasks/cancel", "message/cancel"):
        result = _handle_tasks_cancel(params, rpc_id)
        _log_outbound(
            f"Outbound A2A response [tasks/cancel] to {caller_ip}",
            {"method": method},
        )
        _finalize_run("completed")
        return JSONResponse(content=result)

    else:
        logger.warning("A2A: unknown method '%s'", method)
        _finalize_run("failed")
        return JSONResponse(
            content=_jsonrpc_error(rpc_id, -32601, f"Method '{method}' not found."),
        )
