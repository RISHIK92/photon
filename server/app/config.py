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

    # Gemini — vision only (image/screen-frame analysis, Phase 4). All text
    # generation moved to OpenRouter (openrouter_chat_model below) after
    # this key's free tier turned out to be capped at 20 requests/DAY for
    # gemini-2.5-*, nowhere near enough for the agent loop's plan+compose
    # calls or the web console's query streaming.
    gemini_api_key: str = Field(default="", alias="GEMINI_API_KEY")
    gemini_chat_model: str = "gemini-2.5-pro"
    gemini_vision_model: str = "gemini-3.7-flash"

    # OpenRouter — text generation (agent plan/compose, check_conflict judge,
    # web console query streaming). See note above.
    openrouter_api_key: str = Field(default="", alias="OPENROUTER_API_KEY")
    openrouter_chat_model: str = "deepseek/deepseek-v4-flash-0731"

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
