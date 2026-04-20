from __future__ import annotations

import json
import logging
from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from api.deps import get_db

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/logs", tags=["logs"])


@router.get("/connections")
def get_connection_logs(
    limit: int = Query(200, le=1000),
    direction: Optional[str] = Query(None, description="Filter: inbound | outbound | internal | system"),
    event_type: Optional[str] = Query(None, description="Filter by event_type"),
    trace_id: Optional[str] = Query(None, description="Filter to a single A2A trace"),
    db: Session = Depends(get_db),
):
    """Return recent connection log entries, newest first."""
    from models_db import ConnectionLog
    q = db.query(ConnectionLog).order_by(ConnectionLog.timestamp.desc())
    if direction:
        q = q.filter(ConnectionLog.direction == direction)
    if event_type:
        q = q.filter(ConnectionLog.event_type == event_type)
    if trace_id:
        q = q.filter(ConnectionLog.trace_id == trace_id)
    rows = q.limit(limit).all()
    return [
        {
            "id": r.id,
            "timestamp": r.timestamp.isoformat(),
            "trace_id": r.trace_id,
            "event_type": r.event_type,
            "direction": r.direction,
            "connection_type": r.connection_type,
            "connection_name": r.connection_name,
            "connection_id": r.connection_id,
            "caller": r.caller,
            "summary": r.summary,
            "details": json.loads(r.details_json) if r.details_json else None,
        }
        for r in rows
    ]


@router.delete("/connections", status_code=204)
def clear_connection_logs(db: Session = Depends(get_db)):
    """Delete all connection log entries."""
    from models_db import ConnectionLog
    db.query(ConnectionLog).delete()
    db.commit()
