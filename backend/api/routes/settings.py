from __future__ import annotations

import logging
import os
from typing import Optional

from fastapi import APIRouter
from pydantic import BaseModel

from config import ENV_FILE_PATH, settings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/settings", tags=["settings"])

# Keys we manage — order determines display on the frontend
_MANAGED_KEYS = [
    "OPENAI_API_KEY",
    "AZURE_OPENAI_API_KEY",
    "AZURE_OPENAI_ENDPOINT",
    "AZURE_OPENAI_DEPLOYMENT",
    "OLLAMA_BASE_URL",
    "A2A_SYNTHESIZE",
    "AGENT_MODEL",
]


class ProviderSettings(BaseModel):
    openai_api_key: str = ""
    azure_api_key: str = ""
    azure_endpoint: str = ""
    azure_deployment: str = ""
    ollama_base_url: str = ""


_MASK_MARKER = "..."

def _mask_key(val: str) -> str:
    """Return a masked version of an API key for safe display."""
    if not val:
        return ""
    if len(val) > 12:
        return val[:4] + _MASK_MARKER + val[-4:]
    return "***"


def _is_masked(val: str) -> bool:
    """True if val looks like a masked key rather than a new value."""
    return _MASK_MARKER in val or val == "***"


def _read_env_file() -> dict[str, str]:
    """Return current KEY→value pairs from .env for managed keys."""
    result: dict[str, str] = {}
    if not ENV_FILE_PATH.exists():
        return result
    with open(ENV_FILE_PATH, "r", encoding="utf-8") as fh:
        for line in fh:
            stripped = line.strip()
            if not stripped or stripped.startswith("#") or "=" not in stripped:
                continue
            key, _, val = stripped.partition("=")
            key = key.strip()
            if key in _MANAGED_KEYS:
                result[key] = val.strip()
    return result


def _write_env_file(updates: dict[str, str]) -> None:
    """
    Update managed KEY=VALUE lines in .env in-place.
    Keys set to empty string are written as KEY= (effectively cleared).
    Keys not present in the file yet are appended.
    Unmanaged lines are preserved unchanged.
    """
    lines: list[str] = []
    if ENV_FILE_PATH.exists():
        with open(ENV_FILE_PATH, "r", encoding="utf-8") as fh:
            lines = fh.readlines()

    written: set[str] = set()
    new_lines: list[str] = []
    for line in lines:
        stripped = line.strip()
        if stripped and not stripped.startswith("#") and "=" in stripped:
            key = stripped.partition("=")[0].strip()
            if key in updates:
                new_lines.append(f"{key}={updates[key]}\n")
                written.add(key)
                continue
        new_lines.append(line)

    # Append any keys that weren't already in the file
    for key in _MANAGED_KEYS:
        if key in updates and key not in written:
            new_lines.append(f"{key}={updates[key]}\n")

    with open(ENV_FILE_PATH, "w", encoding="utf-8") as fh:
        fh.writelines(new_lines)


def _apply_to_runtime(key: str, value: str) -> None:
    """Update os.environ and the settings singleton so changes are immediate."""
    if value:
        os.environ[key] = value
    elif key in os.environ:
        del os.environ[key]

    attr_map = {
        "OPENAI_API_KEY": "OPENAI_API_KEY",
        "AZURE_OPENAI_API_KEY": "AZURE_OPENAI_API_KEY",
        "AZURE_OPENAI_ENDPOINT": "AZURE_OPENAI_ENDPOINT",
        "AZURE_OPENAI_DEPLOYMENT": "AZURE_OPENAI_DEPLOYMENT",
        "OLLAMA_BASE_URL": "OLLAMA_BASE_URL",
    }
    attr = attr_map.get(key)
    if attr and hasattr(settings, attr):
        setattr(settings, attr, value)


# ---------------------------------------------------------------------------
# GET /api/settings
# ---------------------------------------------------------------------------

@router.get("", response_model=ProviderSettings)
def get_settings():
    """Return current provider settings. API keys are masked for security."""
    env = _read_env_file()

    openai_key = env.get("OPENAI_API_KEY", settings.OPENAI_API_KEY)
    azure_key = env.get("AZURE_OPENAI_API_KEY", settings.AZURE_OPENAI_API_KEY)

    return ProviderSettings(
        openai_api_key=_mask_key(openai_key),
        azure_api_key=_mask_key(azure_key),
        azure_endpoint=env.get("AZURE_OPENAI_ENDPOINT", settings.AZURE_OPENAI_ENDPOINT),
        azure_deployment=env.get("AZURE_OPENAI_DEPLOYMENT", settings.AZURE_OPENAI_DEPLOYMENT),
        ollama_base_url=env.get("OLLAMA_BASE_URL", settings.OLLAMA_BASE_URL),
    )


# ---------------------------------------------------------------------------
# PUT /api/settings
# ---------------------------------------------------------------------------

@router.put("", status_code=204)
def update_settings(payload: ProviderSettings):
    """
    Persist provider settings to .env and apply them immediately.
    Send an empty string to clear a key.
    """
    # Skip masked values — user didn't change those keys
    raw = {
        "OPENAI_API_KEY": payload.openai_api_key,
        "AZURE_OPENAI_API_KEY": payload.azure_api_key,
        "AZURE_OPENAI_ENDPOINT": payload.azure_endpoint,
        "AZURE_OPENAI_DEPLOYMENT": payload.azure_deployment,
        "OLLAMA_BASE_URL": payload.ollama_base_url,
    }
    _key_fields = {"OPENAI_API_KEY", "AZURE_OPENAI_API_KEY"}
    updates = {k: v for k, v in raw.items() if not (k in _key_fields and _is_masked(v))}

    try:
        _write_env_file(updates)
        logger.info("Settings written to %s", ENV_FILE_PATH)
    except Exception as exc:
        logger.error("Failed to write .env file: %s", exc)
        from fastapi import HTTPException
        raise HTTPException(status_code=500, detail=f"Could not write .env file: {exc}")

    for key, value in updates.items():
        _apply_to_runtime(key, value)

    # Clear cached model instances so they re-initialise with new credentials
    from models.registry import clear_cache
    clear_cache()

    logger.info("Provider settings updated and applied to runtime.")
    return None


# ---------------------------------------------------------------------------
# A2A / Agent settings
# ---------------------------------------------------------------------------

class A2ASettings(BaseModel):
    a2a_synthesize: bool = True
    agent_model: str = "openai/gpt-4o"


@router.get("/a2a", response_model=A2ASettings)
def get_a2a_settings():
    """Return current A2A agent settings."""
    env = _read_env_file()
    raw_synth = env.get("A2A_SYNTHESIZE", str(settings.A2A_SYNTHESIZE)).strip().lower()
    agent_model = env.get("AGENT_MODEL", settings.AGENT_MODEL).strip() or settings.AGENT_MODEL
    return A2ASettings(
        a2a_synthesize=raw_synth not in ("false", "0", "no"),
        agent_model=agent_model,
    )


@router.put("/a2a", status_code=204)
def update_a2a_settings(payload: A2ASettings):
    """Persist A2A settings to .env and apply immediately."""
    synth_value = "true" if payload.a2a_synthesize else "false"
    try:
        _write_env_file({"A2A_SYNTHESIZE": synth_value, "AGENT_MODEL": payload.agent_model})
    except Exception as exc:
        from fastapi import HTTPException
        raise HTTPException(status_code=500, detail=f"Could not write .env file: {exc}")

    os.environ["A2A_SYNTHESIZE"] = synth_value
    os.environ["AGENT_MODEL"] = payload.agent_model
    settings.A2A_SYNTHESIZE = payload.a2a_synthesize
    settings.AGENT_MODEL = payload.agent_model
    logger.info("Agent settings updated: model=%s synthesize=%s", payload.agent_model, synth_value)
    return None


# ---------------------------------------------------------------------------
# Provider notes  (user-editable free-text stored in AppState, not .env)
# ---------------------------------------------------------------------------

_PROVIDER_NOTES_KEY = "provider_notes"


class ProviderNotes(BaseModel):
    openai: str = ""
    azure: str = ""
    ollama: str = ""


def _get_db_for_notes():
    from api.deps import get_db
    return next(get_db())


@router.get("/provider-notes", response_model=ProviderNotes)
def get_provider_notes():
    """Return user-written notes for each provider card."""
    import json
    from models_db import AppState
    db = _get_db_for_notes()
    try:
        row = db.query(AppState).filter(AppState.key == _PROVIDER_NOTES_KEY).first()
        if row is None:
            return ProviderNotes()
        return ProviderNotes(**json.loads(row.value))
    except Exception:
        return ProviderNotes()
    finally:
        db.close()


@router.put("/provider-notes", status_code=204)
def update_provider_notes(payload: ProviderNotes):
    """Persist user-written notes for each provider card."""
    import json
    from datetime import datetime, timezone
    from models_db import AppState
    db = _get_db_for_notes()
    try:
        value = payload.model_dump_json()
        row = db.query(AppState).filter(AppState.key == _PROVIDER_NOTES_KEY).first()
        if row is None:
            db.add(AppState(key=_PROVIDER_NOTES_KEY, value=value))
        else:
            row.value = value
            row.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
        db.commit()
    finally:
        db.close()
    return None
