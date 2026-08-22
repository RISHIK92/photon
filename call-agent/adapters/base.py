"""The transport boundary (CLAUDE.md Section 5 / build plan Section 5).

Three methods, two callbacks. That's the whole interface a call platform
has to satisfy for the Company Brain to work over it:

- `TransportAdapter` — implemented by a platform-specific adapter
  (`livekit_adapter.py` today; a hypothetical `recall_adapter.py` for
  Zoom/Meet/Teams later, same shape). Called BY the orchestrator to act:
  speak a line, cancel mid-utterance on barge-in, or make a one-off
  announcement.
- `SessionCallbacks` — implemented by the orchestrator (`orchestrator.py`).
  Called BY the adapter to report events: a piece of finalized/interim
  speech was heard, or a video frame arrived (tagged screen vs camera so
  the orchestrator can ignore a stray webcam frame).

`orchestrator.py` imports this module (it's the shared contract) but never
a concrete adapter — it only ever holds a `TransportAdapter`-shaped
reference and calls the three methods. The actual transport-blindness
constraint lives one level up: the Company Brain (`server/app/agent`,
`server/app/tools`) talks to this whole service over plain HTTP and must
never import anything from `call-agent/` at all.
"""
from __future__ import annotations

from typing import Literal, Protocol


class SessionCallbacks(Protocol):
    async def on_speech(self, text: str, speaker_id: str, is_final: bool) -> None: ...

    async def on_frame(self, image: bytes, source: Literal["screen", "camera"]) -> None: ...


class TransportAdapter(Protocol):
    async def speak(self, text: str) -> None: ...

    async def cancel_speech(self) -> None: ...

    async def announce(self, text: str) -> None: ...
