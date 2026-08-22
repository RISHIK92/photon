"""The one TransportAdapter implementation we ship. Wraps a LiveKit Agents
1.x AgentSession: joins the room, wires Deepgram STT/TTS + Silero VAD,
intercepts every user turn to hand off to the orchestrator instead of
letting LiveKit's own LLM node run, and separately watches for a
screen-share video track (source == SCREEN_SHARE, never the camera track)
to feed on_frame at a low, state-dependent frame rate.

Everything platform-specific lives in this one file. adapters/base.py is
the only thing orchestrator.py depends on.
"""
from __future__ import annotations

import asyncio
import io
import json
import time

import structlog
from livekit import agents, rtc
from livekit.agents import StopResponse
from livekit.plugins import deepgram, silero

from adapters.base import SessionCallbacks

log = structlog.get_logger()

ANNOUNCEMENT = (
    "Hi, I'm Meridian's support agent. I'm listening and taking notes — "
    "let me know if you'd like me off."
)

# Topic the browser filters on (client/app/call/TraceBridge.tsx) so trace
# events never get confused with chat or any other data traffic.
TRACE_TOPIC = "photon.trace"

_SCREEN_FRAME_INTERVAL_SPEAKING = 1.0  # ~1 fps while someone is speaking
_SCREEN_FRAME_INTERVAL_IDLE = 1.0 / 0.3  # ~0.3 fps otherwise
_SCREEN_FRAME_MAX_DIM = 1024


class _InterceptAgent(agents.Agent):
    """Every turn is handed to the orchestrator via on_speech; StopResponse
    always prevents LiveKit's own (unconfigured) LLM node from also trying
    to generate a reply — this agent never composes an answer itself."""

    def __init__(self, callbacks: SessionCallbacks, speaker_id: str):
        super().__init__(instructions="unused — this agent never generates its own replies")
        self._callbacks = callbacks
        self._speaker_id = speaker_id

    async def on_user_turn_completed(self, turn_ctx, new_message) -> None:
        text = (new_message.text_content or "").strip()
        if text:
            await self._callbacks.on_speech(text, self._speaker_id, is_final=True)
        raise StopResponse()


class LiveKitAdapter:
    """Implements TransportAdapter (speak/cancel_speech/announce)."""

    def __init__(self, ctx: agents.JobContext, callbacks: SessionCallbacks):
        self._ctx = ctx
        self._callbacks = callbacks
        self._session: agents.AgentSession | None = None
        self._screen_task: asyncio.Task | None = None

    async def start(self) -> None:
        await self._ctx.connect()

        self._session = agents.AgentSession(
            stt=deepgram.STT(model="nova-3"),
            tts=deepgram.TTS(model="aura-2-thalia-en"),
            vad=silero.VAD.load(),
        )
        agent = _InterceptAgent(self._callbacks, speaker_id=self._local_speaker_id())

        self._ctx.room.on("track_subscribed", self._on_track_subscribed)
        # `track_subscribed` only fires for tracks that arrive AFTER this
        # handler is attached — and ctx.connect() above has already run, so
        # a participant who was ALREADY sharing their screen when the agent
        # joined would never produce a single frame. That is the common
        # case whenever the worker restarts or the agent is re-dispatched
        # into a call that is already in progress, so sweep for existing
        # screen-share tracks explicitly.
        self._attach_existing_screenshare()

        await self._session.start(
            agent=agent,
            room=self._ctx.room,
            room_input_options=agents.RoomInputOptions(video_enabled=True),
        )
        await self.announce(ANNOUNCEMENT)

    def _local_speaker_id(self) -> str:
        return self._ctx.room.local_participant.identity or "unknown"

    def _attach_existing_screenshare(self) -> None:
        for participant in self._ctx.room.remote_participants.values():
            for publication in participant.track_publications.values():
                if (
                    publication.source == rtc.TrackSource.SOURCE_SCREENSHARE
                    and publication.subscribed
                    and publication.track is not None
                ):
                    log.info(
                        "livekit_adapter.screen_share_already_active",
                        participant=participant.identity,
                    )
                    self._start_screen_pump(publication.track)

    def _start_screen_pump(self, track: rtc.Track) -> None:
        # Replacing a live task would leak the old one; stop it first. This
        # happens when a customer stops and restarts sharing mid-call.
        if self._screen_task and not self._screen_task.done():
            self._screen_task.cancel()
        self._screen_task = asyncio.create_task(self._pump_screen_frames(track))

    def _on_track_subscribed(
        self,
        track: rtc.Track,
        publication: rtc.RemoteTrackPublication,
        participant: rtc.RemoteParticipant,
    ) -> None:
        if track.kind != rtc.TrackKind.KIND_VIDEO:
            return
        if publication.source != rtc.TrackSource.SOURCE_SCREENSHARE:
            return  # never feed the camera track in here — see module docstring
        log.info("livekit_adapter.screen_share_subscribed", participant=participant.identity)
        self._start_screen_pump(track)

    async def _pump_screen_frames(self, track: rtc.Track) -> None:
        try:
            from PIL import Image
        except ImportError:
            log.warning("livekit_adapter.pillow_missing_skipping_frames")
            return

        # NOTE the keyword: from_track() is keyword-ONLY in livekit rtc.
        # Passing the track positionally raises TypeError — and because
        # this used to sit outside the try/except below, inside a task
        # nobody awaits, that exception vanished completely: the
        # screen_share_subscribed log line appeared, zero frames arrived,
        # and no error was ever printed. Caught only by testing the real
        # signature. Everything from here down is inside the try for that
        # reason: a pump that dies must say so.
        last_sent = 0.0
        stream = None
        try:
            stream = rtc.VideoStream.from_track(track=track, format=rtc.VideoBufferType.RGBA)
            log.info("livekit_adapter.screen_pump_started")
            frames_seen = 0
            async for event in stream:
                frame = event.frame
                interval = (
                    _SCREEN_FRAME_INTERVAL_SPEAKING
                    if self._session and self._session.user_state == "speaking"
                    else _SCREEN_FRAME_INTERVAL_IDLE
                )
                now = time.monotonic()
                if now - last_sent < interval:
                    continue
                last_sent = now

                img = Image.frombytes("RGBA", (frame.width, frame.height), bytes(frame.data)).convert("RGB")
                img.thumbnail((_SCREEN_FRAME_MAX_DIM, _SCREEN_FRAME_MAX_DIM))
                buf = io.BytesIO()
                img.save(buf, format="JPEG", quality=70)
                await self._callbacks.on_frame(buf.getvalue(), "screen")
                frames_seen += 1
                if frames_seen == 1 or frames_seen % 30 == 0:
                    # Silence used to be indistinguishable from "working
                    # fine, nobody asked a visual question yet".
                    log.info("livekit_adapter.screen_frames_flowing", frames=frames_seen,
                             size_bytes=len(buf.getvalue()))
        except Exception as exc:  # noqa: BLE001 - a frame-pump failure must not take the call down
            log.error("livekit_adapter.screen_pump_error", error=type(exc).__name__ + ": " + str(exc))
        finally:
            if stream is not None:
                await stream.aclose()

    # ── TransportAdapter ─────────────────────────────────────────────────

    async def speak(self, text: str) -> None:
        if not self._session:
            log.warning("livekit_adapter.speak_before_start", text=text)
            return
        self._session.say(text)

    async def cancel_speech(self) -> None:
        if not self._session:
            return
        self._session.interrupt()

    async def announce(self, text: str) -> None:
        await self.speak(text)

    async def publish_event(self, event: dict) -> None:
        """Broadcast one trace event to every participant over LiveKit's
        data channel. Reliable, since a dropped tool.done would leave the
        panel showing a tool as still running forever."""
        try:
            await self._ctx.room.local_participant.publish_data(
                json.dumps(event), reliable=True, topic=TRACE_TOPIC
            )
        except Exception as exc:  # noqa: BLE001 - a UI event must never take the call down
            log.warning("livekit_adapter.publish_event_failed", type=event.get("type"), error=str(exc))
