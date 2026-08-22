from __future__ import annotations
import os
import zipfile
import io
import asyncio
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, Header
from sqlmodel.ext.asyncio.session import AsyncSession
from sqlmodel import select

from app.database import get_session
from app.models import Repo, RepoCreate, RepoRead, RepoStatus, RepoSourceType, Job, User, Workspace
from app.config import get_settings
from app.tasks.ingestion import run_ingestion
from app.core.auth import get_current_user
from app.core.workspace import get_current_workspace

router = APIRouter()
settings = get_settings()


def _may_access(repo: Repo, user: User, workspace: Workspace) -> bool:
    """Workspace membership is the rule; owner_id is a legacy fallback.

    Repos created before workspaces existed have workspace_id = NULL, and
    silently 404ing someone's own repo after an upgrade would look like
    data loss. Once those are backfilled this fallback can go.
    """
    if repo.workspace_id:
        return repo.workspace_id == workspace.id
    return repo.owner_id == user.id


@router.post("", response_model=RepoRead, status_code=201)
async def create_repo(
    payload: RepoCreate,
    session: AsyncSession = Depends(get_session),
    current_user: User = Depends(get_current_user),
    workspace: Workspace = Depends(get_current_workspace),
):
    """Connect a repository (GitHub URL or local path)."""
    repo = Repo(**payload.model_dump(), owner_id=current_user.id, workspace_id=workspace.id)
    session.add(repo)
    await session.commit()
    await session.refresh(repo)

    # Create job record
    job = Job(repo_id=repo.id)
    session.add(job)
    await session.commit()
    await session.refresh(job)

    # Dispatch Celery ingestion task
    run_ingestion.apply_async(
        args=[repo.id, job.id],
        task_id=job.id,
    )

    return repo


@router.post("/upload", response_model=RepoRead, status_code=201)
async def upload_zip(
    name: str = Form(...),
    file: UploadFile = File(...),
    session: AsyncSession = Depends(get_session),
    current_user: User = Depends(get_current_user),
):
    """Upload a ZIP archive for ingestion."""
    storage = settings.repos_storage_path

    # Save zip metadata
    repo = Repo(name=name, source_type=RepoSourceType.ZIP, owner_id=current_user.id)
    session.add(repo)
    await session.commit()
    await session.refresh(repo)

    repo_dir = os.path.join(storage, repo.id)
    os.makedirs(repo_dir, exist_ok=True)
    contents = await file.read()
    
    # Run CPU-bound extraction in a thread to avoid blocking the async event loop
    def extract_zip():
        with zipfile.ZipFile(io.BytesIO(contents)) as z:
            z.extractall(repo_dir)
            
    await asyncio.to_thread(extract_zip)

    repo.local_path = repo_dir
    session.add(repo)
    await session.commit()

    job = Job(repo_id=repo.id)
    session.add(job)
    await session.commit()
    await session.refresh(job)

    run_ingestion.apply_async(args=[repo.id, job.id], task_id=job.id)
    return repo


@router.get("", response_model=list[RepoRead])
async def list_repos(
    session: AsyncSession = Depends(get_session),
    current_user: User = Depends(get_current_user),
    workspace: Workspace = Depends(get_current_workspace),
):
    # Workspace-scoped, not user-scoped: a teammate joining a workspace
    # must see its repos, and the same repo must NOT leak across workspaces.
    result = await session.execute(
        select(Repo).where(Repo.workspace_id == workspace.id).order_by(Repo.created_at.desc())
    )
    return result.scalars().all()


@router.get("/{repo_id}", response_model=RepoRead)
async def get_repo(
    repo_id: str,
    session: AsyncSession = Depends(get_session),
    current_user: User = Depends(get_current_user),
    workspace: Workspace = Depends(get_current_workspace),
):
    repo = await session.get(Repo, repo_id)
    if not repo:
        raise HTTPException(status_code=404, detail="Repo not found")
    if not _may_access(repo, current_user, workspace):
        raise HTTPException(status_code=404, detail="Repo not found")
    return repo


@router.delete("/{repo_id}", status_code=204)
async def delete_repo(
    repo_id: str,
    session: AsyncSession = Depends(get_session),
    current_user: User = Depends(get_current_user),
    workspace: Workspace = Depends(get_current_workspace),
):
    repo = await session.get(Repo, repo_id)
    if not repo:
        raise HTTPException(status_code=404, detail="Repo not found")
    if not _may_access(repo, current_user, workspace):
        raise HTTPException(status_code=404, detail="Repo not found")
    await session.delete(repo)
    await session.commit()