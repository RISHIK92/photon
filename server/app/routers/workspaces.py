"""Workspace CRUD. Membership is the authorisation unit — see
app/core/workspace.py."""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.core.auth import get_current_user
from app.core.workspace import ensure_personal_workspace, get_current_workspace
from app.database import get_session
from app.models import User, Workspace, WorkspaceCreate, WorkspaceMember, WorkspaceRead, WorkspaceRole

router = APIRouter()


@router.get("", response_model=list[WorkspaceRead])
async def list_workspaces(
    session: AsyncSession = Depends(get_session),
    current_user: User = Depends(get_current_user),
):
    # Guarantees a first-time user always sees at least one workspace
    # instead of an empty picker they cannot get out of.
    await ensure_personal_workspace(session, current_user)
    result = await session.execute(
        select(Workspace, WorkspaceMember.role)
        .join(WorkspaceMember, WorkspaceMember.workspace_id == Workspace.id)
        .where(WorkspaceMember.user_id == current_user.id)
        .order_by(Workspace.created_at)
    )
    return [
        WorkspaceRead(
            id=w.id, name=w.name, is_personal=w.is_personal, role=role, created_at=w.created_at
        )
        for w, role in result.all()
    ]


@router.post("", response_model=WorkspaceRead, status_code=201)
async def create_workspace(
    payload: WorkspaceCreate,
    session: AsyncSession = Depends(get_session),
    current_user: User = Depends(get_current_user),
):
    workspace = Workspace(name=payload.name.strip(), is_personal=False)
    session.add(workspace)
    await session.flush()
    session.add(
        WorkspaceMember(workspace_id=workspace.id, user_id=current_user.id, role=WorkspaceRole.OWNER)
    )
    await session.commit()
    await session.refresh(workspace)
    return WorkspaceRead(
        id=workspace.id,
        name=workspace.name,
        is_personal=workspace.is_personal,
        role=WorkspaceRole.OWNER,
        created_at=workspace.created_at,
    )


@router.get("/current", response_model=WorkspaceRead)
async def current_workspace(
    workspace: Workspace = Depends(get_current_workspace),
    session: AsyncSession = Depends(get_session),
    current_user: User = Depends(get_current_user),
):
    from app.core.workspace import membership_for

    member = await membership_for(session, workspace.id, current_user.id)
    return WorkspaceRead(
        id=workspace.id,
        name=workspace.name,
        is_personal=workspace.is_personal,
        role=member.role if member else WorkspaceRole.OWNER,
        created_at=workspace.created_at,
    )
