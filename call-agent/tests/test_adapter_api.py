"""Guards against the exact failure that made screen share silently dead:
`rtc.VideoStream.from_track()` is KEYWORD-ONLY, the adapter called it
positionally, the resulting TypeError happened inside a task nobody awaits,
and the whole feature failed with no error anywhere — only a
"screen_share_subscribed" line and then silence.

These are static/signature checks, so they run with no LiveKit room.
"""
import ast, inspect, os, sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from livekit import rtc

ADAPTER = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                       "adapters", "livekit_adapter.py")


def _from_track_calls(tree):
    for node in ast.walk(tree):
        if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                and node.func.attr == "from_track"):
            yield node


def test_sdk_still_requires_keyword_args():
    # If a future SDK version relaxes this, the test tells us why the
    # adapter looks over-careful rather than leaving it a mystery.
    params = inspect.signature(rtc.VideoStream.from_track).parameters
    assert all(p.kind is inspect.Parameter.KEYWORD_ONLY for p in params.values()), params


def test_adapter_calls_from_track_with_keywords_only():
    tree = ast.parse(open(ADAPTER).read())
    calls = list(_from_track_calls(tree))
    assert calls, "no VideoStream.from_track call found in the adapter"
    for call in calls:
        assert not call.args, "from_track() is keyword-only; a positional arg raises TypeError"
        assert {kw.arg for kw in call.keywords} >= {"track", "format"}


def test_stream_creation_is_inside_the_try_block():
    """from_track() must not sit outside the pump's try/except, or its
    failure is swallowed by the un-awaited task exactly as before."""
    tree = ast.parse(open(ADAPTER).read())
    pump = next(n for n in ast.walk(tree)
                if isinstance(n, ast.AsyncFunctionDef) and n.name == "_pump_screen_frames")
    guarded = [c for t in ast.walk(pump) if isinstance(t, ast.Try) for c in _from_track_calls(t)]
    assert len(guarded) == len(list(_from_track_calls(pump))), \
        "VideoStream.from_track() must be created inside the try, so a failure is logged"
