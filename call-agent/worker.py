"""Entrypoint. `python3 worker.py dev` (or `start` for prod) joins whatever
LiveKit room this worker gets dispatched to, wires the LiveKit adapter to a
fresh Orchestrator per job, and runs until the room closes.

Reference: LiveKit's own Agents quickstart shapes the entrypoint/
WorkerOptions boilerplate below (job dispatch, connect, run-forever) — this
file is our own, written against the actual 1.7 API, not copied from it.
"""
from __future__ import annotations

import asyncio
import os

import structlog
from dotenv import load_dotenv
from livekit import agents, rtc

from adapters.livekit_adapter import LiveKitAdapter
from orchestrator import Orchestrator

load_dotenv()
log = structlog.get_logger()

BRAIN_API_URL = os.environ.get("BRAIN_API_URL", "http://localhost:8000")


async def entrypoint(ctx: agents.JobContext) -> None:
    log.info("worker.job_starting", room=ctx.room.name)

    orchestrator: Orchestrator | None = None
    adapter: LiveKitAdapter | None = None
    try:
        # Orchestrator needs a TransportAdapter reference before it exists,
        # and the adapter needs an object implementing SessionCallbacks
        # before IT exists — break the cycle by handing the orchestrator a
        # thin forwarding shim, then pointing it at the real adapter once
        # LiveKitAdapter.start() has constructed the AgentSession.
        class _Callbacks:
            async def on_speech(self, text: str, speaker_id: str, is_final: bool) -> None:
                await orchestrator.on_speech(text, speaker_id, is_final)

            async def on_frame(self, image: bytes, source: str) -> None:
                await orchestrator.on_frame(image, source)

        adapter = LiveKitAdapter(ctx, _Callbacks())
        orchestrator = Orchestrator(adapter, BRAIN_API_URL)

        await adapter.start()
        log.info("worker.session_started", room=ctx.room.name)

        # BUG (caught live, not in review): adapter.start() returns as soon
        # as the AgentSession is up and the announcement has played — it
        # does not block for the life of the call. Without this wait,
        # falling through to `finally` immediately closed the
        # orchestrator's httpx client while the session kept running in
        # the background, so every real question after startup failed with
        # "Cannot send a request, as the client has been closed." and the
        # agent spoke the fallback error instead of a real answer. Block
        # here until the room actually disconnects.
        disconnected = asyncio.Event()
        ctx.room.on("disconnected", lambda *_: disconnected.set())
        if ctx.room.connection_state != rtc.ConnectionState.CONN_CONNECTED:
            disconnected.set()
        await disconnected.wait()
        log.info("worker.room_disconnected", room=ctx.room.name)

    except Exception:
        log.exception("worker.job_failed", room=ctx.room.name)
        raise
    finally:
        if orchestrator:
            await orchestrator.close()


if __name__ == "__main__":
    agents.cli.run_app(
        agents.WorkerOptions(
            entrypoint_fnc=entrypoint,
            ws_url=os.environ.get("LIVEKIT_URL"),
            api_key=os.environ.get("LIVEKIT_API_KEY"),
            api_secret=os.environ.get("LIVEKIT_API_SECRET"),
        )
    )
