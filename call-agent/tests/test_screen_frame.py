"""Screen-frame buffering rules — a stale frame must never be sent."""
import sys, os, time
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import asyncio
import pytest
from orchestrator import Orchestrator, SCREEN_FRAME_TTL_SECONDS


class _NullAdapter:
    async def speak(self, text, language=None): pass
    async def cancel_speech(self): pass
    async def announce(self, text, language=None): pass
    async def publish_event(self, event): pass


def _orch():
    return Orchestrator(_NullAdapter(), "http://localhost:8000")


def test_camera_frames_are_never_treated_as_screen():
    o = _orch()
    asyncio.run(o.on_frame(b"camera-bytes", "camera"))
    assert o.state.latest_screen_frame is None


def test_fresh_screen_frame_is_used():
    o = _orch()
    asyncio.run(o.on_frame(b"screen-bytes", "screen"))
    assert o._wants_visual_context("what's on my screen") is True


def test_stale_screen_frame_is_dropped_not_sent():
    o = _orch()
    asyncio.run(o.on_frame(b"screen-bytes", "screen"))
    # Customer stopped sharing a while ago: the pump ended, but the last
    # frame is still buffered.
    o.state.latest_screen_frame_at = time.time() - (SCREEN_FRAME_TTL_SECONDS + 5)
    assert o._wants_visual_context("what's on my screen") is False
    assert o.state.latest_screen_frame is None  # and it's cleared, not left to rot


def test_visual_question_without_any_frame_is_not_visual():
    o = _orch()
    assert o._wants_visual_context("what's on my screen") is False


def test_non_visual_question_never_attaches_a_frame():
    o = _orch()
    asyncio.run(o.on_frame(b"screen-bytes", "screen"))
    assert o._wants_visual_context("why does pricing have a special case for Bangalore?") is False
