"""OpenRouter chat-completions client (OpenAI-compatible). This is the text-
generation provider for the agent loop, check_conflict, and the web
console's /api/query streaming — see app.config.Settings for why Gemini
text generation was dropped (its free tier is capped at 20 requests/DAY,
nowhere near enough). Gemini stays configured separately for vision/image
use (gemini_vision_model) once Phase 4 needs it.

Deliberately provider-specific rather than hidden behind an abstraction —
there's exactly one text provider in use, and an interface for a
hypothetical second one would be unused generality.
"""
from __future__ import annotations

import json
from typing import AsyncIterator

import httpx
import structlog
from tenacity import retry, retry_if_exception, stop_after_attempt, wait_exponential

from app.config import get_settings

log = structlog.get_logger()
settings = get_settings()

_URL = "https://openrouter.ai/api/v1/chat/completions"


def _headers() -> dict:
    return {
        "Authorization": f"Bearer {settings.openrouter_api_key}",
        "Content-Type": "application/json",
    }


def _is_retryable(exc: BaseException) -> bool:
    if isinstance(exc, httpx.HTTPStatusError):
        return exc.response.status_code in (429, 500, 502, 503)
    # Observed directly: some calls to this model via OpenRouter take 60s+
    # with no error, just a slow upstream response — worth one retry rather
    # than failing the whole agent turn outright, though a demo-time fix
    # (dedicated tier / different model) is the real answer if this proves
    # frequent. See CLAUDE.md.
    return isinstance(exc, (httpx.ReadTimeout, httpx.ConnectTimeout))


@retry(
    retry=retry_if_exception(_is_retryable),
    wait=wait_exponential(multiplier=2, min=2, max=30),
    stop=stop_after_attempt(2),
    reraise=True,
)
def sync_chat(prompt: str, max_tokens: int = 1500, temperature: float = 0.1, json_mode: bool = False) -> str:
    """Blocking call — run in a thread executor from async code."""
    body = {
        "model": settings.openrouter_chat_model,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": max_tokens,
        "temperature": temperature,
    }
    if json_mode:
        body["response_format"] = {"type": "json_object"}

    response = httpx.post(_URL, headers=_headers(), json=body, timeout=60.0)
    response.raise_for_status()
    data = response.json()
    choices = data.get("choices") or []
    if not choices:
        log.warning("openrouter.no_choices", data=data)
        return ""
    return (choices[0].get("message", {}).get("content") or "").strip()


async def stream_chat(prompt: str, max_tokens: int = 2048, temperature: float = 0.2) -> AsyncIterator[str]:
    """Async generator of text deltas via OpenRouter's SSE streaming."""
    body = {
        "model": settings.openrouter_chat_model,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": max_tokens,
        "temperature": temperature,
        "stream": True,
    }
    async with httpx.AsyncClient(timeout=60.0) as client:
        async with client.stream("POST", _URL, headers=_headers(), json=body) as response:
            response.raise_for_status()
            async for line in response.aiter_lines():
                if not line or not line.startswith("data: "):
                    continue
                payload = line[len("data: ") :].strip()
                if payload == "[DONE]":
                    break
                try:
                    chunk = json.loads(payload)
                except json.JSONDecodeError:
                    continue
                delta = (chunk.get("choices") or [{}])[0].get("delta", {})
                text = delta.get("content")
                if text:
                    yield text
