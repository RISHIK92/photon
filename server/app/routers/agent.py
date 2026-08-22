from __future__ import annotations

import base64
import binascii
import json
from typing import Optional

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


@router.post("/ask")
async def ask(payload: AgentAskRequest, stream: bool = Query(default=False)):
    screen_image_bytes = None
    if payload.screen_image_base64:
        try:
            screen_image_bytes = base64.b64decode(payload.screen_image_base64, validate=True)
        except (binascii.Error, ValueError):
            raise HTTPException(status_code=422, detail="screen_image_base64 is not valid base64")

    result = await answer_question(
        payload.question, payload.repo_id, payload.screen_context, screen_image_bytes
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
