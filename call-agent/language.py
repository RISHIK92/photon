"""Which language is the caller speaking, and what should we answer in?

Detection is by Unicode script, not by a model or an API call: Telugu,
Tamil and Devanagari occupy disjoint code-point ranges, so a caller
speaking Telugu produces Telugu characters and there is nothing to infer.
Zero latency, no key, no network, and it works identically whichever STT
vendor is in front of it — which matters because the whole point of this
module is to sit between two swappable stacks (Deepgram and Sarvam).

Its one real limitation: it needs STT to emit NATIVE SCRIPT. Sarvam's
saaras/saarika do. If an STT romanises Telugu as Latin text ("meeru ela
unnaru"), every heuristic here sees Latin and says English — so
`AGENT_REPLY_LANGUAGE` exists to pin the language explicitly when the
transcript can't be trusted to carry it.
"""
from __future__ import annotations

import unicodedata

# Sarvam's BCP-47 codes (see SarvamTTSLanguages) mapped to the Unicode
# block that identifies them. Devanagari is shared by Hindi and Marathi;
# it resolves to Hindi, which is the safe default for a support call and
# the language actually asked for here.
_SCRIPTS: list[tuple[str, str, range]] = [
    ("te-IN", "Telugu", range(0x0C00, 0x0C80)),
    ("ta-IN", "Tamil", range(0x0B80, 0x0C00)),
    ("hi-IN", "Hindi", range(0x0900, 0x0980)),      # Devanagari
    ("bn-IN", "Bengali", range(0x0980, 0x0A00)),
    ("pa-IN", "Punjabi", range(0x0A00, 0x0A80)),    # Gurmukhi
    ("gu-IN", "Gujarati", range(0x0A80, 0x0B00)),
    ("od-IN", "Odia", range(0x0B00, 0x0B80)),
    ("kn-IN", "Kannada", range(0x0C80, 0x0D00)),
    ("ml-IN", "Malayalam", range(0x0D00, 0x0D80)),
]

DEFAULT_LANGUAGE = "en-IN"
_NAMES = {code: name for code, name, _ in _SCRIPTS} | {"en-IN": "English"}

# Below this share of letters, a stray Indic character (a name, an emoji-
# like glyph, one mis-transcribed word) shouldn't flip the whole reply's
# language. Code-mixed speech is the norm on Indian support calls — "sir
# webhook fail అవుతోంది" is Telugu with English nouns, and should be
# answered in Telugu, so the bar is a plurality of letters, not a majority.
_MIN_SCRIPT_SHARE = 0.20


def detect_language(text: str, default: str = DEFAULT_LANGUAGE) -> str:
    """Best-effort BCP-47 code for the language `text` is written in."""
    if not text:
        return default

    counts: dict[str, int] = {}
    letters = 0
    for char in text:
        if not unicodedata.category(char).startswith("L"):
            continue  # skip digits, spaces, punctuation — they carry no script
        letters += 1
        for code, _name, block in _SCRIPTS:
            if ord(char) in block:
                counts[code] = counts.get(code, 0) + 1
                break

    if not letters or not counts:
        return default

    code, count = max(counts.items(), key=lambda kv: kv[1])
    return code if count / letters >= _MIN_SCRIPT_SHARE else default


def language_name(code: str) -> str:
    """Human-readable name, for telling the compose LLM what to write in."""
    return _NAMES.get(code, "English")


# Spoken instantly on a greeting, with no LLM in the loop — so it has to
# be pre-written per language rather than generated.
GREETINGS = {
    "en-IN": "Hi — I'm here and listening. Ask me anything whenever you're ready.",
    "hi-IN": "नमस्ते — मैं यहाँ हूँ और सुन रहा हूँ। जो भी पूछना हो, पूछिए।",
    "te-IN": "నమస్కారం — నేను ఇక్కడే ఉన్నాను, వింటున్నాను. ఏదైనా అడగండి.",
    "ta-IN": "வணக்கம் — நான் இங்கே இருக்கிறேன், கேட்டுக்கொண்டிருக்கிறேன். எதுவும் கேளுங்கள்.",
}


def greeting_for(code: str) -> str:
    return GREETINGS.get(code, GREETINGS["en-IN"])
