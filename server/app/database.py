from __future__ import annotations
from sqlmodel import SQLModel, create_engine, text
from sqlalchemy.ext.asyncio import create_async_engine
from sqlmodel.ext.asyncio.session import AsyncSession
from sqlalchemy.orm import sessionmaker
from app.config import get_settings

settings = get_settings()

# Async engine for FastAPI
async_engine = create_async_engine(settings.database_url, echo=False, future=True)

# Sync engine for Alembic / Celery tasks
sync_engine = create_engine(settings.sync_database_url, echo=False)

AsyncSessionLocal = sessionmaker(
    bind=async_engine,
    class_=AsyncSession,
    expire_on_commit=False,
)


async def get_session() -> AsyncSession:  # type: ignore[override]
    async with AsyncSessionLocal() as session:
        yield session


async def create_db_and_tables() -> None:
    async with async_engine.begin() as conn:
        await conn.run_sync(SQLModel.metadata.create_all)
        # Idempotent migration: add owner_id to repos if not present
        await conn.execute(text(
            "ALTER TABLE repos ADD COLUMN IF NOT EXISTS owner_id VARCHAR REFERENCES users(id) ON DELETE SET NULL"
        ))
        # create_all() creates missing TABLES but never adds a column to an
        # existing one, so every new column needs a line here. Same
        # idempotent pattern as owner_id above. This is a stopgap that suits
        # a fast-moving build; if this outlives the demo, replace the whole
        # block with Alembic before the data matters.
        await conn.execute(text(
            "ALTER TABLE repos ADD COLUMN IF NOT EXISTS workspace_id VARCHAR REFERENCES workspaces(id) ON DELETE CASCADE"
        ))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_repos_workspace_id ON repos (workspace_id)"
        ))
        await conn.execute(text(
            "ALTER TABLE repos ADD COLUMN IF NOT EXISTS ingest_seconds DOUBLE PRECISION"
        ))
        # GitHub App support: OAuth login linking (users.github_id/login,
        # password now optional) and per-repo installation tagging (for the
        # picker's already-imported diff and installation-token cloning).
        await conn.execute(text(
            "ALTER TABLE users ALTER COLUMN hashed_password DROP NOT NULL"
        ))
        await conn.execute(text(
            "ALTER TABLE users ADD COLUMN IF NOT EXISTS github_id VARCHAR UNIQUE"
        ))
        await conn.execute(text(
            "ALTER TABLE users ADD COLUMN IF NOT EXISTS github_login VARCHAR"
        ))
        await conn.execute(text(
            "ALTER TABLE repos ADD COLUMN IF NOT EXISTS github_repo_id INTEGER"
        ))
        await conn.execute(text(
            "ALTER TABLE repos ADD COLUMN IF NOT EXISTS github_installation_id INTEGER"
        ))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_repos_github_repo_id ON repos (github_repo_id)"
        ))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_repos_github_installation_id ON repos (github_installation_id)"
        ))
