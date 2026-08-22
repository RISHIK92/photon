"""Text generation for the agent loop's plan/compose calls, plus a tolerant
JSON extractor since the model doesn't always honor "no markdown fences"
cleanly even with json_mode on. Zero transport imports — this only talks
to OpenRouter's HTTP API via app.core.llm.openrouter.
"""
from __future__ import annotations

import asyncio
import json
import re

import structlog

from app.core.llm.openrouter import sync_chat

log = structlog.get_logger()


async def generate(prompt: str, max_output_tokens: int = 1500, temperature: float = 0.1, json_mode: bool = False) -> str:
    return await asyncio.get_event_loop().run_in_executor(
        None, sync_chat, prompt, max_output_tokens, temperature, json_mode
    )


_JSON_BLOCK_RE = re.compile(r"\{.*\}", re.DOTALL)
_FENCE_RE = re.compile(r"^```(?:json)?\s*|\s*```$", re.MULTILINE)


def extract_json(text: str) -> dict | None:
    if not text:
        return None
    cleaned = _FENCE_RE.sub("", text).strip()
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        pass
    m = _JSON_BLOCK_RE.search(cleaned)
    if m:
        try:
            return json.loads(m.group(0))
        except json.JSONDecodeError:
            log.warning("agent.llm_json_extract_failed", text=cleaned[:300])
            return None
    log.warning("agent.llm_no_json_found", text=cleaned[:300])
    return None
