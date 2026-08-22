"""Platform-blind session orchestrator: turn state, rolling transcript,
latest screen frame, and the HTTP call out to the Company Brain
(server/app/agent, via POST /api/agent/ask). Implements SessionCallbacks
(adapters/base.py) — a concrete adapter calls into this; this module never
imports a concrete adapter, only the base contract.

Open mic, not explicit address: every finalized user turn is treated as
addressed to the agent (per explicit user instruction — the build plan's
original Phase 4 design used a "Photon" wake word instead; that's been
dropped here). Trade-off worth knowing: with no wake word, side comments,
talking to someone else on the call, or ambient chatter all get sent to
the agent as if they were questions for it.
"""
from __future__ import annotations

import re
import time
from dataclasses import dataclass, field

import httpx
import structlog

from adapters.base import TransportAdapter

log = structlog.get_logger()

VISUAL_HINT_RE = re.compile(
    r"\b(where do i|i can'?t find|this screen|on my screen|on the screen)\b", re.IGNORECASE
)


@dataclass
class TurnState:
    transcript: list[dict] = field(default_factory=list)
    latest_screen_frame: bytes | None = None
    latest_screen_frame_at: float = 0.0


class Orchestrator:
    """Implements SessionCallbacks. Holds no transport objects of its own —
    just a TransportAdapter reference to act through."""

    def __init__(self, adapter: TransportAdapter, brain_api_url: str):
        self.adapter = adapter
        self.brain_api_url = brain_api_url.rstrip("/")
        self.state = TurnState()
        self._http = httpx.AsyncClient(timeout=90.0)

    async def close(self) -> None:
        await self._http.aclose()

    # ── SessionCallbacks ──────────────────────────────────────────────────

    async def on_speech(self, text: str, speaker_id: str, is_final: bool) -> None:
        if not is_final or not text.strip():
            return

        self.state.transcript.append({"speaker_id": speaker_id, "text": text, "ts": time.time()})
        log.info("orchestrator.speech_finalized", speaker_id=speaker_id, text=text)

        await self._handle_turn(text)

    async def on_frame(self, image: bytes, source: str) -> None:
        if source != "screen":
            return
        self.state.latest_screen_frame = image
        self.state.latest_screen_frame_at = time.time()

    # ── internals ─────────────────────────────────────────────────────────

    def _wants_visual_context(self, question: str) -> bool:
        return bool(VISUAL_HINT_RE.search(question)) and self.state.latest_screen_frame is not None

    async def _handle_turn(self, question: str) -> None:
        screen_context = None
        if self._wants_visual_context(question):
            # Frame -> vision-model description isn't wired up yet (Phase 4
            # cut order: screen share/vision is first to go, S1-S3 all work
            # by voice alone). Note that a frame exists so it shows up in
            # the tool_trace/logs, but never fabricate a description of it.
            screen_context = "a screen frame was captured but visual analysis isn't wired up yet"

        try:
            response = await self._http.post(
                f"{self.brain_api_url}/api/agent/ask",
                json={"question": question, "screen_context": screen_context},
            )
            response.raise_for_status()
            result = response.json()
        except Exception as exc:  # noqa: BLE001 - a brain-api hiccup must not take the call down
            log.error("orchestrator.brain_api_error", error=str(exc))
            await self.adapter.speak(
                "Sorry, I couldn't reach my knowledge base just now — could you ask again in a moment?"
            )
            return

        answer = (result.get("answer") or "").strip()
        if answer:
            await self.adapter.speak(answer)
        else:
            log.warning("orchestrator.empty_answer", question=question, result=result)
