"""Turning a composed answer into something safe to say out loud.

The answer carries inline `[ev_7a3f]` citation markers — that's the whole
grounding contract and the evidence panel renders them as chips. But TTS
reads them literally, so on a live call the agent actually said:

    "Meridian is a B2B booking and scheduling platform ev 20021cda."

Strip them for speech ONLY. The structured answer that goes to the browser
keeps every marker, so nothing about "no uncited claim" changes — this is
purely the difference between what's shown and what's spoken, which the
voice rules already assume ("never read a file path or line number aloud;
it's shown on screen instead").
"""
from __future__ import annotations

import re

# Handles a lone marker, several ids inside one bracket ("[ev_a, ev_b]" —
# the compose model really does emit these), and runs of adjacent markers.
# The leading \s* eats the space before the bracket so "platform [ev_x]."
# closes up to "platform." instead of leaving "platform ."
_CITATION = re.compile(r"\s*\[\s*ev_[0-9a-f]+(?:\s*,\s*ev_[0-9a-f]+)*\s*\]", re.IGNORECASE)
_SPACE_BEFORE_PUNCT = re.compile(r"\s+([,.;:!?])")
_MULTISPACE = re.compile(r"[ \t]{2,}")


def for_speech(answer: str) -> str:
    """The answer with citation markers removed and spacing repaired."""
    if not answer:
        return ""
    spoken = _CITATION.sub("", answer)
    spoken = _SPACE_BEFORE_PUNCT.sub(r"\1", spoken)
    spoken = _MULTISPACE.sub(" ", spoken)
    return spoken.strip()
