from __future__ import annotations

import asyncio
import base64
import binascii
import json
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.agent.loop import answer_question

router = APIRouter()


class AgentAskRequest(BaseModel):
    question: str
    repo_id: Optional[str] = None
    screen_context: Optional[str] = None
    screen_image_base64: Optional[str] = None  # a JPEG frame, base64-encoded
    language: Optional[str] = None  # BCP-47 (te-IN, ta-IN, hi-IN, en-IN) — answer in this


def _decode_frame(payload: "AgentAskRequest") -> Optional[bytes]:
    if not payload.screen_image_base64:
        return None
    try:
        return base64.b64decode(payload.screen_image_base64, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(status_code=422, detail="screen_image_base64 is not valid base64")


@router.post("/ask/stream")
async def ask_stream(payload: AgentAskRequest):
    """Server-sent events for one turn, emitted AS IT HAPPENS: plan.start,
    tool.start/tool.done (with per-tool ms), compose, verify, turn.done.

    Distinct from `/ask?stream=true`, which runs the whole turn to
    completion first and only then chunks the finished answer word by word
    — useless for latency tracking, since nothing is sent until everything
    is already over. Here the loop pushes events into a queue while it
    runs and this generator drains them, so a client sees which tool is
    running while it's still running.
    """
    screen_image_bytes = _decode_frame(payload)
    queue: asyncio.Queue[Optional[dict[str, Any]]] = asyncio.Queue()

    def sink(event: dict[str, Any]) -> None:
        # Called from inside the agent loop's own task; put_nowait keeps
        # the sink synchronous and non-blocking so tracing can never stall
        # or reorder the work it's tracing (the queue is unbounded).
        queue.put_nowait(event)

    async def run() -> None:
        try:
            await answer_question(
                payload.question,
                payload.repo_id,
                payload.screen_context,
                screen_image_bytes,
                on_event=sink,
                language=payload.language,
            )
        except Exception as exc:  # noqa: BLE001 - report the failure to the client, don't hang it
            queue.put_nowait({"type": "turn.error", "t": 0, "seq": 0, "error": str(exc)})
        finally:
            queue.put_nowait(None)  # sentinel: the turn is over either way

    async def gen():
        task = asyncio.create_task(run())
        try:
            while True:
                event = await queue.get()
                if event is None:
                    break
                yield f"data: {json.dumps(event)}\n\n"
        finally:
            # A client that disconnects mid-turn (closed the tab, left the
            # call) must not leave the turn running forever behind it.
            if not task.done():
                task.cancel()

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/ask")
async def ask(payload: AgentAskRequest, stream: bool = Query(default=False)):
    screen_image_bytes = _decode_frame(payload)

    result = await answer_question(
        payload.question,
        payload.repo_id,
        payload.screen_context,
        screen_image_bytes,
        language=payload.language,
    )

    if not stream:
        return result

    async def gen():
        # answer_question composes the full answer before verification can run
        # (claims must be checked against the complete evidence set), so this
        # isn't a true Gemini token stream — it's the verified answer chunked
        # word-by-word over SSE, reusing the same wire format/headers as
        # routers/query.py's _stream_question for a consistent client story.
        yield f"data: {json.dumps({'type': 'meta', 'tool_trace': result['tool_trace'], 'confidence': result['confidence'], 'abstained': result['abstained']})}\n\n"
        for word in result["answer"].split(" "):
            yield f"data: {json.dumps({'type': 'token', 'text': word + ' '})}\n\n"
        yield f"data: {json.dumps({'type': 'done', 'result': result})}\n\n"

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
