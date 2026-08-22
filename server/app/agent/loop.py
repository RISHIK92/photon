"""The agent loop: plan -> call tools -> compose -> verify -> abstain.
Plain function calling, no framework. Zero transport imports — callable
standalone with just a question string (see tests/test_agent_loop.py).
"""
from __future__ import annotations

import asyncio
import hashlib
import time

import structlog

from app.agent.llm import extract_json, generate
from app.agent.prompts import build_compose_prompt, build_plan_prompt
from app.core.llm.vision import describe_screen
from app.agent.verifier import verify
from app.seed.loader import get_seed_repo_id
from app.tools.evidence import make_evidence
from app.tools.registry import TOOL_SCHEMAS, UnknownToolError, dispatch

log = structlog.get_logger()

MAX_ROUNDS = 2
MAX_TOOL_CALLS_TOTAL = 6
MAX_CALLS_PER_ROUND = 4

_REPO_ID_TOOLS = {t["name"] for t in TOOL_SCHEMAS if "repo_id" in t["parameters"]}


async def _run_one_call(call: dict, repo_id: str | None) -> dict:
    tool_name = call.get("tool")
    args = dict(call.get("args") or {})
    if repo_id and tool_name in _REPO_ID_TOOLS:
        # Always force the loop's own resolved repo_id, never trust the
        # planner's guess — it doesn't reliably know the real UUID and a
        # wrong guess (e.g. "meridian") silently empties out code evidence
        # instead of erroring, which is much worse (caught while testing).
        args["repo_id"] = repo_id

    start = time.monotonic()
    try:
        result = await dispatch(tool_name, args)
    except UnknownToolError:
        result = {"tool": tool_name, "status": "error", "evidence": [], "note": f"unknown tool '{tool_name}'"}
    except TypeError as exc:
        result = {"tool": tool_name, "status": "error", "evidence": [], "note": f"bad arguments: {exc}"}
    except Exception as exc:  # noqa: BLE001 - a tool must never take the whole turn down
        log.error("agent.tool_call_error", tool=tool_name, error=str(exc))
        result = {"tool": tool_name, "status": "error", "evidence": [], "note": str(exc)}
    ms = int((time.monotonic() - start) * 1000)

    return {"tool": tool_name, "args": args, "result": result, "ms": ms}


def _dedupe_evidence(evidence: list[dict]) -> list[dict]:
    seen: dict[str, dict] = {}
    for e in evidence:
        seen.setdefault(e["id"], e)
    return list(seen.values())


def _no_evidence_abstention(tool_trace: list[dict]) -> str:
    tools_tried = ", ".join(sorted({t["tool"] for t in tool_trace})) or "any tools"
    return f"I don't have evidence for that. I checked {tools_tried} and found nothing relevant to your question."


async def answer_question(
    question: str,
    repo_id: str | None = None,
    screen_context: str | None = None,
    screen_image_bytes: bytes | None = None,
) -> dict:
    """The Section 4 answer contract: {answer, claims, confidence, abstained,
    escalation, tool_trace}. Safe to call with no call/session in progress.

    screen_image_bytes: a JPEG screen-share frame, if the customer is
    sharing their screen and the question plausibly needs it (caller —
    call-agent's orchestrator — decides that, not this function). Analyzed
    once via Gemini vision (app.core.llm.gemini_vision) and folded into
    the evidence set as a citable "screen" source_type item, exactly like
    a tool result — NOT passed to the LLM as raw unverifiable prose, so
    the same "no uncited claim" rule applies to what the customer sees on
    screen as to everything else.
    """
    if repo_id is None:
        repo_id = get_seed_repo_id()

    all_evidence: list[dict] = []
    tool_trace: list[dict] = []
    context_log = ""
    total_calls = 0

    if screen_image_bytes:
        start = time.monotonic()
        description = await describe_screen(screen_image_bytes, question)
        ms = int((time.monotonic() - start) * 1000)
        if description:
            frame_hash = hashlib.sha1(screen_image_bytes).hexdigest()[:10]
            screen_evidence = make_evidence("screen", f"screen:{frame_hash}", description, 1.0)
            all_evidence.append(screen_evidence)
            tool_trace.append({"tool": "describe_screen", "args": {}, "ms": ms, "evidence": [screen_evidence]})
            screen_context = description
        else:
            tool_trace.append(
                {"tool": "describe_screen", "args": {}, "ms": ms, "evidence": [], "note": "vision call failed"}
            )
            screen_context = None

    for round_num in range(MAX_ROUNDS):
        remaining = MAX_TOOL_CALLS_TOTAL - total_calls
        if remaining <= 0:
            break

        plan_prompt = build_plan_prompt(question, context_log, screen_context, is_first_round=(round_num == 0))
        raw_plan = await generate(plan_prompt, max_output_tokens=800, temperature=0.0, json_mode=True)
        plan = extract_json(raw_plan) or {}
        calls = (plan.get("calls") or [])[: min(MAX_CALLS_PER_ROUND, remaining)]

        if not calls and round_num == 0:
            # Should be rare now that the first-round prompt is directive
            # about calling something (see build_plan_prompt's nudge) — this
            # is a safety net for the cases that still slip through, not the
            # primary fix anymore. Retry once at a nonzero temperature purely
            # to escape a repeated deterministic empty output, not because
            # temperature fixes emptiness on its own (measured: it doesn't —
            # see build_plan_prompt's comment).
            log.warning("agent.empty_first_round_plan_retrying", question=question)
            raw_plan = await generate(plan_prompt, max_output_tokens=800, temperature=0.4, json_mode=True)
            plan = extract_json(raw_plan) or {}
            calls = (plan.get("calls") or [])[: min(MAX_CALLS_PER_ROUND, remaining)]

        if not calls:
            break

        outcomes = await asyncio.gather(*[_run_one_call(c, repo_id) for c in calls])
        total_calls += len(outcomes)

        round_lines = [f"--- Round {round_num + 1} tool results ---"]
        for o in outcomes:
            r = o["result"]
            all_evidence.extend(r.get("evidence", []))
            # Evidence rides along on each trace entry (not a new top-level
            # answer key — Section 4's answer contract is fixed) so the
            # evidence panel (Phase 5) can build an ev_id -> evidence map for
            # every [ev_xxx] citation chip and render a real provenance
            # strip, instead of citations pointing at nothing once the
            # tool's raw result is discarded after composition.
            tool_trace.append(
                {"tool": o["tool"], "args": o["args"], "ms": o["ms"], "evidence": r.get("evidence", [])}
            )
            round_lines.append(
                f"{o['tool']}({o['args']}) -> status={r.get('status')} "
                f"evidence_count={len(r.get('evidence', []))} note={r.get('note')}"
            )
        context_log += "\n" + "\n".join(round_lines)

    dedup_evidence = _dedupe_evidence(all_evidence)

    if not dedup_evidence:
        return {
            "answer": _no_evidence_abstention(tool_trace),
            "claims": [],
            "confidence": "low",
            "abstained": True,
            "escalation": None,
            "tool_trace": tool_trace,
        }

    compose_prompt = build_compose_prompt(question, dedup_evidence)
    raw_composed = await generate(compose_prompt, max_output_tokens=1500, temperature=0.1, json_mode=True)
    composed = extract_json(raw_composed) or {
        "answer": "I wasn't able to compose a reliable answer from the evidence I found.",
        "claims": [],
        "abstained": True,
        "escalation": None,
    }

    valid_ids = {e["id"] for e in dedup_evidence}
    result = verify(composed, valid_ids)
    result["tool_trace"] = tool_trace
    return result
