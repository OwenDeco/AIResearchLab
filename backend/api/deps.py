from __future__ import annotations

import threading
from typing import Generator

from fastapi import Depends, Request
from sqlalchemy.orm import Session

from database import SessionLocal

_bm25_lock = threading.Lock()


# ---------------------------------------------------------------------------
# Database dependency
# ---------------------------------------------------------------------------

def get_db() -> Generator[Session, None, None]:
    """Yield a SQLAlchemy session, rolling back on unhandled exceptions."""
    db: Session = SessionLocal()
    try:
        yield db
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Singleton dependencies — objects are stored on app.state at startup
# ---------------------------------------------------------------------------

def get_chroma(request: Request):
    """Return the ChromaDB collection stored in app.state."""
    return request.app.state.chroma_collection


def get_graph_store(request: Request):
    """Return the GraphStore singleton stored in app.state."""
    return request.app.state.graph_store


def get_bm25_index(request: Request):
    """Return the BM25Index singleton; rebuild lazily if dirty (thread-safe)."""
    bm25_index = request.app.state.bm25_index
    if bm25_index.dirty:
        with _bm25_lock:
            if bm25_index.dirty:  # double-checked locking
                bm25_index.rebuild()
    return bm25_index


def get_pipeline(request: Request, db: Session = Depends(get_db)):
    """
    Return an IngestionPipeline bound to the current request's DB session.

    The shared singletons (chroma, graph, bm25) come from app.state;
    the DB session is request-scoped so it is properly managed.
    """
    from ingestion.pipeline import IngestionPipeline

    return IngestionPipeline(
        db=db,
        chroma_collection=request.app.state.chroma_collection,
        graph_store=request.app.state.graph_store,
        bm25_index=request.app.state.bm25_index,
    )
