from __future__ import annotations
from functools import lru_cache
from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import Field


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # App
    app_env: str = "development"
    secret_key: str = "changeme"
    api_key: str = "yasml-dev-key"

    # PostgreSQL
    postgres_host: str = "localhost"
    postgres_port: int = 5432
    postgres_db: str = "yasml"
    postgres_user: str = "yasml"
    postgres_password: str = "yasml_secret"

    @property
    def database_url(self) -> str:
        return (
            f"postgresql+asyncpg://{self.postgres_user}:{self.postgres_password}"
            f"@{self.postgres_host}:{self.postgres_port}/{self.postgres_db}"
        )

    @property
    def sync_database_url(self) -> str:
        return (
            f"postgresql://{self.postgres_user}:{self.postgres_password}"
            f"@{self.postgres_host}:{self.postgres_port}/{self.postgres_db}"
        )

    # Redis
    redis_url: str = "redis://localhost:6379/0"

    # Neo4j
    neo4j_uri: str = "bolt://localhost:7687"
    neo4j_user: str = "neo4j"
    neo4j_password: str = "neo4j_secret"

    # Qdrant
    qdrant_host: str = "localhost"
    qdrant_port: int = 6333

    # Gemini — unused. Kept only because the key is already in .env; every
    # actual LLM call (text AND vision) goes through OpenRouter below.
    # Gemini's own free tier is capped at 20 requests/DAY, confirmed to hit
    # that wall on BOTH the text model (gemini-2.5-*, Phase 3) and the
    # vision model (gemini-3.7-flash, screen-frame analysis) — nowhere near
    # enough for a live call. Don't route anything through this key again
    # without a paid tier.
    gemini_api_key: str = Field(default="", alias="GEMINI_API_KEY")
    gemini_chat_model: str = "gemini-2.5-pro"

    # OpenRouter — text generation (agent plan/compose, check_conflict judge,
    # web console query streaming) AND vision (screen-frame analysis). See
    # note above for why both live here instead of on Gemini directly.
    openrouter_api_key: str = Field(default="", alias="OPENROUTER_API_KEY")
    # Latency, measured with the agent's own plan/compose prompts against a
    # real 22-item evidence set (not vendor benchmarks): deepseek-v4-flash
    # 11.3-16.6s per turn of LLM time, gemini-3.7-flash 6.1-7.6s,
    # gemini-3.1-flash-lite 3.7-9.7s (unstable), gpt-oss-120b 16.8s+,
    # claude-haiku-4.5 4.6-6.1s -> gemini-3.5-flash-lite 2.43-2.49s with
    # clean JSON on every run. That is the whole reason this is the text
    # model; do not swap it without re-running the same measurement (the
    # bench lives in git history / CLAUDE.md).
    openrouter_chat_model: str = "google/gemini-3.5-flash-lite"
    openrouter_vision_model: str = "google/gemini-3.7-flash"

    # Voyage AI (embeddings)
    voyage_api_key: str = Field(default="", alias="VOYAGE_API_KEY")
    voyage_embedding_model: str = "voyage-code-3"

    # GitHub
    github_token: str = ""

    # Storage
    repos_storage_path: str = "/tmp/yasml-repos"

    # Chunk settings
    chunk_max_tokens: int = 512
    embedding_batch_size: int = 100

    # Query settings
    top_k_vector: int = 10
    top_k_graph_hops: int = 3

    # JWT
    jwt_secret_key: str = Field(default="change-me-in-production-jwt-secret", alias="JWT_SECRET_KEY")
    jwt_algorithm: str = "HS256"
    jwt_expire_minutes: int = 10080  # 7 days


@lru_cache
def get_settings() -> Settings:
    return Settings()
