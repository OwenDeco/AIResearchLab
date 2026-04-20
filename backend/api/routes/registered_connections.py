"""
CRUD endpoints for user-registered external connections (A2A agents and MCP servers).
Persisted to AppState (SQLite key-value store).
"""
from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from api.deps import get_db
from api.conn_log import log_conn_event

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/connections/registered", tags=["connections"])

_A2A_KEY = "registered_a2a_connections"
_MCP_KEY = "registered_mcp_connections"


# ---------------------------------------------------------------------------
# AppState helpers
# ---------------------------------------------------------------------------

def _load_list(db: Session, key: str) -> List[Dict]:
    from models_db import AppState
    row = db.query(AppState).filter(AppState.key == key).first()
    if row is None:
        return []
    try:
        return json.loads(row.value) or []
    except Exception:
        return []


def _save_list(db: Session, key: str, data: List[Dict]) -> None:
    from models_db import AppState
    value = json.dumps(data)
    row = db.query(AppState).filter(AppState.key == key).first()
    if row is None:
        db.add(AppState(key=key, value=value))
    else:
        row.value = value
        row.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
    db.commit()


def _now() -> str:
    return datetime.now(timezone.utc).replace(tzinfo=None).isoformat()


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

def _validate_external_url(url: str, field: str) -> None:
    """Reject URLs that don't start with http/https."""
    if not url.startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail=f"{field} must start with http:// or https://")


class RegisterA2ARequest(BaseModel):
    name: str
    agent_card_url: str


class RegisterMCPRequest(BaseModel):
    name: str
    server_url: str
    description: str = ""
    transport: str = "sse"  # "sse" or "streamable_http"


class TestResult(BaseModel):
    id: str
    status: str          # "ok" or "error"
    message: str


class ToolCallRequest(BaseModel):
    tool_name: str
    arguments: Dict[str, Any] = {}


class AgentToolToggleRequest(BaseModel):
    enabled: bool


# ---------------------------------------------------------------------------
# GET /api/connections/registered
# ---------------------------------------------------------------------------

@router.get("")
def list_registered(db: Session = Depends(get_db)):
    """List all registered A2A and MCP connections."""
    return {
        "a2a": _load_list(db, _A2A_KEY),
        "mcp": _load_list(db, _MCP_KEY),
    }


# ---------------------------------------------------------------------------
# POST /api/connections/registered/a2a
# ---------------------------------------------------------------------------

@router.post("/a2a", status_code=201)
def register_a2a(body: RegisterA2ARequest, db: Session = Depends(get_db)):
    """
    Register an external A2A agent.
    Fetches the agent card to extract task_url, description, and skills.
    """
    _validate_external_url(body.agent_card_url, "agent_card_url")
    from connections.a2a_client import fetch_agent_card

    try:
        card = fetch_agent_card(body.agent_card_url)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Could not fetch agent card: {exc}")

    task_url = card.get("url", "")
    if not task_url:
        raise HTTPException(status_code=400, detail="Agent card does not contain a 'url' field.")

    skills = [s.get("id", s.get("name", "")) for s in card.get("skills", [])]
    description = card.get("description", "")

    entry: Dict[str, Any] = {
        "id": str(uuid.uuid4()),
        "name": body.name,
        "agent_card_url": body.agent_card_url,
        "task_url": task_url,
        "description": description,
        "skills": skills,
        "agent_tool_enabled": True,
        "created_at": _now(),
    }

    connections = _load_list(db, _A2A_KEY)
    connections.append(entry)
    _save_list(db, _A2A_KEY, connections)

    log_conn_event(
        db,
        event_type="registered",
        direction="system",
        connection_type="a2a",
        connection_name=body.name,
        connection_id=entry["id"],
        summary=f"A2A agent '{body.name}' registered ({task_url})",
        details={"agent_card_url": body.agent_card_url, "skills": skills},
    )

    logger.info("Registered A2A connection '%s' → %s", body.name, task_url)
    return entry


# ---------------------------------------------------------------------------
# POST /api/connections/registered/mcp
# ---------------------------------------------------------------------------

@router.post("/mcp", status_code=201)
async def register_mcp(body: RegisterMCPRequest, db: Session = Depends(get_db)):
    """
    Register an external MCP server.
    Connects to the server to discover available tools.
    """
    _validate_external_url(body.server_url, "server_url")
    from connections.mcp_client import _discover_tools_async, _unwrap_exception

    transport = body.transport if body.transport in ("sse", "streamable_http") else "sse"
    try:
        tool_schemas = await _discover_tools_async(body.server_url, transport)
        tool_names = [t["name"] for t in tool_schemas]
    except BaseException as exc:
        real = _unwrap_exception(exc)
        raise HTTPException(
            status_code=400,
            detail=f"Could not connect to MCP server or discover tools: {real}",
        )

    entry: Dict[str, Any] = {
        "id": str(uuid.uuid4()),
        "name": body.name,
        "server_url": body.server_url,
        "transport": transport,
        "description": body.description or f"MCP server at {body.server_url}",
        "tools": tool_names,           # names only — used for display tags
        "tool_schemas": tool_schemas,  # full schemas — used for test panel and agent
        "agent_tool_enabled": True,    # exposed as agent tool by default
        "created_at": _now(),
    }

    connections = _load_list(db, _MCP_KEY)
    connections.append(entry)
    _save_list(db, _MCP_KEY, connections)

    log_conn_event(
        db,
        event_type="registered",
        direction="system",
        connection_type="mcp",
        connection_name=body.name,
        connection_id=entry["id"],
        summary=f"MCP server '{body.name}' registered ({len(tool_names)} tools)",
        details={"server_url": body.server_url, "tools": tool_names},
    )

    logger.info("Registered MCP connection '%s' → %s (%d tools)", body.name, body.server_url, len(tool_names))
    return entry


# ---------------------------------------------------------------------------
# DELETE /api/connections/registered/{id}
# ---------------------------------------------------------------------------

@router.delete("/{conn_id}", status_code=204)
def delete_registered(conn_id: str, db: Session = Depends(get_db)):
    """Delete a registered connection by ID (searches both A2A and MCP lists)."""
    for key, conn_type in ((_A2A_KEY, "a2a"), (_MCP_KEY, "mcp")):
        connections = _load_list(db, key)
        match = next((c for c in connections if c["id"] == conn_id), None)
        if match:
            filtered = [c for c in connections if c["id"] != conn_id]
            _save_list(db, key, filtered)
            log_conn_event(
                db,
                event_type="deleted",
                direction="system",
                connection_type=conn_type,
                connection_name=match.get("name"),
                connection_id=conn_id,
                summary=f"{conn_type.upper()} connection '{match.get('name')}' deleted",
            )
            return None
    raise HTTPException(status_code=404, detail="Connection not found.")


# ---------------------------------------------------------------------------
# POST /api/connections/registered/{id}/test
# ---------------------------------------------------------------------------

@router.post("/{conn_id}/test", response_model=TestResult)
async def test_registered(conn_id: str, db: Session = Depends(get_db)):
    """Test a registered connection — ping A2A agent or connect to MCP server."""
    # Search A2A
    for conn in _load_list(db, _A2A_KEY):
        if conn["id"] == conn_id:
            from connections.a2a_client import test_agent
            ok, msg = test_agent(conn["task_url"])
            status = "ok" if ok else "error"
            log_conn_event(
                db,
                event_type="tested",
                direction="outbound",
                connection_type="a2a",
                connection_name=conn.get("name"),
                connection_id=conn_id,
                summary=f"Tested A2A '{conn.get('name')}' — {status}",
                details={"result": status, "message": msg},
            )
            return TestResult(id=conn_id, status=status, message=msg)

    # Search MCP
    for conn in _load_list(db, _MCP_KEY):
        if conn["id"] == conn_id:
            from connections.mcp_client import _discover_tools_async, _unwrap_exception
            transport = conn.get("transport", "sse")
            try:
                await _discover_tools_async(conn["server_url"], transport)
                status, msg = "ok", "MCP server reachable."
            except BaseException as exc:
                real = _unwrap_exception(exc)
                status, msg = "error", f"Could not connect: {real}"
            log_conn_event(
                db,
                event_type="tested",
                direction="outbound",
                connection_type="mcp",
                connection_name=conn.get("name"),
                connection_id=conn_id,
                summary=f"Tested MCP '{conn.get('name')}' — {status}",
                details={"result": status, "message": msg},
            )
            return TestResult(id=conn_id, status=status, message=msg)

    raise HTTPException(status_code=404, detail="Connection not found.")


# ---------------------------------------------------------------------------
# POST /api/connections/registered/{id}/call
# ---------------------------------------------------------------------------

@router.post("/{conn_id}/call")
async def call_registered_tool(conn_id: str, body: ToolCallRequest, db: Session = Depends(get_db)):
    """Call a specific tool on a registered MCP server and return its raw output."""
    for conn in _load_list(db, _MCP_KEY):
        if conn["id"] == conn_id:
            from connections.mcp_client import _call_tool_async, _unwrap_exception
            transport = conn.get("transport", "sse")
            try:
                result = await _call_tool_async(
                    conn["server_url"], transport, body.tool_name, body.arguments
                )
            except BaseException as exc:
                real = _unwrap_exception(exc)
                raise HTTPException(status_code=400, detail=str(real))

            log_conn_event(
                db,
                event_type="tool_call",
                direction="outbound",
                connection_type="mcp",
                connection_name=conn.get("name"),
                connection_id=conn_id,
                summary=f"Called tool '{body.tool_name}' on MCP '{conn.get('name')}'",
                details={"tool": body.tool_name, "arguments": body.arguments},
            )
            return {"result": result}

    raise HTTPException(status_code=404, detail="MCP connection not found.")


# ---------------------------------------------------------------------------
# PATCH /api/connections/registered/{id}/agent-tool
# ---------------------------------------------------------------------------

@router.patch("/{conn_id}/agent-tool", status_code=204)
def set_agent_tool_enabled(conn_id: str, body: AgentToolToggleRequest, db: Session = Depends(get_db)):
    """Enable or disable a registered connection (A2A or MCP) as an agent tool."""
    for key in (_A2A_KEY, _MCP_KEY):
        connections = _load_list(db, key)
        match = next((c for c in connections if c["id"] == conn_id), None)
        if match:
            match["agent_tool_enabled"] = body.enabled
            _save_list(db, key, connections)
            logger.info("%s '%s' agent_tool_enabled=%s", key, match.get("name"), body.enabled)
            return None
    raise HTTPException(status_code=404, detail="Connection not found.")
