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
from language import (
    DEFAULT_LANGUAGE,
    acknowledgement_for,
    detect_language,
    greeting_for,
)
from small_talk import Turn, classify
from speech import for_speech

log = structlog.get_logger()

# Broadened after the original pattern missed a real utterance ("check my
# screen and help me open the search bar?") — "check/look at my screen",
# "share my screen", "help me find/open/see", "what's on (my) screen" all
# now match, not just the original narrow "where do i"/"this screen" set.
# Saying its name is the fallback for anyone not using our join page (a
# phone/SIP caller, another client). Note the real limitation: LiveKit's
# session listens to one linked participant at a time, so a wake word is
# only heard from whoever is currently linked — the button is what makes
# addressing work for everyone else.
def wake_word_re(agent_name: str) -> re.Pattern:
    """The wake word IS the agent's name, so it has to be built per call.

    A workspace that renamed its agent to Ava has people saying "Ava, …" —
    listening for "Photon" would mean the wake word simply never fires for
    them, silently, and only the button would work.
    """
    return re.compile(rf"^\s*(hey\s+|ok\s+)?{re.escape(agent_name)}\b[\s,:-]*", re.IGNORECASE)


DEFAULT_AGENT_NAME = "Photon"

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
    # Filled in by on_poke (a poke packet carries the sender's display
    # name), so a transcript line can say "Priya" instead of a raw LiveKit
    # identity. Not used for gating anymore — open mic answers whoever is
    # linked regardless of whether they've ever poked.
    names: dict = field(default_factory=dict)
    # Counts visual turns only, so the spoken acknowledgement rotates
    # through its variants rather than repeating one line every time
    # somebody asks about their screen.
    visual_turns: int = 0


class Orchestrator:
    """Implements SessionCallbacks. Holds no transport objects of its own —
    just a TransportAdapter reference to act through."""

    def __init__(
        self,
        adapter: TransportAdapter,
        brain_api_url: str,
        meeting_slug: str | None = None,
        agent_name: str | None = None,
    ):
        self.adapter = adapter
        self.brain_api_url = brain_api_url.rstrip("/")
        # The LiveKit room name IS the meeting slug (abcd-efgh), so the
        # room, the share link and the transcript are one identifier.
        self.meeting_slug = meeting_slug
        self.agent_name = (agent_name or "").strip() or DEFAULT_AGENT_NAME
        self._wake_word = wake_word_re(self.agent_name)
        self.state = TurnState()
        self._http = httpx.AsyncClient(timeout=90.0)

    async def close(self) -> None:
        await self._http.aclose()

    # ── SessionCallbacks ──────────────────────────────────────────────────

    async def on_poke(self, speaker_id: str, display_name: str) -> None:
        # The actual mic re-link already happened in the adapter
        # (set_participant, before this callback fires) — this just
        # records the display name for transcript lines.
        self.state.names[speaker_id] = display_name
        log.info("orchestrator.poked", speaker_id=speaker_id, name=display_name)

    async def on_speech(self, text: str, speaker_id: str, is_final: bool) -> None:
        """Open mic: every finalized utterance from the currently linked
        participant is answered — no wake word or poke required, per
        explicit product request. Poke (`on_poke` above) and the wake word
        still matter for what they ALSO do: `on_poke` re-links which
        participant `AgentSession` listens to on a multi-party call (see
        livekit_adapter.py's `set_participant`) — a separate question from
        whether to answer, which is now always yes for whoever is linked.
        """
        if not is_final or not text.strip():
            return

        speaker_name = self.state.names.get(speaker_id, speaker_id)
        self.state.transcript.append({"speaker_id": speaker_id, "text": text, "ts": time.time()})
        log.info("orchestrator.speech_finalized", speaker_id=speaker_id, text=text)

        await self._record_transcript("human", speaker_name, text, speaker_id)

        await self._handle_turn(self._wake_word.sub("", text.strip(), count=1).strip() or text)

    async def _record_transcript(
        self, role: str, speaker_name: str, text: str, speaker_identity: str | None = None
    ) -> None:
        """Best-effort: a transcript write must never delay or break a call."""
        if not self.meeting_slug:
            return
        try:
            await self._http.post(
                f"{self.brain_api_url}/api/meetings/{self.meeting_slug}/transcript",
                json={
                    "role": role,
                    "speaker_name": speaker_name,
                    "speaker_identity": speaker_identity,
                    "text": text,
                },
                timeout=10.0,
            )
        except Exception as exc:  # noqa: BLE001
            log.warning("orchestrator.transcript_write_failed", error=str(exc))

    async def on_frame(self, image: bytes, source: str) -> None:
        if source != "screen":
            return
        self.state.latest_screen_frame = image
        self.state.latest_screen_frame_at = time.time()

    # ── internals ─────────────────────────────────────────────────────────

    def _wants_visual_context(self, question: str) -> bool:
        """An ACTIVE screen share is the signal — not the wording of the question.

        This used to also require VISUAL_HINT_RE to match, and that keyword
        gate silently ate every real screen-share turn we have logged:

          - "See, I have shared the screen right here" missed, because the
            pattern wants `share` followed by a space and the caller said
            "shared";
          - every Indic-language turn missed unconditionally, because the
            pattern is ASCII-only — so the vision path and the multilingual
            path were mutually exclusive, which nobody intended.

        Both are the same class of bug: a keyword list is a PROXY for "is
        this about the screen", and a proxy that fails does so silently and
        looks exactly like the agent having no data. Meanwhile "is the
        customer sharing their screen RIGHT NOW" is a stronger signal, is
        free, and is language-independent.

        Small talk never reaches here (_handle_turn returns early on any
        non-ANSWER intent), so this only ever fires on a real question. The
        cost of attaching a frame that turns out to be irrelevant is one
        vision call (~1.3s); the cost of missing one is the agent saying "I
        don't have information" while looking straight at the answer. Same
        asymmetry small_talk.py is built around.

        The TTL below is what keeps this honest: a frame is only attached
        while a share is genuinely live, so a stale frame can never be
        described as the current screen.
        """
        if self.state.latest_screen_frame is None:
            return False
        age = time.time() - self.state.latest_screen_frame_at
        if age > SCREEN_FRAME_TTL_SECONDS:
            log.info("orchestrator.screen_frame_stale", age_seconds=round(age, 1))
            self.state.latest_screen_frame = None
            return False
        log.info("orchestrator.screen_frame_attached", age_seconds=round(age, 1))
        return True

    async def _acknowledge(self, language: str) -> None:
        """Say "okay, let me look" before a visual turn does its extra work.

        A visual turn costs roughly 1.3s of vision on top of a normal one,
        and that time is silent — which reads as the agent having missed the
        question, so people repeat themselves and talk over the answer.

        Fired only on the vision path, because that is the only path with
        the extra second to cover. It is queued, not spoken over the answer:
        the adapter's say() calls play in order, so this lands first and the
        real answer follows it.

        Best-effort by design — a filler is a nicety, and losing it must
        never cost the caller their actual answer.
        """
        text = acknowledgement_for(language, self.state.visual_turns)
        self.state.visual_turns += 1
        try:
            await self.adapter.speak(text, language=language)
        except Exception as exc:  # noqa: BLE001
            log.warning("orchestrator.ack_failed", error=str(exc))
            return
        # Deliberately NOT written to the transcript: the transcript is the
        # record of what was asked and answered, and "one moment" is neither.
        log.info("orchestrator.ack_spoken", language=language, text=text)

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
            await self._acknowledge(language)

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
            spoken = for_speech(answer)
            await self._record_transcript("agent", self.agent_name, spoken)
            await self.adapter.speak(spoken, language=language)
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
            await self._record_transcript("agent", self.agent_name, answer)
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
                "meeting_slug": self.meeting_slug,
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
