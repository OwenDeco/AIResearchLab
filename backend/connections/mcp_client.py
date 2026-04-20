"""
MCP client — connect to SSE-based MCP servers, discover tools,
and run an agentic tool-call loop using the OpenAI API.
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Dict, List

logger = logging.getLogger(__name__)

_MAX_TOOL_ITERATIONS = 10


# ---------------------------------------------------------------------------
# Async internals
# ---------------------------------------------------------------------------

def _transport_context(server_url: str, transport: str):
    """Return the appropriate MCP transport context manager."""
    if transport == "streamable_http":
        from mcp.client.streamable_http import streamablehttp_client
        return streamablehttp_client(server_url)
    from mcp.client.sse import sse_client
    return sse_client(server_url)


async def _discover_tools_async(server_url: str, transport: str = "sse") -> List[Dict[str, Any]]:
    """Connect to an MCP server and return its tool list."""
    from mcp import ClientSession

    async with _transport_context(server_url, transport) as (read, write, *_):
        async with ClientSession(read, write) as session:
            await session.initialize()
            result = await session.list_tools()
            return [
                {
                    "name": t.name,
                    "description": t.description or "",
                    "inputSchema": t.inputSchema or {},
                }
                for t in result.tools
            ]


async def _call_tool_async(
    server_url: str,
    transport: str,
    tool_name: str,
    arguments: Dict[str, Any],
) -> str:
    """Connect to an MCP server and call a single tool, returning its output."""
    from mcp import ClientSession

    async with _transport_context(server_url, transport) as (read, write, *_):
        async with ClientSession(read, write) as session:
            await session.initialize()
            result = await session.call_tool(tool_name, arguments=arguments)
            return _extract_tool_content(result)


async def _run_with_tools_async(
    server_url: str,
    query: str,
    model_name: str,
    transport: str = "sse",
) -> str:
    """
    Connect to an MCP server and run a query using an agentic tool-call loop.
    Uses the OpenAI API directly for tool-calling support.
    """
    from mcp import ClientSession
    from config import settings

    # Parse provider and model id from "openai/gpt-4o" style keys
    provider, _, model_id = model_name.partition("/")

    async with _transport_context(server_url, transport) as (read, write, *_):
        async with ClientSession(read, write) as session:
            await session.initialize()
            tools_result = await session.list_tools()

            if not tools_result.tools:
                # No tools — just call LLM normally without MCP
                return await _llm_no_tools(query, model_name, settings)

            # Convert MCP tools → OpenAI tool schema
            openai_tools = [
                {
                    "type": "function",
                    "function": {
                        "name": t.name,
                        "description": t.description or t.name,
                        "parameters": t.inputSchema or {"type": "object", "properties": {}},
                    },
                }
                for t in tools_result.tools
            ]

            # Build OpenAI client based on provider
            client = _build_openai_client(provider, model_id, settings)
            if client is None:
                return f"Tool calling is not supported for provider '{provider}'. Use openai or azure."

            messages = [{"role": "user", "content": query}]

            for _ in range(_MAX_TOOL_ITERATIONS):
                response = client.chat.completions.create(
                    model=model_id,
                    messages=messages,
                    tools=openai_tools,
                    temperature=0.0,
                    max_completion_tokens=2048,
                )
                choice = response.choices[0]
                msg = choice.message

                if not msg.tool_calls:
                    return msg.content or ""

                # Append assistant message with tool calls
                messages.append(msg.model_dump(exclude_unset=False))

                # Execute each tool call via MCP
                for tc in msg.tool_calls:
                    try:
                        args = json.loads(tc.function.arguments or "{}")
                        tool_result = await session.call_tool(tc.function.name, arguments=args)
                        content = _extract_tool_content(tool_result)
                    except Exception as exc:
                        content = f"Tool call failed: {exc}"
                        logger.warning("MCP tool call '%s' failed: %s", tc.function.name, exc)

                    messages.append({
                        "role": "tool",
                        "tool_call_id": tc.id,
                        "content": content,
                    })

            return "Reached maximum tool call iterations without a final answer."


def _build_openai_client(provider: str, model_id: str, settings):
    """Return an OpenAI sync client for the given provider, or None if unsupported."""
    try:
        if provider == "openai":
            from openai import OpenAI
            return OpenAI(api_key=settings.OPENAI_API_KEY or None, max_retries=0)
        elif provider == "azure":
            from openai import AzureOpenAI
            return AzureOpenAI(
                api_key=settings.AZURE_OPENAI_API_KEY,
                azure_endpoint=settings.AZURE_OPENAI_ENDPOINT,
                api_version="2024-02-01",
                max_retries=0,
            )
        else:
            return None
    except Exception as exc:
        logger.error("Could not build OpenAI client: %s", exc)
        return None


async def _llm_no_tools(query: str, model_name: str, settings) -> str:
    """Fallback: call LLM without tools when MCP server has no tools."""
    from models.registry import get_llm
    try:
        llm = get_llm(model_name)
        resp = llm.complete(messages=[{"role": "user", "content": query}], temperature=0.0)
        return resp.content
    except Exception as exc:
        return f"LLM call failed: {exc}"


def _extract_tool_content(tool_result) -> str:
    """Extract a string from an MCP tool call result."""
    if hasattr(tool_result, "content"):
        parts = tool_result.content
        if isinstance(parts, list):
            texts = []
            for p in parts:
                if hasattr(p, "text"):
                    texts.append(p.text)
                elif isinstance(p, dict) and "text" in p:
                    texts.append(p["text"])
                else:
                    texts.append(str(p))
            return "\n".join(texts)
        return str(parts)
    return str(tool_result)


# ---------------------------------------------------------------------------
# Exception helpers
# ---------------------------------------------------------------------------

def _unwrap_exception(exc: BaseException) -> BaseException:
    """
    If *exc* is an ExceptionGroup / BaseExceptionGroup (produced by asyncio
    TaskGroup when a sub-task raises), extract the first inner exception so
    callers see a meaningful message rather than "unhandled errors in a
    TaskGroup (1 sub-exception)".
    """
    if isinstance(exc, BaseExceptionGroup):
        inner = exc.exceptions[0] if exc.exceptions else exc
        return _unwrap_exception(inner)
    return exc


# ---------------------------------------------------------------------------
# Sync wrappers (called from synchronous FastAPI endpoints)
# ---------------------------------------------------------------------------

def discover_tools(server_url: str, transport: str = "sse") -> List[Dict[str, Any]]:
    """Synchronously discover tools from an MCP server."""
    try:
        return asyncio.run(_discover_tools_async(server_url, transport))
    except BaseException as exc:
        real = _unwrap_exception(exc)
        logger.error("MCP discover_tools failed for %s: %s", server_url, real)
        raise real from None


def run_with_tools(server_url: str, query: str, model_name: str, transport: str = "sse") -> str:
    """Synchronously run a query against an MCP server with tool calling."""
    try:
        return asyncio.run(_run_with_tools_async(server_url, query, model_name, transport))
    except BaseException as exc:
        real = _unwrap_exception(exc)
        logger.error("MCP run_with_tools failed for %s: %s", server_url, real)
        raise real from None


def test_server(server_url: str, transport: str = "sse") -> bool:
    """Verify the MCP server is reachable and returns tools."""
    try:
        discover_tools(server_url, transport)
        return True
    except Exception as exc:
        logger.debug("MCP test failed for %s: %s", server_url, exc)
        return False
