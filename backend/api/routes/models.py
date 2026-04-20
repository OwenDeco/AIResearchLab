from __future__ import annotations

import json
import logging
from typing import Dict, List, Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from api.deps import get_db
from api.schemas import ModelsResponse
from config import settings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/models", tags=["models"])

_RERANKERS = ["cross-encoder/ms-marco-MiniLM-L-6-v2"]
_CUSTOM_MODELS_KEY = "custom_models"

# Static suggestion lists (per provider, excluding Azure which is deployment-specific)
_OPENAI_LLM_SUGGESTIONS = [
    "openai/gpt-4o",
    "openai/gpt-4o-mini",
    "openai/o1",
    "openai/o1-mini",
    "openai/o3-mini",
]
_OPENAI_EMBED_SUGGESTIONS = [
    "openai/text-embedding-3-large",
    "openai/text-embedding-3-small",
]
_OLLAMA_LLM_SUGGESTIONS = [
    "ollama/llama3.3",
    "ollama/llama3.2",
    "ollama/mistral",
    "ollama/qwen2.5",
    "ollama/phi4",
    "ollama/deepseek-r1",
]
_OLLAMA_EMBED_SUGGESTIONS = [
    "ollama/nomic-embed-text",
    "ollama/mxbai-embed-large",
    "ollama/bge-m3",
]


class CustomModelsPayload(BaseModel):
    llms: List[str] = Field(default_factory=list)
    embed_models: List[str] = Field(default_factory=list)


def _load_custom(db: Session) -> Optional[CustomModelsPayload]:
    """
    Load the custom_models row from AppState.
    Returns None if the row has never been set (distinguishes "never set" from "set to empty").
    """
    from models_db import AppState
    try:
        row = db.query(AppState).filter(AppState.key == _CUSTOM_MODELS_KEY).first()
    except Exception as exc:
        logger.warning("Could not read custom models from AppState: %s", exc)
        return CustomModelsPayload()
    if row is None:
        return None
    try:
        data = json.loads(row.value)
        result = CustomModelsPayload(**data)
        logger.debug("Loaded %d custom LLMs, %d custom embed models", len(result.llms), len(result.embed_models))
        return result
    except Exception as exc:
        logger.warning("Could not parse custom models JSON: %s", exc)
        return CustomModelsPayload()


def _save_custom(db: Session, payload: CustomModelsPayload) -> None:
    """Persist a CustomModelsPayload to AppState."""
    from models_db import AppState
    from datetime import datetime, timezone

    value = payload.model_dump_json()
    row = db.query(AppState).filter(AppState.key == _CUSTOM_MODELS_KEY).first()
    if row is None:
        logger.info("Creating new custom_models row")
        db.add(AppState(key=_CUSTOM_MODELS_KEY, value=value))
    else:
        logger.info("Updating existing custom_models row")
        row.value = value
        row.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
    db.commit()


def _seed_defaults() -> CustomModelsPayload:
    """Build the initial seed from provider availability helpers."""
    return CustomModelsPayload(
        llms=settings.available_llms(),
        embed_models=settings.available_embed_models(),
    )


# ---------------------------------------------------------------------------
# GET /api/models  — custom_models is the single source of truth
# ---------------------------------------------------------------------------

@router.get("", response_model=ModelsResponse)
def get_available_models(db: Session = Depends(get_db)):
    """
    Return the user-managed model list.
    If the custom_models row has never been set, auto-seed from available provider
    defaults and persist — so existing users don't lose their models on first upgrade.
    """
    custom = _load_custom(db)

    if custom is None:
        # First time — seed from provider defaults
        logger.info("custom_models not found; seeding from provider defaults")
        custom = _seed_defaults()
        _save_custom(db, custom)

    # Always include the current agent model so the Agent LLM selector has something to show
    agent_model = settings.AGENT_MODEL
    if agent_model and agent_model not in custom.llms:
        custom = CustomModelsPayload(llms=[agent_model] + custom.llms, embed_models=custom.embed_models)
        _save_custom(db, custom)

    return ModelsResponse(llms=custom.llms, embed_models=custom.embed_models, rerankers=_RERANKERS)


# ---------------------------------------------------------------------------
# GET /api/models/suggestions  — per-provider suggestions not already in the list
# ---------------------------------------------------------------------------

@router.get("/suggestions")
def get_model_suggestions(db: Session = Depends(get_db)):
    """
    Return suggested model IDs per provider, filtered to exclude models already in custom_models.
    Only configured providers are included.
    """
    custom = _load_custom(db) or CustomModelsPayload()
    existing_set = set(custom.llms + custom.embed_models)

    result: Dict = {}

    if settings.OPENAI_API_KEY:
        result["openai"] = {
            "configured": True,
            "llms": [m for m in _OPENAI_LLM_SUGGESTIONS if m not in existing_set],
            "embed_models": [m for m in _OPENAI_EMBED_SUGGESTIONS if m not in existing_set],
        }

    if settings.AZURE_OPENAI_API_KEY and settings.AZURE_OPENAI_ENDPOINT:
        result["azure"] = {
            "configured": True,
            "llms": [],
            "embed_models": [],
            "note": "Azure deployment names are specific to your setup. Add them manually as azure/YOUR-DEPLOYMENT-NAME.",
        }

    if settings.OLLAMA_BASE_URL:
        result["ollama"] = {
            "configured": True,
            "llms": [m for m in _OLLAMA_LLM_SUGGESTIONS if m not in existing_set],
            "embed_models": [m for m in _OLLAMA_EMBED_SUGGESTIONS if m not in existing_set],
        }

    return result


# ---------------------------------------------------------------------------
# GET /api/models/custom  — user-managed list (same as GET /api/models now)
# ---------------------------------------------------------------------------

@router.get("/custom", response_model=CustomModelsPayload)
def get_custom_models(db: Session = Depends(get_db)):
    """Return the user-managed model list (custom_models AppState row)."""
    custom = _load_custom(db)
    if custom is None:
        return CustomModelsPayload()
    return custom


# ---------------------------------------------------------------------------
# PUT /api/models/custom
# ---------------------------------------------------------------------------

@router.put("/custom", status_code=204)
def update_custom_models(payload: CustomModelsPayload, db: Session = Depends(get_db)):
    """Persist the user-managed model list."""
    logger.info("PUT /models/custom called: %d LLMs, %d embed models", len(payload.llms), len(payload.embed_models))

    # Validate format: must be "provider/model"
    all_models = payload.llms + payload.embed_models
    for m in all_models:
        if "/" not in m or not m.split("/")[0] or not m.split("/", 1)[1]:
            from fastapi import HTTPException
            raise HTTPException(status_code=400, detail=f"Invalid model format '{m}'. Use provider/model-name.")

    _save_custom(db, payload)
    logger.info("custom_models committed to DB")
    return None
