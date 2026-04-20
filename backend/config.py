from __future__ import annotations

import os
from pathlib import Path
from typing import List
from pydantic_settings import BaseSettings
from pydantic import Field

# Resolve .env relative to this file, so it works regardless of working directory
_ENV_FILE = Path(__file__).parent / ".env"


class Settings(BaseSettings):
    # LLM providers
    OPENAI_API_KEY: str = ""
    AZURE_OPENAI_API_KEY: str = ""
    AZURE_OPENAI_ENDPOINT: str = ""
    AZURE_OPENAI_DEPLOYMENT: str = ""
    OLLAMA_BASE_URL: str = "http://localhost:11434"

    # Graph
    NEO4J_URI: str = ""

    # Database / storage
    DATABASE_URL: str = "sqlite:///./ragtool.db"
    CHROMA_PERSIST_DIR: str = "./chroma_data"
    GRAPH_DATA_PATH: str = "./graph_data.json"

    # Defaults
    DEFAULT_LLM: str = "openai/gpt-4o-mini"
    DEFAULT_EMBED_MODEL: str = "openai/text-embedding-3-small"

    # Server
    HOST: str = "0.0.0.0"
    PORT: int = 8000
    CORS_ORIGINS: List[str] = ["http://localhost:5173", "http://localhost:3000"]

    # A2A — public base URL of this server (used in agent card)
    # Override with ngrok URL or production domain when deploying
    AGENT_BASE_URL: str = "http://localhost:8002"

    # Agent LLM — model used by the agent tool-calling loop
    AGENT_MODEL: str = "openai/gpt-4o"

    # A2A — when False the agent returns raw tool results without a synthesis
    # LLM call. Set to False when the caller (e.g. OutSystems) has its own LLM
    # that will synthesize the answer, skipping the extra round-trip entirely.
    A2A_SYNTHESIZE: bool = True

    # Debug — enables verbose request/response logging for MCP paths
    DEBUG: bool = False

    model_config = {"env_file": str(_ENV_FILE), "env_file_encoding": "utf-8", "extra": "ignore"}

    # ------------------------------------------------------------------
    # Provider availability helpers
    # ------------------------------------------------------------------

    def available_llms(self) -> List[str]:
        """Return default LLM provider keys based on configured credentials."""
        providers: List[str] = []

        if self.OPENAI_API_KEY:
            providers.extend([
                "openai/gpt-4o",
                "openai/gpt-4o-mini",
                "openai/o1",
                "openai/o1-mini",
                "openai/o3-mini",
            ])

        if self.AZURE_OPENAI_API_KEY and self.AZURE_OPENAI_ENDPOINT and self.AZURE_OPENAI_DEPLOYMENT:
            providers.append(f"azure/{self.AZURE_OPENAI_DEPLOYMENT}")

        providers.extend([
            "ollama/llama3.3",
            "ollama/llama3.2",
            "ollama/mistral",
            "ollama/qwen2.5",
            "ollama/phi4",
            "ollama/deepseek-r1",
        ])

        return providers

    def available_embed_models(self) -> List[str]:
        """Return default embedding provider keys based on configured credentials."""
        providers: List[str] = []

        if self.OPENAI_API_KEY:
            providers.extend([
                "openai/text-embedding-3-large",
                "openai/text-embedding-3-small",
            ])

        if self.AZURE_OPENAI_API_KEY and self.AZURE_OPENAI_ENDPOINT and self.AZURE_OPENAI_DEPLOYMENT:
            providers.append(f"azure/{self.AZURE_OPENAI_DEPLOYMENT}-embedding")

        providers.extend([
            "ollama/nomic-embed-text",
            "ollama/mxbai-embed-large",
            "ollama/bge-m3",
        ])

        return providers


settings = Settings()

# Expose the .env path so other modules can update it
ENV_FILE_PATH = _ENV_FILE
