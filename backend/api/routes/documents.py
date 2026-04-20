from __future__ import annotations

import json
import os
import tempfile
from typing import List, Optional

import logging

from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, Query, UploadFile
from pydantic import BaseModel
from sqlalchemy.orm import Session

from api.deps import get_bm25_index, get_chroma, get_db, get_pipeline
from api.schemas import ChunkResponse, DocumentResponse
from models_db import Chunk, Document

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/documents", tags=["documents"])

# Raw sample files directory — one level above backend/
_RAW_DIR = os.path.normpath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..", "raw")
)
_SUPPORTED_EXTENSIONS = {".pdf", ".txt", ".md", ".docx", ".xlsx", ".pptx", ".html", ".htm", ".csv"}


# ---------------------------------------------------------------------------
# POST /api/ingest
# ---------------------------------------------------------------------------

@router.post("/ingest", response_model=DocumentResponse, status_code=201)
async def ingest_document(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    chunk_strategy: str = Form("fixed"),
    chunk_size: int = Form(512),
    chunk_overlap: int = Form(50),
    embed_model: str = Form("openai/text-embedding-3-large"),
    extract_graph: bool = Form(False),
    percentile_threshold: int = Form(95),
    max_chunk_tokens: int = Form(512),
    pipeline=Depends(get_pipeline),
):
    """Upload a document and ingest it into the system."""
    filename = file.filename or "upload"
    file_ext = os.path.splitext(filename)[1].lstrip(".").lower() or "txt"

    from ingestion.loaders import SUPPORTED_TYPES
    if file_ext not in SUPPORTED_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file type '{file_ext}'. Allowed: {', '.join(sorted(SUPPORTED_TYPES))}.",
        )

    _MAX_UPLOAD_BYTES = 100 * 1024 * 1024  # 100 MB

    # Write upload to a temporary file
    suffix = f".{file_ext}"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        contents = await file.read()
        if len(contents) > _MAX_UPLOAD_BYTES:
            raise HTTPException(
                status_code=413,
                detail=f"File too large ({len(contents) // (1024*1024)} MB). Maximum allowed is 100 MB.",
            )
        tmp.write(contents)
        tmp_path = tmp.name

    try:
        doc, embeddable_chunks, embedded_count, embedding_errors = pipeline.ingest(
            file_path=tmp_path,
            filename=filename,
            file_type=file_ext,
            chunk_strategy=chunk_strategy,
            chunk_size=chunk_size,
            chunk_overlap=chunk_overlap,
            embedder_name=embed_model,
            extract_graph=False,
            percentile_threshold=percentile_threshold,
            max_chunk_tokens=max_chunk_tokens,
        )
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass

    if extract_graph and embeddable_chunks:
        chunk_dicts = [{"id": c.id, "content": c.content} for c in embeddable_chunks]
        background_tasks.add_task(pipeline.extract_graph, chunk_dicts, doc.id)

    return _doc_to_response(doc, embedded_count=embedded_count, embedding_errors=embedding_errors)


# ---------------------------------------------------------------------------
# GET /api/documents/samples  —  list files in the raw/ directory
# ---------------------------------------------------------------------------

@router.get("/samples")
def list_samples():
    """Return metadata for every file in the raw/ sample directory."""
    if not os.path.isdir(_RAW_DIR):
        return []
    files = []
    for fname in sorted(os.listdir(_RAW_DIR)):
        ext = os.path.splitext(fname)[1].lower()
        if ext not in _SUPPORTED_EXTENSIONS:
            continue
        fpath = os.path.join(_RAW_DIR, fname)
        try:
            size = os.path.getsize(fpath)
        except OSError:
            size = 0
        files.append({"filename": fname, "size_bytes": size, "ext": ext.lstrip(".")})
    return files


# ---------------------------------------------------------------------------
# POST /api/documents/ingest-samples  —  ingest selected raw files
# ---------------------------------------------------------------------------

class SampleIngestRequest(BaseModel):
    filenames: List[str]
    chunk_strategy: str = "fixed"
    chunk_size: int = 512
    chunk_overlap: int = 50
    embed_model: str = "openai/text-embedding-3-large"
    extract_graph: bool = False
    percentile_threshold: int = 95
    max_chunk_tokens: int = 512


@router.post("/ingest-samples", response_model=List[DocumentResponse], status_code=201)
def ingest_samples(
    body: SampleIngestRequest,
    background_tasks: BackgroundTasks,
    pipeline=Depends(get_pipeline),
):
    """Ingest one or more files from the raw/ sample directory."""
    if not os.path.isdir(_RAW_DIR):
        raise HTTPException(status_code=404, detail="Sample directory not found.")

    if not body.filenames:
        raise HTTPException(status_code=400, detail="No filenames provided.")

    results: List[DocumentResponse] = []

    for fname in body.filenames:
        # Security: no path traversal
        if os.sep in fname or "/" in fname or fname.startswith("."):
            logger.warning("ingest-samples: rejected suspicious filename '%s'", fname)
            continue

        fpath = os.path.join(_RAW_DIR, fname)
        if not os.path.isfile(fpath):
            logger.warning("ingest-samples: file not found '%s'", fpath)
            continue

        ext = os.path.splitext(fname)[1].lstrip(".").lower()
        if not ext or f".{ext}" not in _SUPPORTED_EXTENSIONS:
            continue

        try:
            doc, embeddable_chunks, embedded_count, embedding_errors = pipeline.ingest(
                file_path=fpath,
                filename=fname,
                file_type=ext,
                chunk_strategy=body.chunk_strategy,
                chunk_size=body.chunk_size,
                chunk_overlap=body.chunk_overlap,
                embedder_name=body.embed_model,
                extract_graph=False,
                percentile_threshold=body.percentile_threshold,
                max_chunk_tokens=body.max_chunk_tokens,
            )
        except Exception as exc:
            logger.error("ingest-samples: failed to ingest '%s': %s", fname, exc)
            continue

        if body.extract_graph and embeddable_chunks:
            chunk_dicts = [{"id": c.id, "content": c.content} for c in embeddable_chunks]
            background_tasks.add_task(pipeline.extract_graph, chunk_dicts, doc.id)

        results.append(_doc_to_response(doc, embedded_count=embedded_count, embedding_errors=embedding_errors))

    return results


# ---------------------------------------------------------------------------
# GET /api/documents
# ---------------------------------------------------------------------------

@router.get("", response_model=List[DocumentResponse])
def list_documents(db: Session = Depends(get_db)):
    """Return all ingested documents."""
    docs = db.query(Document).order_by(Document.created_at.desc()).all()
    return [_doc_to_response(d) for d in docs]


# ---------------------------------------------------------------------------
# GET /api/documents/extracting  — must be before /{doc_id} to avoid shadowing
# ---------------------------------------------------------------------------

@router.get("/extracting")
def list_extracting():
    """Return doc_ids whose graph extraction is currently running."""
    from ingestion.pipeline import get_active_extraction_ids
    return get_active_extraction_ids()


# ---------------------------------------------------------------------------
# GET /api/documents/{doc_id}
# ---------------------------------------------------------------------------

@router.get("/{doc_id}", response_model=DocumentResponse)
def get_document(doc_id: str, db: Session = Depends(get_db)):
    """Return a single document's metadata."""
    doc = db.query(Document).filter(Document.id == doc_id).first()
    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found.")
    return _doc_to_response(doc)


# ---------------------------------------------------------------------------
# GET /api/documents/{doc_id}/chunks
# ---------------------------------------------------------------------------

@router.get("/{doc_id}/chunks", response_model=List[ChunkResponse])
def get_document_chunks(
    doc_id: str,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=200),
    db: Session = Depends(get_db),
):
    """Return a paginated list of chunks for a document."""
    doc = db.query(Document).filter(Document.id == doc_id).first()
    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found.")

    offset = (page - 1) * page_size
    chunks = (
        db.query(Chunk)
        .filter(Chunk.doc_id == doc_id)
        .order_by(Chunk.chunk_index)
        .offset(offset)
        .limit(page_size)
        .all()
    )
    return [_chunk_to_response(c) for c in chunks]


# ---------------------------------------------------------------------------
# POST /api/documents/{doc_id}/extract-graph
# ---------------------------------------------------------------------------

@router.post("/{doc_id}/extract-graph", status_code=202)
def trigger_graph_extraction(
    doc_id: str,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    pipeline=Depends(get_pipeline),
):
    """Start graph extraction for an already-ingested document (runs in background)."""
    from ingestion.pipeline import get_active_extraction_ids

    doc = db.query(Document).filter(Document.id == doc_id).first()
    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found.")

    if doc_id in get_active_extraction_ids():
        raise HTTPException(status_code=409, detail="Graph extraction already running for this document.")

    chunks = db.query(Chunk).filter(Chunk.doc_id == doc_id).all()
    if not chunks:
        raise HTTPException(status_code=400, detail="No chunks found for this document.")

    chunk_dicts = [{"id": c.id, "content": c.content} for c in chunks]
    logger.info("Scheduling graph extraction for doc %s (%d chunks)", doc_id, len(chunk_dicts))
    background_tasks.add_task(pipeline.extract_graph, chunk_dicts, doc_id)
    return {"status": "started", "doc_id": doc_id, "chunk_count": len(chunk_dicts)}


@router.get("/{doc_id}/extract-progress")
def get_extract_progress(doc_id: str):
    """Return live progress for an in-progress graph extraction, or 404 if not running."""
    from ingestion.pipeline import get_extraction_progress
    progress = get_extraction_progress(doc_id)
    if progress is None:
        raise HTTPException(status_code=404, detail="No active extraction for this document.")
    return progress  # {total, done, triples}


# ---------------------------------------------------------------------------
# POST /api/documents/cancel-graph
# ---------------------------------------------------------------------------

@router.post("/{doc_id}/cancel-graph", status_code=204)
def cancel_graph_extraction(doc_id: str):
    """Cancel a running graph extraction for the given document."""
    from ingestion.pipeline import cancel_extraction
    cancel_extraction(doc_id)
    return None


# ---------------------------------------------------------------------------
# DELETE /api/documents/{doc_id}
# ---------------------------------------------------------------------------

@router.delete("/{doc_id}", status_code=204)
def delete_document(
    doc_id: str,
    db: Session = Depends(get_db),
    chroma=Depends(get_chroma),
    bm25_index=Depends(get_bm25_index),
):
    """Delete a document and all associated chunks from SQLite, ChromaDB, and BM25 index."""
    doc = db.query(Document).filter(Document.id == doc_id).first()
    if doc is None:
        raise HTTPException(status_code=404, detail="Document not found.")

    # Collect chunk IDs for ChromaDB deletion
    chunk_ids = [c.id for c in db.query(Chunk).filter(Chunk.doc_id == doc_id).all()]

    # Remove from ChromaDB (non-fatal if IDs already absent)
    if chunk_ids:
        try:
            chroma.delete(ids=chunk_ids)
        except Exception as exc:
            logger.warning("ChromaDB delete failed for doc %s: %s", doc_id, exc)

    # Remove from BM25 index
    try:
        bm25_index.remove_by_doc_id(doc_id)
    except Exception as exc:
        logger.warning("BM25 remove failed for doc %s: %s", doc_id, exc)

    # SQLAlchemy cascade will handle Chunk deletion
    db.delete(doc)
    db.commit()
    return None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _doc_to_response(
    doc: Document,
    embedded_count: int = 0,
    embedding_errors: int = 0,
) -> DocumentResponse:
    try:
        meta = json.loads(doc.doc_metadata or "{}")
    except (json.JSONDecodeError, TypeError):
        meta = {}
    return DocumentResponse(
        id=doc.id,
        filename=doc.filename,
        file_type=doc.file_type,
        created_at=doc.created_at,
        chunk_strategy=doc.chunk_strategy,
        chunk_count=doc.chunk_count,
        doc_metadata=meta,
        graph_extracted=bool(doc.graph_extracted),
        embedded_count=embedded_count,
        embedding_errors=embedding_errors,
    )


def _chunk_to_response(chunk: Chunk) -> ChunkResponse:
    try:
        meta = json.loads(chunk.metadata_json or "{}")
    except (json.JSONDecodeError, TypeError):
        meta = {}
    return ChunkResponse(
        id=chunk.id,
        doc_id=chunk.doc_id,
        content=chunk.content,
        chunk_index=chunk.chunk_index,
        parent_chunk_id=chunk.parent_chunk_id,
        start_char=chunk.start_char,
        end_char=chunk.end_char,
        metadata=meta,
    )
