"""Addressing: with several humans on a call, the agent must answer only
what is aimed at it — and must attribute it to the right person."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import asyncio
import time

import pytest
import orchestrator as orch
from orchestrator import Orchestrator


class Adapter:
    def __init__(self):
        self.spoken = []

    async def speak(self, text, language=None):
        self.spoken.append(text)

    async def cancel_speech(self): pass
    async def announce(self, text, language=None): self.spoken.append(text)
    async def publish_event(self, event): pass


def _orch():
    o = Orchestrator(Adapter(), "http://localhost:8000")
    o.meeting_slug = None          # don't write transcripts from unit tests
    return o


def test_unaddressed_speech_is_ignored():
    o = _orch()
    assert o._is_addressed("user:alice", "so then I told them to check the logs") is False


def test_poke_addresses_only_the_person_who_poked():
    o = _orch()
    asyncio.run(o.on_poke("user:alice", "Alice"))
    assert o._is_addressed("user:alice", "why are Northwind's webhooks failing?") is True
    # Bob talking during Alice's window is NOT for the agent.
    assert o._is_addressed("user:bob", "hang on, I'll pull up the dashboard") is False


def test_poke_window_expires():
    o = _orch()
    asyncio.run(o.on_poke("user:alice", "Alice"))
    o.state.addressed_at = time.time() - (orch.POKE_WINDOW_SECONDS + 1)
    assert o._is_addressed("user:alice", "anyway, about lunch") is False


def test_wake_word_works_for_anyone_without_a_poke():
    o = _orch()
    assert o._is_addressed("guest:client", "Photon, what does a 401 mean here?") is True
    assert o._is_addressed("guest:client", "hey Photon can you check the docs") is True


def test_guest_can_poke_too():
    o = _orch()
    asyncio.run(o.on_poke("guest:client-a", "Client A"))
    assert o._is_addressed("guest:client-a", "what changed on Thursday?") is True


def test_poke_is_consumed_by_one_turn():
    """A poke answers one question; it does not leave the mic hot."""
    o = _orch()
    asyncio.run(o.on_poke("user:alice", "Alice"))
    asyncio.run(o.on_speech("what is the retry policy?", "user:alice", True))
    assert o.state.addressed_by is None
