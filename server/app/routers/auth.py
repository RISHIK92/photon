"""Authentication router — signup, login."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import OAuth2PasswordRequestForm
from sqlmodel.ext.asyncio.session import AsyncSession
from sqlmodel import select

from app.database import get_session
from app.models import User, UserCreate, UserRead
from app.core.auth import hash_password, verify_password, create_access_token, get_current_user
from app.core.workspace import ensure_personal_workspace

router = APIRouter()


@router.post("/signup", response_model=UserRead, status_code=201)
async def signup(payload: UserCreate, session: AsyncSession = Depends(get_session)):
    # Check duplicate email
    result = await session.execute(select(User).where(User.email == payload.email))
    if result.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="Email already registered")

    user = User(email=payload.email.lower().strip(), hashed_password=hash_password(payload.password))
    session.add(user)
    await session.commit()
    await session.refresh(user)
    # A user with no workspace has nowhere to put a repo, so it is created
    # here rather than lazily at first use.
    await ensure_personal_workspace(session, user)
    return user


@router.post("/login")
async def login(
    form_data: OAuth2PasswordRequestForm = Depends(),
    session: AsyncSession = Depends(get_session),
):
    result = await session.execute(select(User).where(User.email == form_data.username.lower().strip()))
    user = result.scalar_one_or_none()
    if not user or not verify_password(form_data.password, user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect email or password",
            headers={"WWW-Authenticate": "Bearer"},
        )
    # Users created before workspaces existed would otherwise log in fine
    # and then have nowhere to put anything.
    workspace = await ensure_personal_workspace(session, user)
    token = create_access_token(user.id, user.email)
    return {
        "access_token": token,
        "token_type": "bearer",
        "user": {"id": user.id, "email": user.email},
        "workspace": {"id": workspace.id, "name": workspace.name},
    }


@router.get("/me", response_model=UserRead)
async def me(current_user: User = Depends(get_current_user)):
    """Return the currently authenticated user."""
    return current_user
