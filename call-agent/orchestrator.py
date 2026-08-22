"""Platform-blind session orchestrator: turn state, rolling transcript,
latest screen frame, and the HTTP call out to the Company Brain
(server/app/agent, via POST /api/agent/ask). Implements SessionCallbacks
(adapters/base.py) — a concrete adapter calls into this; this module never
imports a concrete adapter, only the base contract.

Open mic, not explicit address: every finalized user turn is considered
(per explicit user instruction — the build plan's original Phase 4 design
used a "Photon" wake word instead; that's been dropped here). What used
to be the wake-word gate is now `small_talk.classify()`: a local, regex-
only triage that answers greetings instantly and stays silent on ambient
chatter, so only real requests pay for the pipeline. Measured live before
this existed: "Hello. How are you?" cost 4.5s and a needless search_docs
call to answer a greeting.
"""
from __future__ import annotations

import base64
import json
import os
import re
import time
from dataclasses import dataclass, field

import httpx
import structlog

from adapters.base import TransportAdapter
from language import DEFAULT_LANGUAGE, detect_language, greeting_for
from small_talk import Turn, classify
from speech import for_speech

log = structlog.get_logger()

# Broadened after the original pattern missed a real utterance ("check my
# screen and help me open the search bar?") — "check/look at my screen",
# "share my screen", "help me find/open/see", "what's on (my) screen" all
# now match, not just the original narrow "where do i"/"this screen" set.
VISUAL_HINT_RE = re.compile(
    r"\b(where do i|i can'?t find|this screen|(on|check|look at|share|see) (my |the )?screen"
    r"|what'?s on (my |the )?screen|help me (find|open|see|locate)"
    # Deictic phrasing — extremely common on a screen-share call and
    # previously all missed, because none of them contain the word
    # "screen" at all. Safe to add: a frame is only ever attached when one
    # is genuinely fresh, i.e. the customer is sharing RIGHT NOW.
    r"|what am i looking at|does (this|that) look (right|correct|ok)"
    r"|am i (in|on) the right (place|page|screen)|what does (this|that) (say|mean)"
    r"|is (this|that) (right|correct)|where do i click)\b",
    re.IGNORECASE,
)


# A screen frame is only meaningful while the customer is actually
# sharing. Frames arrive at ~0.3-1fps during a share, so anything older
# than this means the share stopped (or dropped) and the buffered frame no
# longer shows what's on their screen. Without this the last frame lives
# forever: the customer stops sharing, asks "what's on my screen?" twenty
# minutes later, and the agent confidently describes a screen that hasn't
# existed for twenty minutes — real bytes, dead reality.
SCREEN_FRAME_TTL_SECONDS = 30.0

# "auto" detects the caller's language per utterance from the transcript's
# script (language.py). Pin it to a BCP-47 code (te-IN, ta-IN, hi-IN,
# en-IN) to force every reply into one language — useful when the STT in
# use romanises Indic speech, which defeats script detection.
REPLY_LANGUAGE = os.environ.get("AGENT_REPLY_LANGUAGE", "auto").strip()


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
        if not VISUAL_HINT_RE.search(question):
            return False
        if self.state.latest_screen_frame is None:
            return False
        age = time.time() - self.state.latest_screen_frame_at
        if age > SCREEN_FRAME_TTL_SECONDS:
            log.info("orchestrator.screen_frame_stale", age_seconds=round(age, 1))
            self.state.latest_screen_frame = None
            return False
        return True

    def _language_for(self, question: str) -> str:
        if REPLY_LANGUAGE != "auto":
            return REPLY_LANGUAGE
        return detect_language(question, default=DEFAULT_LANGUAGE)

    async def _handle_turn(self, question: str) -> None:
        language = self._language_for(question)

        intent = classify(question)
        if intent is not Turn.ANSWER:
            await self._handle_small_talk(question, intent, language)
            return

        screen_image_b64 = None
        if self._wants_visual_context(question):
            # The brain-api does the actual vision call (app.core.llm.vision,
            # via OpenRouter) and folds the description into the evidence
            # set as a citable "screen" item — this orchestrator just hands
            # over the raw frame, it never fabricates a description itself.
            screen_image_b64 = base64.b64encode(self.state.latest_screen_frame).decode()

        try:
            result = await self._ask_brain(question, screen_image_b64, language)
        except Exception as exc:  # noqa: BLE001 - a brain-api hiccup must not take the call down
            log.error("orchestrator.brain_api_error", error=str(exc))
            await self._publish({"type": "turn.error", "error": str(exc)})
            await self.adapter.speak(
                "Sorry, I couldn't reach my knowledge base just now — could you ask again in a moment?"
            )
            return

        if result is None:
            log.warning("orchestrator.no_turn_done_event", question=question)
            return

        answer = (result.get("answer") or "").strip()
        if answer:
            # Spoken text drops the [ev_xxx] markers — TTS reads them out
            # literally ("...platform ev 20021cda"). The structured answer
            # already went to the browser with every marker intact, so the
            # evidence chips are unaffected.
            await self.adapter.speak(for_speech(answer), language=language)
        else:
            log.warning("orchestrator.empty_answer", question=question, result=result)

    async def _handle_small_talk(self, question: str, intent: Turn, language: str) -> None:
        """Greetings get an instant canned line; ambient speech gets
        nothing at all. Neither makes a factual claim, so the "no uncited
        claim" rule is untouched — there is nothing here to cite."""
        log.info("orchestrator.small_talk", intent=intent.value, text=question, language=language)
        turn_id = f"{int(time.time() * 1000)}"
        # Pre-written per language rather than generated — a greeting has
        # to be instant, and there is no LLM in this path at all.
        answer = greeting_for(language) if intent is Turn.GREETING else ""

        # Still traced, so the advanced panel shows a deliberate 0ms fast
        # path rather than going blank as if the agent had missed the turn.
        await self._publish({"type": "turn.requested", "turn_id": turn_id, "question": question, "source": "voice"})
        await self._publish({"type": "turn.fastpath", "turn_id": turn_id, "source": "voice", "t": 0,
                             "intent": intent.value, "language": language})
        await self._publish({"type": "turn.done", "turn_id": turn_id, "source": "voice", "t": 0, "ms": 0,
                             "result": {"answer": answer or "(no reply — ambient speech)", "claims": [],
                                        "confidence": "high", "abstained": False, "escalation": None,
                                        "tool_trace": []}})
        if answer:
            await self.adapter.speak(answer, language=language)

    async def _ask_brain(
        self, question: str, screen_image_b64: str | None, language: str = DEFAULT_LANGUAGE
    ) -> dict | None:
        """Stream one turn from the brain-api, forwarding every trace event
        into the room as it arrives, and return the final answer.

        Uses /api/agent/ask/stream rather than /api/agent/ask so the
        browser's advanced panel can show which tool is running WHILE it
        runs — a plain POST only reveals the tool trace once the whole
        turn (often tens of seconds, per the documented DeepSeek latency
        variance) is already over. The spoken answer is identical either
        way; this only changes when the UI hears about the steps.
        """
        turn_id = f"{int(time.time() * 1000)}"
        await self._publish({"type": "turn.requested", "turn_id": turn_id, "question": question,
                             "source": "voice", "language": language})

        final: dict | None = None
        async with self._http.stream(
            "POST",
            f"{self.brain_api_url}/api/agent/ask/stream",
            json={
                "question": question,
                "screen_image_base64": screen_image_b64,
                "language": language,
            },
        ) as response:
            response.raise_for_status()
            async for line in response.aiter_lines():
                if not line.startswith("data: "):
                    continue
                try:
                    event = json.loads(line[6:])
                except json.JSONDecodeError:
                    log.warning("orchestrator.bad_trace_event", line=line[:200])
                    continue
                event["turn_id"] = turn_id
                event["source"] = "voice"
                await self._publish(event)
                if event.get("type") == "turn.done":
                    final = event.get("result")
        return final

    async def _publish(self, event: dict) -> None:
        # Best-effort: the panel is observability, never a precondition for
        # answering. An adapter that can't publish (or a transport with no
        # data channel at all) must not break the turn.
        try:
            await self.adapter.publish_event(event)
        except Exception as exc:  # noqa: BLE001
            log.warning("orchestrator.publish_event_failed", error=str(exc))
