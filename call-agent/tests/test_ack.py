"""The spoken acknowledgement on a visual turn.

Guards the three things that make it useful rather than annoying: it fires
only when a frame is actually attached, it comes out in the caller's
language, and it rotates instead of repeating one line forever.
"""
import sys, os, time
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import asyncio
import pytest
from orchestrator import Orchestrator, SCREEN_FRAME_TTL_SECONDS
from language import ACKNOWLEDGEMENTS, acknowledgement_for


class _RecordingAdapter:
    def __init__(self):
        self.spoken = []

    async def speak(self, text, language=None):
        self.spoken.append((language, text))

    async def cancel_speech(self): pass
    async def announce(self, text): pass
    async def publish_event(self, event): pass


def _orch(adapter=None):
    return Orchestrator(adapter=adapter or _RecordingAdapter(),
                        brain_api_url="http://localhost:8000")


def test_every_language_has_acknowledgements():
    # A missing language would silently fall back to English mid-call, which
    # is worse than no filler at all.
    for code in ("en-IN", "hi-IN", "te-IN", "ta-IN"):
        assert ACKNOWLEDGEMENTS.get(code), f"no acknowledgements for {code}"


def test_unknown_language_falls_back_to_english():
    assert acknowledgement_for("fr-FR") in ACKNOWLEDGEMENTS["en-IN"]


@pytest.mark.parametrize("code", ["en-IN", "hi-IN", "te-IN", "ta-IN"])
def test_variants_rotate_and_never_repeat_back_to_back(code):
    seen = [acknowledgement_for(code, i) for i in range(len(ACKNOWLEDGEMENTS[code]))]
    assert len(set(seen)) == len(seen), f"duplicate variants for {code}"
    assert acknowledgement_for(code, 0) != acknowledgement_for(code, 1)


def test_acknowledgement_is_spoken_in_the_callers_language():
    a = _RecordingAdapter()
    o = _orch(a)
    asyncio.run(o._acknowledge("te-IN"))
    assert len(a.spoken) == 1
    language, text = a.spoken[0]
    assert language == "te-IN"
    assert text in ACKNOWLEDGEMENTS["te-IN"]


def test_consecutive_visual_turns_rotate():
    a = _RecordingAdapter()
    o = _orch(a)
    asyncio.run(o._acknowledge("en-IN"))
    asyncio.run(o._acknowledge("en-IN"))
    assert a.spoken[0][1] != a.spoken[1][1]


def test_acknowledgement_is_kept_out_of_the_transcript():
    # It is filler, not content: the transcript records what was asked and
    # answered, and this is neither.
    a = _RecordingAdapter()
    o = _orch(a)
    asyncio.run(o._acknowledge("en-IN"))
    assert o.state.transcript == []


def test_a_failing_ack_never_costs_the_answer():
    class Broken(_RecordingAdapter):
        async def speak(self, text, language=None):
            raise RuntimeError("tts down")

    o = _orch(Broken())
    asyncio.run(o._acknowledge("en-IN"))  # must not raise


def test_no_acknowledgement_without_a_live_share():
    # The ack rides on _wants_visual_context, so a turn with no fresh frame
    # must stay completely silent until the real answer arrives.
    o = _orch()
    assert o._wants_visual_context("what's on my screen") is False

    asyncio.run(o.on_frame(b"screen-bytes", "screen"))
    o.state.latest_screen_frame_at = time.time() - (SCREEN_FRAME_TTL_SECONDS + 5)
    assert o._wants_visual_context("what's on my screen") is False
