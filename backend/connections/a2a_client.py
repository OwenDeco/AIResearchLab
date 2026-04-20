"""A2A client — fetch agent cards and call external A2A agents."""
from __future__ import annotations

import logging
import uuid
from typing import Any, Dict

import httpx

logger = logging.getLogger(__name__)

_TIMEOUT = 15.0


def _human_error(exc: Exception) -> str:
    """Convert an httpx exception into a readable message."""
    if isinstance(exc, httpx.ConnectTimeout):
        return "Connection timed out — the host did not respond in time."
    if isinstance(exc, httpx.ReadTimeout):
        return "Read timed out — the host accepted the connection but stopped responding."
    if isinstance(exc, httpx.ConnectError):
        return f"Could not connect — host unreachable or refused the connection. ({exc})"
    if isinstance(exc, httpx.HTTPStatusError):
        return f"HTTP {exc.response.status_code} from server."
    if isinstance(exc, httpx.InvalidURL):
        return f"Invalid URL: {exc}"
    return str(exc)


def fetch_agent_card(agent_card_url: str) -> Dict[str, Any]:
    """Fetch and return the agent card JSON from the given URL."""
    try:
        r = httpx.get(agent_card_url, timeout=_TIMEOUT, follow_redirects=True)
        r.raise_for_status()
        return r.json()
    except httpx.HTTPError as exc:
        raise RuntimeError(_human_error(exc)) from exc


def call_agent(task_url: str, query: str, timeout: float = 60.0) -> str:
    """
    Send a tasks/send (+ message/send) request to an external A2A agent.
    Returns the answer text from the first text artifact part.
    """
    task_id = str(uuid.uuid4())
    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tasks/send",
        "params": {
            "id": task_id,
            "message": {
                "role": "user",
                "parts": [{"type": "text", "text": query}],
            },
        },
    }

    try:
        r = httpx.post(task_url, json=payload, timeout=timeout)
        r.raise_for_status()
    except httpx.HTTPError as exc:
        raise RuntimeError(_human_error(exc)) from exc
    data = r.json()

    if "error" in data:
        raise RuntimeError(f"A2A error: {data['error']}")

    result = data.get("result", {})

    # Extract text from artifacts
    for artifact in result.get("artifacts", []):
        for part in artifact.get("parts", []):
            if part.get("type") == "text" and part.get("text"):
                return part["text"]

    # Fallback: try message parts (some implementations return a message instead)
    msg = result.get("message", {})
    for part in msg.get("parts", []):
        if part.get("type") == "text" and part.get("text"):
            return part["text"]

    return "(No text response from agent)"


def test_agent(task_url: str) -> tuple[bool, str]:
    """Send a lightweight ping task. Returns (ok, message)."""
    try:
        answer = call_agent(task_url, "ping", timeout=10.0)
        return True, "Agent responded successfully."
    except Exception as exc:
        msg = str(exc) if str(exc) else type(exc).__name__
        logger.debug("A2A test failed for %s: %s", task_url, msg)
        return False, msg
