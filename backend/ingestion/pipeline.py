from __future__ import annotations

import json
import logging
import threading
import time
import uuid
from datetime import datetime, timezone
from typing import List

from sqlalchemy.orm import Session

from chunking.base import ChunkData
from chunking.fixed import FixedSizeChunker
from chunking.parent_child import ParentChildChunker
from chunking.sliding import SlidingWindowChunker
from chunking.sentence import SentenceChunker
from ingestion.loaders import load_document
from models_db import Chunk, Document

logger = logging.getLogger(__name__)

_CHROMA_BATCH_SIZE = 100

# Token-budget constants for graph extraction.
# Each extractor call sends up to 3 000 chars of text + a fixed prompt template (~350 tokens)
# and receives up to 1 024 output tokens.  We track a running total and proactively wait
# whenever the next chunk would exceed the per-minute limit — avoiding 429s rather than
# reacting to them.  On an actual 429 we still respect the Retry-After header as a safety net.
_TOKEN_BUDGET_PER_MIN = 28_000   # slightly under the 30 k/min tier limit
_PROMPT_FIXED_TOKENS  = 350      # template + entity-type list + predicates + formatting
_MAX_OUTPUT_TOKENS    = 1_024    # hard cap passed to the LLM


def _estimate_chunk_tokens(text: str) -> int:
    """Rough token estimate for one extraction call (input + max output)."""
    input_tokens = min(len(text), 3_000) // 4 + _PROMPT_FIXED_TOKENS
    return input_tokens + _MAX_OUTPUT_TOKENS

# ---------------------------------------------------------------------------
# Active extraction registry
# maps doc_id → {
#   "cancel":           threading.Event,
#   "total":            int,
#   "done":             int,
#   "triples":          int,
#   "status":           "running" | "rate_limited",
#   "rate_limit_until": float  (time.monotonic() deadline, 0.0 when not waiting),
# }
# ---------------------------------------------------------------------------
_active_extractions: dict = {}
_active_extractions_lock = threading.Lock()


def get_active_extraction_ids() -> list:
    """Return list of doc_ids currently being graph-extracted."""
    with _active_extractions_lock:
        return list(_active_extractions.keys())


def get_extraction_progress(doc_id: str) -> dict | None:
    """Return progress dict for doc_id, or None if not running."""
    with _active_extractions_lock:
        entry = _active_extractions.get(doc_id)
    if entry is None:
        return None
    wait_remaining = max(0.0, entry.get("rate_limit_until", 0.0) - time.monotonic())
    return {
        "total":              entry["total"],
        "done":               entry["done"],
        "triples":            entry["triples"],
        "status":             entry.get("status", "running"),
        "wait_remaining_secs": round(wait_remaining, 1),
    }


def cancel_extraction(doc_id: str) -> bool:
    """Signal cancellation for doc_id. Returns True if it was running."""
    with _active_extractions_lock:
        entry = _active_extractions.get(doc_id)
    if entry is not None:
        entry["cancel"].set()
        return True
    return False


def _select_chunker(
    chunk_strategy: str,
    chunk_size: int,
    chunk_overlap: int,
    embedder=None,
    **kwargs,
):
    """Return the appropriate chunker instance for *chunk_strategy*."""
    strategy = chunk_strategy.lower()
    if strategy == "fixed":
        return FixedSizeChunker(chunk_size=chunk_size, chunk_overlap=chunk_overlap)
    elif strategy == "sliding":
        return SlidingWindowChunker(
            window_size=chunk_size,
            step_size=max(1, chunk_size - chunk_overlap),
        )
    elif strategy == "sentence":
        return SentenceChunker(max_chunk_size=chunk_size)
    elif strategy == "parent_child":
        return ParentChildChunker(
            parent_size=max(chunk_size * 2, 1024),
            child_size=max(chunk_size // 2, 128),
        )
    elif strategy == "semantic":
        from chunking.semantic import SemanticChunker

        max_tokens = kwargs.get("max_chunk_tokens", SemanticChunker.DEFAULT_MAX_CHUNK_TOKENS)
        return SemanticChunker(
            embedder=embedder,
            percentile_threshold=kwargs.get("percentile_threshold", 95),
            fallback_chunk_size=max_tokens,
            max_chunk_tokens=max_tokens,
        )
    else:
        logger.warning("Unknown chunk strategy '%s'; falling back to 'fixed'.", chunk_strategy)
        return FixedSizeChunker(chunk_size=chunk_size, chunk_overlap=chunk_overlap)


class IngestionPipeline:
    """
    Orchestrates the full document ingestion workflow:

    1. Load raw text from the file.
    2. Chunk the text using the selected strategy.
    3. Persist Document + Chunk records to SQLite.
    4. Embed non-parent chunks and upsert into ChromaDB.
    5. Notify the BM25 index that a rebuild is required.
    6. Optionally extract entities/relations and update the graph store.
    """

    def __init__(
        self,
        db: Session,
        chroma_collection,
        graph_store,
        bm25_index,
    ) -> None:
        self._db = db
        self._chroma = chroma_collection
        self._graph_store = graph_store
        self._bm25_index = bm25_index

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def ingest(
        self,
        file_path: str,
        filename: str,
        file_type: str,
        chunk_strategy: str = "fixed",
        chunk_size: int = 512,
        chunk_overlap: int = 50,
        embedder_name: str = "openai/text-embedding-3-large",
        extract_graph: bool = False,
        percentile_threshold: int = 95,
        max_chunk_tokens: int = 512,
    ) -> tuple:
        """
        Ingest a single document and return its ORM record.

        Parameters
        ----------
        file_path:
            Absolute path to the uploaded file on disk.
        filename:
            Original filename as provided by the user.
        file_type:
            ``"pdf"``, ``"txt"``, or ``"md"``.
        chunk_strategy:
            One of ``fixed``, ``sliding``, ``sentence``, ``semantic``, ``parent_child``.
        chunk_size:
            Target chunk size in characters (interpretation varies by strategy).
        chunk_overlap:
            Overlap size in characters (for fixed/sliding).
        embedder_name:
            Provider key for the embedding model (e.g. ``openai/text-embedding-3-small``).
        extract_graph:
            If True, run graph extraction on a sample of chunks.

        Returns
        -------
        Document
            The newly created SQLAlchemy Document ORM object.
        """
        # ------------------------------------------------------------------
        # Step 1: Load document text
        # ------------------------------------------------------------------
        logger.info("Loading document: %s (%s)", filename, file_type)
        text = load_document(file_path, file_type)

        # ------------------------------------------------------------------
        # Step 2: Get embedder (lazy — may fail gracefully for semantic)
        # ------------------------------------------------------------------
        embedder = None
        try:
            from models.registry import get_embedder

            embedder = get_embedder(embedder_name)
        except Exception as exc:
            logger.warning("Could not load embedder '%s': %s. Proceeding without embeddings.", embedder_name, exc)

        # ------------------------------------------------------------------
        # Step 3: Chunk the text
        # ------------------------------------------------------------------
        chunker = _select_chunker(
            chunk_strategy, chunk_size, chunk_overlap, embedder,
            percentile_threshold=percentile_threshold,
            max_chunk_tokens=max_chunk_tokens,
        )
        doc_id = str(uuid.uuid4())
        chunk_data_list: List[ChunkData] = chunker.chunk(text, doc_id)
        logger.info("Created %d chunks with strategy '%s'.", len(chunk_data_list), chunk_strategy)

        # ------------------------------------------------------------------
        # Step 4: Persist Document record
        # ------------------------------------------------------------------
        doc = Document(
            id=doc_id,
            filename=filename,
            file_type=file_type.lstrip(".").lower(),
            created_at=datetime.now(timezone.utc).replace(tzinfo=None),
            chunk_strategy=chunk_strategy,
            chunk_count=len(chunk_data_list),
            doc_metadata=json.dumps({"source": filename, "chunk_size": chunk_size, "chunk_overlap": chunk_overlap, "embed_model": embedder_name}),
        )
        self._db.add(doc)

        # ------------------------------------------------------------------
        # Step 5: Persist Chunk records
        # ------------------------------------------------------------------
        chunk_orm_list: List[Chunk] = []
        for cd in chunk_data_list:
            chunk_id = str(uuid.uuid4())
            # Store the generated chunk uuid back in metadata for parent-child
            if "_chunk_uuid" in cd.metadata:
                chunk_id = cd.metadata["_chunk_uuid"]

            orm_chunk = Chunk(
                id=chunk_id,
                doc_id=doc_id,
                content=cd.content,
                chunk_index=cd.chunk_index,
                parent_chunk_id=cd.parent_chunk_id,
                start_char=cd.start_char,
                end_char=cd.end_char,
                metadata_json=json.dumps(cd.metadata),
            )
            chunk_orm_list.append(orm_chunk)
            self._db.add(orm_chunk)

        self._db.commit()
        self._db.refresh(doc)

        # ------------------------------------------------------------------
        # Step 6: Embed non-parent chunks → ChromaDB
        # ------------------------------------------------------------------
        embeddable_chunks = [
            c for c, cd in zip(chunk_orm_list, chunk_data_list)
            if not cd.metadata.get("is_parent", False)
        ]

        embedded_count = 0
        embedding_errors = 0

        if embedder is not None and embeddable_chunks:
            embedded_count, embedding_errors = self._add_to_chroma(embeddable_chunks, doc_id, embedder)
            if embedding_errors:
                logger.warning(
                    "Embedding partially failed: %d/%d batches errored. "
                    "Chunks are saved in SQLite but vector retrieval may be incomplete.",
                    embedding_errors,
                    -(-len(embeddable_chunks) // _CHROMA_BATCH_SIZE),  # ceil div
                )
        else:
            if embedder is None:
                logger.warning("Skipping ChromaDB upsert: no embedder available.")

        # ------------------------------------------------------------------
        # Step 7: Mark BM25 index as dirty
        # ------------------------------------------------------------------
        self._bm25_index.dirty = True
        for orm_chunk in embeddable_chunks:
            self._bm25_index.add_document(doc_id=doc_id, chunk_id=orm_chunk.id, text=orm_chunk.content)

        return doc, embeddable_chunks, embedded_count, embedding_errors

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    def _add_to_chroma(self, chunks: List[Chunk], doc_id: str, embedder) -> tuple[int, int]:
        """Batch-embed chunks and upsert into ChromaDB.

        Returns (embedded_count, error_count) — number of chunks successfully
        embedded and number of batches that failed.
        """
        texts = [c.content for c in chunks]
        ids = [c.id for c in chunks]
        metadatas = [
            {"doc_id": doc_id, "chunk_index": c.chunk_index, "parent_chunk_id": c.parent_chunk_id or ""}
            for c in chunks
        ]

        embedded_count = 0
        error_count = 0

        for batch_start in range(0, len(texts), _CHROMA_BATCH_SIZE):
            batch_texts = texts[batch_start : batch_start + _CHROMA_BATCH_SIZE]
            batch_ids = ids[batch_start : batch_start + _CHROMA_BATCH_SIZE]
            batch_meta = metadatas[batch_start : batch_start + _CHROMA_BATCH_SIZE]

            try:
                embeddings = embedder.embed(batch_texts)
                self._chroma.upsert(
                    ids=batch_ids,
                    embeddings=embeddings,
                    documents=batch_texts,
                    metadatas=batch_meta,
                )
                embedded_count += len(batch_texts)
            except Exception as exc:
                logger.error("ChromaDB upsert failed for batch starting at %d: %s", batch_start, exc)
                error_count += 1

        return embedded_count, error_count

    def extract_graph(self, chunk_dicts: list, doc_id: str) -> tuple[int, int]:
        """
        Extract entities/relations for *chunk_dicts* sequentially with a proactive
        token-budget guard.

        Processing model
        ----------------
        * One chunk at a time (no parallelism) so the request rate is fully controlled.
        * Before every chunk we check whether the estimated token cost would exceed
          ``_TOKEN_BUDGET_PER_MIN`` in the current 60-second window.  If it would,
          we sleep until the window resets — avoiding 429s proactively.
        * If an actual 429 still arrives (e.g. shared quota), we parse the Retry-After
          header and sleep for that exact duration as a safety net.
        * Every chunk carries an explicit ``done`` flag; rate-limited chunks are retried
          automatically on the next pass through the outer while loop.

        Accepts plain dicts with ``id`` and ``content`` keys (safe after session close).
        Returns (chunks_processed, triples_found).
        """
        from graph.extractor import EntityRelationExtractor
        from models.registry import get_llm
        from config import settings

        _SAVE_EVERY = 50  # persist graph to disk every N successfully processed chunks

        # ------------------------------------------------------------------
        # Load custom entity types
        # ------------------------------------------------------------------
        entity_types = None
        allowed_predicates = None
        min_confidence = 0.65
        preprocess_text = True
        try:
            from database import SessionLocal as _SessionLocal
            from models_db import AppState as _AppState
            import json as _json
            _tmp_db = _SessionLocal()
            try:
                _row = _tmp_db.query(_AppState).filter(_AppState.key == "graph_entity_types").first()
                if _row:
                    _data = _json.loads(_row.value)
                    if isinstance(_data, list):
                        entity_types = [t["name"] for t in _data if isinstance(t, dict) and "name" in t]

                _row2 = _tmp_db.query(_AppState).filter(_AppState.key == "graph_predicates").first()
                if _row2:
                    _pdata = _json.loads(_row2.value)
                    if isinstance(_pdata, list):
                        allowed_predicates = [
                            p["name"] for p in _pdata
                            if isinstance(p, dict) and p.get("enabled", True) and "name" in p
                        ] or None  # None = use extractor defaults if all disabled

                _row3 = _tmp_db.query(_AppState).filter(_AppState.key == "graph_extraction_config").first()
                if _row3:
                    _cfg = _json.loads(_row3.value)
                    if isinstance(_cfg, dict):
                        min_confidence = float(_cfg.get("min_confidence", 0.65))
                        preprocess_text = bool(_cfg.get("preprocess_text", True))
            finally:
                _tmp_db.close()
        except Exception:
            pass

        try:
            llm = get_llm(settings.DEFAULT_LLM)
            extractor = EntityRelationExtractor(
                llm=llm,
                entity_types=entity_types,
                allowed_predicates=allowed_predicates,
                min_confidence=min_confidence,
                preprocess_text=preprocess_text,
            )
        except Exception as exc:
            logger.warning("Graph extraction: could not initialise extractor: %s", exc)
            return 0, 0

        # ------------------------------------------------------------------
        # Register so the progress + cancel endpoints can see this extraction
        # ------------------------------------------------------------------
        cancel_event = threading.Event()
        with _active_extractions_lock:
            _active_extractions[doc_id] = {
                "cancel":           cancel_event,
                "total":            len(chunk_dicts),
                "done":             0,
                "triples":          0,
                "status":           "running",
                "rate_limit_until": 0.0,
            }

        logger.info(
            "Graph extraction started: %d chunks for doc %s (sequential, budget %d TPM)",
            len(chunk_dicts), doc_id, _TOKEN_BUDGET_PER_MIN,
        )

        # ------------------------------------------------------------------
        # Per-chunk done flag and running counters
        # ------------------------------------------------------------------
        chunk_done: dict[str, bool] = {c["id"]: False for c in chunk_dicts}
        completed_count = 0
        triples_found   = 0

        # ------------------------------------------------------------------
        # Token-budget state (reset every 60 seconds)
        # ------------------------------------------------------------------
        budget_used:         int   = 0
        budget_window_start: float = time.monotonic()

        def _is_rate_limit(exc: Exception) -> bool:
            s = str(exc)
            return "RateLimit" in type(exc).__name__ or "429" in s or "rate_limit" in s.lower()

        def _set_status(status: str, wait_until: float = 0.0) -> None:
            with _active_extractions_lock:
                if doc_id in _active_extractions:
                    _active_extractions[doc_id]["status"]           = status
                    _active_extractions[doc_id]["rate_limit_until"] = wait_until

        def _update_progress() -> None:
            with _active_extractions_lock:
                if doc_id in _active_extractions:
                    _active_extractions[doc_id]["done"]    = completed_count
                    _active_extractions[doc_id]["triples"] = triples_found

        def _sleep_interruptible(seconds: float) -> bool:
            """Sleep for *seconds*, checking cancel_event every second.
            Returns True if we slept the full duration, False if cancelled."""
            deadline = time.monotonic() + seconds
            while time.monotonic() < deadline:
                if cancel_event.is_set():
                    return False
                time.sleep(min(1.0, deadline - time.monotonic()))
                # Keep rate_limit_until up to date so the countdown stays accurate
                with _active_extractions_lock:
                    pass  # the value is already set; the getter computes remaining time
            return True

        def _budget_wait(needed: int) -> bool:
            """Block until *needed* tokens fit in the current window.
            Resets the window when 60 s have elapsed.
            Returns False if cancelled while waiting."""
            nonlocal budget_used, budget_window_start

            while True:
                now     = time.monotonic()
                elapsed = now - budget_window_start

                if elapsed >= 60.0:
                    # New window — reset counter
                    budget_used         = 0
                    budget_window_start = now
                    elapsed             = 0.0

                if budget_used + needed <= _TOKEN_BUDGET_PER_MIN:
                    budget_used += needed
                    return True  # OK to proceed

                # Window is full — wait until it resets
                wait = 60.0 - elapsed + 0.5   # tiny buffer
                logger.info(
                    "Token budget: %d/%d used. Waiting %.0fs for window reset "
                    "(%d/%d chunks done).",
                    budget_used, _TOKEN_BUDGET_PER_MIN, wait,
                    completed_count, len(chunk_dicts),
                )
                _set_status("rate_limited", time.monotonic() + wait)
                if not _sleep_interruptible(wait):
                    return False   # cancelled
                _set_status("running")
                # Loop back → will reset budget_used at top of loop

        # ------------------------------------------------------------------
        # Main extraction loop
        # ------------------------------------------------------------------
        try:
            while not cancel_event.is_set():
                pending = [c for c in chunk_dicts if not chunk_done[c["id"]]]
                if not pending:
                    break

                for chunk in pending:
                    if cancel_event.is_set():
                        break

                    estimated = _estimate_chunk_tokens(chunk["content"])

                    # Proactive budget check — may sleep here
                    if not _budget_wait(estimated):
                        break   # cancelled during budget wait

                    try:
                        triples = extractor.extract(
                            text=chunk["content"],
                            chunk_id=chunk["id"],
                            doc_id=doc_id,
                        )
                    except Exception as exc:
                        if _is_rate_limit(exc):
                            # Unexpected 429 despite proactive guard — treat Retry-After
                            # as authoritative and exhaust the current window so
                            # _budget_wait will wait for the next one.
                            from models.openai_provider import parse_retry_after
                            wait = parse_retry_after(exc)
                            logger.warning(
                                "429 on chunk %s despite budget guard. "
                                "Waiting %.1fs (Retry-After). %d/%d done.",
                                chunk["id"], wait, completed_count, len(chunk_dicts),
                            )
                            # Exhaust budget so the next _budget_wait sleeps appropriately
                            budget_used = _TOKEN_BUDGET_PER_MIN
                            _set_status("rate_limited", time.monotonic() + wait)
                            _sleep_interruptible(wait)
                            _set_status("running")
                            # Don't mark chunk done — break inner loop so outer while
                            # rebuilds pending and retries this chunk.
                            break
                        else:
                            # Non-rate-limit failure: log, skip chunk permanently
                            logger.warning("Extraction failed for chunk %s: %s", chunk["id"], exc)
                            chunk_done[chunk["id"]] = True
                            completed_count += 1
                            _update_progress()
                            continue

                    # Success
                    chunk_done[chunk["id"]] = True
                    if triples:
                        self._graph_store.add_triples(triples, doc_id=doc_id)
                        triples_found += len(triples)
                    completed_count += 1
                    _update_progress()

                    if completed_count % _SAVE_EVERY == 0:
                        try:
                            self._graph_store.save()
                            logger.info(
                                "Graph extraction progress: %d/%d chunks done, %d triples.",
                                completed_count, len(chunk_dicts), triples_found,
                            )
                        except Exception as save_exc:
                            logger.warning("Mid-extraction save failed: %s", save_exc)

        finally:
            with _active_extractions_lock:
                _active_extractions.pop(doc_id, None)

        # ------------------------------------------------------------------
        # Final save + DB update
        # ------------------------------------------------------------------
        try:
            self._graph_store.save()
            logger.info(
                "Graph extraction complete for doc %s: %d/%d chunks processed, "
                "%d triples, %d nodes, %d edges.",
                doc_id, completed_count, len(chunk_dicts), triples_found,
                self._graph_store.node_count, self._graph_store.edge_count,
            )
        except Exception as exc:
            logger.warning("Graph final save failed: %s", exc)

        if cancel_event.is_set():
            return completed_count, triples_found

        try:
            from database import SessionLocal as _SessionLocal
            from models_db import Document as _Document
            _db = _SessionLocal()
            try:
                _doc = _db.query(_Document).filter(_Document.id == doc_id).first()
                if _doc:
                    _doc.graph_extracted = True
                    _db.commit()
            finally:
                _db.close()
        except Exception as exc:
            logger.warning("Could not mark doc %s as graph_extracted: %s", doc_id, exc)

        return completed_count, triples_found
