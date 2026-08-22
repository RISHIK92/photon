"""Meetings and their shared transcript.

A meeting is identified by its slug (abcd-efgh), which is also the LiveKit
room name — one identifier for the link, the room and the transcript.

Transcript writes come from the call-agent worker, which is the only thing
that sees every finalized turn. Reads are workspace-scoped like everything
else.
"""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import PlainTextResponse
from sqlmodel import SQLModel, select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.core.auth import get_current_user
from app.core.workspace import get_current_workspace, membership_for, require_role
from app.database import get_session
from app.models import (
    Meeting,
    MeetingRead,
    TranscriptEntry,
    TranscriptEntryCreate,
    TranscriptRole,
    User,
    Workspace,
    WorkspaceRole,
)
from app.services.meeting_slug import new_slug, normalise

router = APIRouter()


class MeetingCreate(SQLModel):
    title: Optional[str] = None


@router.post("", response_model=MeetingRead, status_code=201)
async def create_meeting(
    payload: MeetingCreate,
    session: AsyncSession = Depends(get_session),
    current_user: User = Depends(get_current_user),
    # A viewer may start a call: joining and asking questions is exactly
    # what the viewer role is for.
    workspace: Workspace = Depends(require_role(WorkspaceRole.VIEWER)),
):
    for _ in range(5):  # collisions are vanishingly unlikely; retry anyway
        slug = new_slug()
        if not (await session.execute(select(Meeting).where(Meeting.slug == slug))).scalars().first():
            break
    else:
        raise HTTPException(status_code=500, detail="Could not allocate a meeting code")

    meeting = Meeting(
        slug=slug, workspace_id=workspace.id, title=payload.title, created_by=current_user.id
    )
    session.add(meeting)
    await session.commit()
    await session.refresh(meeting)
    return meeting


@router.get("", response_model=list[MeetingRead])
async def list_meetings(
    session: AsyncSession = Depends(get_session),
    workspace: Workspace = Depends(get_current_workspace),
):
    result = await session.execute(
        select(Meeting)
        .where(Meeting.workspace_id == workspace.id)
        .order_by(Meeting.created_at.desc())
        .limit(50)
    )
    return result.scalars().all()


async def _meeting_by_slug(session: AsyncSession, slug: str) -> Meeting:
    result = await session.execute(select(Meeting).where(Meeting.slug == normalise(slug)))
    meeting = result.scalars().first()
    if not meeting:
        raise HTTPException(status_code=404, detail="No meeting with that code")
    return meeting


@router.get("/{slug}", response_model=MeetingRead)
async def get_meeting(
    slug: str,
    session: AsyncSession = Depends(get_session),
    current_user: User = Depends(get_current_user),
):
    """Resolve a code to a meeting.

    Deliberately NOT workspace-scoped: someone joining a call from a shared
    link may not be a member of the workspace at all (an external client on
    a support call). Membership decides what the AGENT will tell them, not
    whether the room exists.
    """
    return await _meeting_by_slug(session, slug)


@router.post("/{slug}/transcript", status_code=201)
async def append_transcript(
    slug: str,
    payload: TranscriptEntryCreate,
    session: AsyncSession = Depends(get_session),
):
    """Append one line. Called by the call-agent worker as turns finalize.

    Unauthenticated for the same reason /api/agent/ask is (demo scope, see
    CLAUDE.md): the worker is a server-side component with no user session.
    Before this is exposed beyond localhost it needs a shared secret — noted
    rather than pretended away.
    """
    meeting = await _meeting_by_slug(session, slug)

    speaker_user_id = None
    identity = payload.speaker_identity or ""
    if identity.startswith("user:"):
        # Identity is signed into the LiveKit token by our own API, so the
        # user id in it is trustworthy — a guest cannot type their way into
        # being someone else (see client/app/api/livekit-token/route.ts).
        candidate = identity.split("user:", 1)[1]
        if await session.get(User, candidate):
            speaker_user_id = candidate

    entry = TranscriptEntry(
        meeting_id=meeting.id,
        role=payload.role,
        speaker_name=payload.speaker_name,
        speaker_identity=payload.speaker_identity,
        speaker_user_id=speaker_user_id,
        text=payload.text,
    )
    session.add(entry)
    await session.commit()
    return {"ok": True}


@router.get("/{slug}/transcript.md", response_class=PlainTextResponse)
async def transcript_markdown(
    slug: str,
    session: AsyncSession = Depends(get_session),
    current_user: User = Depends(get_current_user),
    download: bool = Query(default=False),
):
    """The whole call as one markdown document.

    Rendered from rows rather than stored as an appended blob: several
    people and the agent all speak during a call, and concurrent
    read-modify-write on a single text column loses lines silently.
    """
    meeting = await _meeting_by_slug(session, slug)
    if not await membership_for(session, meeting.workspace_id, current_user.id):
        # The room is discoverable by code; what was SAID in it is not.
        raise HTTPException(status_code=404, detail="No meeting with that code")

    result = await session.execute(
        select(TranscriptEntry)
        .where(TranscriptEntry.meeting_id == meeting.id)
        .order_by(TranscriptEntry.created_at)
    )
    entries = result.scalars().all()

    lines = [
        f"# {meeting.title or 'Meeting'} — {meeting.slug}",
        "",
        f"*{meeting.created_at:%Y-%m-%d %H:%M} UTC · {len(entries)} entries*",
        "",
    ]
    for e in entries:
        who = "**Photon**" if e.role == TranscriptRole.AGENT else f"**{e.speaker_name}**"
        lines.append(f"`{e.created_at:%H:%M:%S}` {who}: {e.text}")
        lines.append("")

    body = "\n".join(lines)
    headers = (
        {"Content-Disposition": f'attachment; filename="{meeting.slug}.md"'} if download else {}
    )
    return PlainTextResponse(body, media_type="text/markdown; charset=utf-8", headers=headers)


@router.post("/{slug}/end", response_model=MeetingRead)
async def end_meeting(
    slug: str,
    session: AsyncSession = Depends(get_session),
    current_user: User = Depends(get_current_user),
):
    meeting = await _meeting_by_slug(session, slug)
    if not await membership_for(session, meeting.workspace_id, current_user.id):
        raise HTTPException(status_code=404, detail="No meeting with that code")
    meeting.ended_at = meeting.ended_at or datetime.utcnow()
    session.add(meeting)
    await session.commit()
    await session.refresh(meeting)
    return meeting
