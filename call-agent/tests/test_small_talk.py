"""The classifier's whole job is to be conservative: never swallow a real
question. These cases are real utterances from live testing plus the
voice-shaped cases from server/evals/agent_eval.py's HARD set.

    cd call-agent && .venv/bin/python -m pytest tests -q
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest
from small_talk import Turn, classify

GREETINGS = [
    "Hello. How are you?",          # the exact utterance that cost 4.5s live
    "hi", "Hey Photon", "hello",
    "Good morning", "hey how's it going", "hi, how are you doing?",
]

IGNORE = [
    "One sec, the phone.",          # also from live testing
    "um", "okay", "yeah", "thanks", "got it", "sounds good",
    "hold on", "just a second", "sorry", "never mind", "bye",
    "yeah sorry",
    "yeah sorry one second",
    "let me grab my coffee",
    "ok cool thanks",
]

ANSWER = [
    # real questions, tidy and ASR-mangled
    "why does pricing have a special case for Bangalore?",
    "why is bangalore pricing different from other cities",
    "uh so the webhooks for north wind are failing can you check",
    "our Mumbai customer says their integration broke last week, why?",
    "how many times does Meridian retry a failed webhook?",
    "which accounts do you know about",
    "check my screen and help me open the search bar?",
    # statements with no interrogative at all, but clearly product work
    "northwind's webhooks are broken",
    "the docs say five retries",
    "Calico is on the partner tier",
    # a greeting that carries a real question along with it
    "hi Photon, why is Calico billed differently?",
    "hello, can you check Northwind for me",
]


@pytest.mark.parametrize("text", GREETINGS)
def test_greetings_answered_locally(text):
    assert classify(text) is Turn.GREETING


@pytest.mark.parametrize("text", IGNORE)
def test_ambient_speech_ignored(text):
    assert classify(text) is Turn.IGNORE


@pytest.mark.parametrize("text", ANSWER)
def test_real_requests_always_reach_the_pipeline(text):
    assert classify(text) is Turn.ANSWER


def test_empty_is_ignored():
    assert classify("   ") is Turn.IGNORE


def test_long_utterance_is_never_swallowed():
    # Length alone protects against a filler prefix eating a real question.
    assert classify("okay so the thing is our integration keeps returning errors") is Turn.ANSWER
