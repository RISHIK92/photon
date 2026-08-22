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
        # Postgres enum types are created once by create_all and NEVER
        # altered by it, so adding a value to a Python Enum leaves the DB
        # type behind — inserts then fail with
        # `invalid input value for enum workspacerole: "VIEWER"`.
        # SQLAlchemy persists enum NAMES, hence the uppercase literal.
        # (PG allows ADD VALUE inside a transaction as long as the new value
        # is not also USED in that same transaction — it isn't, this runs at
        # startup.)
        await conn.execute(text(
            "ALTER TYPE workspacerole ADD VALUE IF NOT EXISTS 'VIEWER'"
        ))

        # Connections can belong to the whole workspace or to one person
        # (see core/workspace.py). Existing rows predate the distinction and
        # were all workspace-wide, which is the correct backfill.
        await conn.execute(text(
            "ALTER TABLE github_installations ADD COLUMN IF NOT EXISTS scope VARCHAR NOT NULL DEFAULT 'workspace'"
        ))
        await conn.execute(text(
            "ALTER TABLE github_installations ADD COLUMN IF NOT EXISTS owner_user_id VARCHAR REFERENCES users(id) ON DELETE CASCADE"
        ))
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_slack_channels_workspace ON slack_channels (workspace_id)"
        ))
        # Call configuration added after `meetings` already existed. JSONB
        # rather than JSON: it is what Postgres actually wants for these,
        # and the columns are new so there is nothing to convert.
        await conn.execute(text(
            "ALTER TABLE meetings ADD COLUMN IF NOT EXISTS bot_types JSONB DEFAULT '[\"support\"]'::jsonb"
        ))
        await conn.execute(text(
            "ALTER TABLE meetings ADD COLUMN IF NOT EXISTS language_mode VARCHAR DEFAULT 'english'"
        ))
        await conn.execute(text(
            "ALTER TABLE meetings ADD COLUMN IF NOT EXISTS enabled_sources JSONB"
        ))
        # Existing workspaces predate the distinction. Backfilled as
        # individual rather than team: a workspace nobody was ever invited
        # to IS an individual one, and defaulting the other way would
        # silently label every existing workspace as shared.
        await conn.execute(text(
            "ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS kind VARCHAR NOT NULL DEFAULT 'INDIVIDUAL'"
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
