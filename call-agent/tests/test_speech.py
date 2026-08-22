import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest
from speech import for_speech

CASES = [
    # the exact line the agent spoke on the live call
    ("Hello! Meridian is a B2B booking and scheduling platform [ev_20021cda]. How can I help you today?",
     "Hello! Meridian is a B2B booking and scheduling platform. How can I help you today?"),
    # multiple ids in one bracket - the compose model really emits these
    ("Bangalore gets preferential rates [ev_80abd768, ev_4879aa12].",
     "Bangalore gets preferential rates."),
    # several markers across sentences
    ("Your endpoint returns 401 [ev_7a3f]. The secret rotated on Aug 14 [ev_2b91].",
     "Your endpoint returns 401. The secret rotated on Aug 14."),
    # adjacent markers
    ("Partner tier applies here [ev_aaa111][ev_bbb222].", "Partner tier applies here."),
    # mid-sentence marker keeps the sentence readable
    ("The rate is 0.88 [ev_abc123] for partner accounts.",
     "The rate is 0.88 for partner accounts."),
    # nothing to strip
    ("I don't have evidence for that.", "I don't have evidence for that."),
    ("", ""),
]


@pytest.mark.parametrize("raw,expected", CASES)
def test_markers_are_stripped_for_speech(raw, expected):
    assert for_speech(raw) == expected


def test_no_marker_syntax_survives():
    import re
    out = for_speech("A [ev_1a2b] B [ev_3c4d, ev_5e6f] C [ev_beef01]")
    assert "ev_" not in out and "[" not in out and "]" not in out


def test_unrelated_brackets_are_left_alone():
    # Only citation markers go; other bracketed text is the answer's own.
    assert for_speech("The field [webhook_url] is empty [ev_1a2b].") == "The field [webhook_url] is empty."
