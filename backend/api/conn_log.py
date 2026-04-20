"""Shared helper for writing ConnectionLog entries."""
from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime
from typing import Any, Dict, Optional

from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

_CATEGORY_MAP = {
    "llm_tool_selection": "ai",
    "tool_chosen": "ai",
    "llm_called": "ai",
    "inbound_call": "connection",
    "outbound_call": "connection",
    "mcp_tool_call": "connection",
    "mcp_tool_response": "connection",
    "a2a_tool_call": "connection",
    "native_tool_call": "connection",
    "registered": "governance",
    "deleted": "governance",
    "tested": "connection",
    "ngrok_start": "connection",
    "ngrok_stop": "connection",
}

_EVTYPE_MAP = {
    "llm_tool_selection": "llm_called",
    "tool_chosen": "a2a_sent",
    "inbound_call": "a2a_received",
    "outbound_call": "a2a_sent",
    "mcp_tool_call": "mcp_called",
    "mcp_tool_response": "a2a_received",
    "native_tool_call": "a2a_sent",
}


def log_conn_event(
    db: Session,
    *,
    event_type: str,
    direction: str,
    summary: str,
    trace_id: Optional[str] = None,
    connection_type: Optional[str] = None,
    connection_name: Optional[str] = None,
    connection_id: Optional[str] = None,
    caller: Optional[str] = None,
    details: Optional[Dict[str, Any]] = None,
    run_id: Optional[str] = None,
) -> None:
    """Insert a ConnectionLog row and commit. Silently swallows errors."""
    from models_db import ConnectionLog
    try:
        details_json = json.dumps(details) if details else None
        entry = ConnectionLog(
            id=str(uuid.uuid4()),
            timestamp=datetime.utcnow(),
            trace_id=trace_id,
            event_type=event_type,
            direction=direction,
            summary=summary,
            connection_type=connection_type,
            connection_name=connection_name,
            connection_id=connection_id,
            caller=caller,
            details_json=details_json,
        )
        if run_id:
            entry.run_id = run_id
        db.add(entry)
        db.commit()
    except Exception as exc:
        logger.warning("Failed to write connection log: %s", exc)
        db.rollback()
        return

    if run_id:
        try:
            from models_db import RunEvent as _RE
            _cat = _CATEGORY_MAP.get(event_type, "connection")
            _etype = _EVTYPE_MAP.get(event_type, event_type)
            db.add(_RE(
                id=str(uuid.uuid4()),
                run_id=run_id,
                event_type=_etype,
                category=_cat,
                severity="error" if "error" in (summary or "").lower() else "info",
                timestamp=datetime.utcnow(),
                summary=summary,
                source=connection_type,
                payload_json=details_json,
            ))
            db.commit()
        except Exception:
            pass
