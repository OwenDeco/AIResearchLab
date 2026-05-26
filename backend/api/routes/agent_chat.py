"""
External agent chat API.

Allows external systems (e.g. OutSystems) to discover available lab agents
and send a message to a specific agent by ID or name.

All heavy lifting (LLM loop, RAG, tools, run tracking) is delegated to the
existing chat_with_agent function in agent_configs.
"""
from __future__ import annotations

import logging
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from api.deps import get_db
from api.routes.agent_configs import (
    AgentChatMessage,
    AgentConfigChatRequest,
    _load_configs,
    chat_with_agent,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/agent-chat", tags=["Agent Chat"])


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

class AgentListItem(BaseModel):
    id:   str = Field(..., description="Agent config UUID.")
    name: str = Field(..., description="Display name of the agent.")
    role: str = Field(..., description="Short role / description of the agent.")


class AgentAskRequest(BaseModel):
    agent_id: Optional[str] = Field(
        None,
        description=(
            "Agent config UUID. Use this **or** `agent_name` to identify the target. "
            "Obtain valid IDs from `GET /api/agent-chat/agents`."
        ),
        example="3fa85f64-5717-4562-b3fc-2c963f66afa6",
    )
    agent_name: Optional[str] = Field(
        None,
        description="Agent display name (case-insensitive). Alternative to `agent_id`.",
        example="Critic",
    )
    message: str = Field(
        ...,
        min_length=1,
        description="The message or question to send to the agent.",
        example="What are the main risks of AI replacing jobs?",
    )
    history: List[AgentChatMessage] = Field(
        default_factory=list,
        description=(
            "Optional prior conversation turns for multi-turn context. "
            "Each entry must have `role` ('user' or 'assistant') and `content`."
        ),
    )


class AgentAskResponse(BaseModel):
    answer:     str   = Field(..., description="The agent's response text.")
    agent_id:   str   = Field(..., description="Config UUID of the responding agent.")
    agent_name: str   = Field(..., description="Display name of the responding agent.")
    latency_ms: float = Field(..., description="End-to-end latency in milliseconds.")
    run_id:     str   = Field(..., description="Run ID — use for observability / tracing.")


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get(
    "/agents",
    response_model=List[AgentListItem],
    summary="List available agents",
    description=(
        "Returns all configured lab agents with their IDs, names, and roles. "
        "Use the returned `id` or `name` when calling `POST /api/agent-chat/ask`."
    ),
)
def list_agents(db: Session = Depends(get_db)):
    return [
        AgentListItem(id=c["id"], name=c.get("name", ""), role=c.get("role", ""))
        for c in _load_configs(db)
    ]


@router.post(
    "/ask",
    response_model=AgentAskResponse,
    summary="Send a message to a specific agent",
    description=(
        "Sends `message` to a lab agent and returns the agent's answer. "
        "The agent is identified by `agent_id` (UUID) **or** `agent_name` "
        "(case-insensitive) — at least one is required. "
        "Optionally include `history` for multi-turn conversations.\n\n"
        "The agent runs its full LLM loop including any configured RAG retrieval "
        "and tool calls, and the interaction is tracked as a run in the lab.\n\n"
        "**Quick start:**\n"
        "1. Call `GET /api/agent-chat/agents` to see available agents and their names.\n"
        "2. Call this endpoint with `agent_name: \"Critic\"` and your `message`."
    ),
    responses={
        200: {"description": "Agent response returned successfully."},
        404: {"description": "No agent matched the given id or name."},
        422: {"description": "Neither agent_id nor agent_name was supplied, or message is empty."},
    },
)
async def ask_agent(
    body: AgentAskRequest,
    request: Request,
    db: Session = Depends(get_db),
):
    if not body.agent_id and not body.agent_name:
        raise HTTPException(
            status_code=422,
            detail="Provide at least one of: agent_id, agent_name.",
        )

    configs = _load_configs(db)

    if body.agent_id:
        cfg = next((c for c in configs if c["id"] == body.agent_id), None)
        if cfg is None:
            raise HTTPException(
                status_code=404,
                detail=f"No agent with id '{body.agent_id}'.",
            )
    else:
        needle = (body.agent_name or "").strip().lower()
        cfg = next((c for c in configs if c.get("name", "").lower() == needle), None)
        if cfg is None:
            available = [c.get("name", "") for c in configs]
            raise HTTPException(
                status_code=404,
                detail=f"No agent named '{body.agent_name}'. Available: {available}",
            )

    chat_req = AgentConfigChatRequest(message=body.message, history=body.history)
    result = await chat_with_agent(cfg["id"], chat_req, request, db)

    return AgentAskResponse(
        answer=result["answer"],
        agent_id=cfg["id"],
        agent_name=cfg.get("name", ""),
        latency_ms=result["latency_ms"],
        run_id=result["run_id"],
    )
