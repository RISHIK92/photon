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
