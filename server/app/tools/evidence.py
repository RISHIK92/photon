"""The tool contract (see CLAUDE.md Section 4). Every tool in app.tools
returns a dict built by tool_result()/tool_error() and every evidence item
is built by make_evidence() — this is the one place locator/id formatting
lives, so it can't drift between tools.
"""
from __future__ import annotations

import hashlib
from datetime import datetime, timezone

VALID_SOURCE_TYPES = {
    "code",
    "docs",
    "ticket",
    "slack",
    "account",
    "log",
    "commit",
    "pr",
    "incident",
    "screen",  # a live screen-share frame description (app.agent.loop), not corpus evidence
}


def _make_id(source_type: str, locator: str) -> str:
    h = hashlib.sha1(f"{source_type}:{locator}".encode()).hexdigest()[:8]
    return f"ev_{h}"


def make_evidence(source_type: str, locator: str, snippet: str, score: float = 1.0) -> dict:
    assert source_type in VALID_SOURCE_TYPES, f"unknown source_type {source_type!r}"
    return {
        "id": _make_id(source_type, locator),
        "source_type": source_type,
        "locator": locator,
        "snippet": (snippet or "")[:800],
        "score": round(float(score), 4),
        "retrieved_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }


def tool_result(tool: str, evidence: list[dict], note: str | None = None) -> dict:
    status = "ok" if evidence else "empty"
    return {
        "tool": tool,
        "status": status,
        "evidence": evidence,
        "note": note if note is not None else (None if evidence else "no evidence found"),
    }


def tool_error(tool: str, note: str) -> dict:
    return {"tool": tool, "status": "error", "evidence": [], "note": note}
