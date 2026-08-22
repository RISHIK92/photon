"""The agent loop: plan -> call tools -> compose -> verify -> abstain.
Plain function calling, no framework. Zero transport imports — callable
standalone with just a question string (see tests/test_agent_loop.py).
"""
from __future__ import annotations

import asyncio
import hashlib
import time

import structlog

from app.agent.events import EventSink, TurnTracer
from app.agent.llm import extract_json, generate
from app.agent.personas import personas_prompt
from app.agent.prompts import build_compose_prompt, build_plan_prompt
from app.core.llm.vision import describe_screen
from app.agent.verifier import verify
from app.seed.loader import get_seed_repo_id
from app.services.workspace_repos import list_ready_repos
from app.tools.evidence import make_evidence
from app.tools.registry import TOOL_SCHEMAS, UnknownToolError, dispatch

log = structlog.get_logger()

MAX_ROUNDS = 2
COMPOSE_EVIDENCE_LIMIT = 6
MAX_TOOL_CALLS_TOTAL = 6
MAX_CALLS_PER_ROUND = 4

_REPO_ID_TOOLS = {t["name"] for t in TOOL_SCHEMAS if "repo_id" in t["parameters"]}

# Tools that read tenant-owned data. workspace_id is FORCED by the loop and
# deliberately absent from the schema the planner sees: it is not a choice
# the model should be able to make, and a hallucinated workspace id would be
# a cross-tenant read rather than a merely wrong answer.
# Two different things, easy to confuse (they were, once — a merge left the
# connector injection unreachable and search_custom_docs silently returned
# "no connection" for a workspace that had documents indexed):
#
#   _WORKSPACE_ID_TOOLS       connector-backed tools that read TENANT data
#                             and are meaningless without a workspace.
#   _WORKSPACE_SEARCHABLE_TOOLS  repo tools that can search across all of a
#                             workspace's repos when no single repo was
#                             resolved (defined below, used inside the
#                             repo_id branch).
_WORKSPACE_ID_TOOLS = {
    "search_slack",
    "search_jira",
    "search_linear",
    "search_notion",
    "search_datadog",
    "search_custom_docs",
}
# The only tools that can fall back to searching every repo in a workspace
# at once (plain vector search, filterable by workspace_id) rather than
# needing one specific repo (a Neo4j graph walk, a per-repo provenance
# chain, a file read).
_WORKSPACE_SEARCHABLE_TOOLS = {"search_code", "find_usages"}


async def _run_one_call(
    call: dict,
    repo_id: str | None,
    tracer: TurnTracer,
    call_id: str,
    round_num: int,
    workspace_id: str | None = None,
    known_repo_ids: set[str] | None = None,
    allowed_tools: set[str] | None = None,
) -> dict:
    tool_name = call.get("tool")
    args = dict(call.get("args") or {})
    if tool_name in _REPO_ID_TOOLS:
        if repo_id:
            # Single-repo mode: always force the loop's own resolved
            # repo_id, never trust the planner's guess — it doesn't
            # reliably know the real UUID and a wrong guess (e.g.
            # "meridian") silently empties out code evidence instead of
            # erroring, which is much worse (caught while testing).
            args["repo_id"] = repo_id
        else:
            # Multi-repo mode: no single repo was resolved up front, so
            # trust the planner's repo_id ONLY if it's one of this
            # workspace's actual repo ids (from the known_repos list in
            # the plan prompt) — same "never trust a guess" principle,
            # just extended to a set of valid ids instead of a single one.
            guessed = args.get("repo_id")
            if known_repo_ids and guessed in known_repo_ids:
                args["repo_id"] = guessed
            else:
                args.pop("repo_id", None)
            if workspace_id and tool_name in _WORKSPACE_SEARCHABLE_TOOLS:
                args["workspace_id"] = workspace_id

    if allowed_tools is not None and tool_name not in allowed_tools:
        # The planner should not have seen this tool at all; refusing here
        # too means a prompt-injection or a stale plan cannot reach a source
        # the call was configured to exclude.
        tracer.emit("tool.blocked", id=call_id, tool=tool_name, round=round_num)
        return {
            "tool": tool_name,
            "args": args,
            "result": {"tool": tool_name, "status": "error", "evidence": [],
                       "note": f"{tool_name} is not enabled for this call"},
            "ms": 0,
        }

    if tool_name in _WORKSPACE_ID_TOOLS:
        # Always overwrite, never default: a planner-supplied value here
        # would be a tenant boundary decided by an LLM. Deliberately outside
        # the repo_id branch above — connector tools have nothing to do with
        # repos, and nesting this under it is exactly how it went missing.
        args["workspace_id"] = workspace_id

    # Emitted BEFORE the await, so a client sees "search_code running…"
    # for the whole time it actually runs rather than only learning about
    # it once it's already finished.
    tracer.emit("tool.start", id=call_id, tool=tool_name, args=args, round=round_num)

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
    tracer.emit(
        "tool.done",
        id=call_id,
        tool=tool_name,
        ms=ms,
        status=result.get("status"),
        evidence_count=len(result.get("evidence", [])),
        note=result.get("note"),
    )

    return {"tool": tool_name, "args": args, "result": result, "ms": ms}


def _select_compose_evidence(tool_trace: list[dict], limit: int) -> list[dict]:
    """The evidence that actually goes into the compose prompt, capped.

    Round-robin across tools rather than taking the first N of a flat list:
    evidence is appended tool by tool, so a plain slice would hand the
    whole budget to whichever tool happened to run first and could drop
    the second tool's best item entirely — exactly the Slack message the
    S2 answer depends on. Each tool contributes its top result first, then
    its second, and so on.
    """
    per_tool = [t.get("evidence") or [] for t in tool_trace if t.get("evidence")]
    picked: list[dict] = []
    seen: set[str] = set()
    for rank in range(max((len(e) for e in per_tool), default=0)):
        for ev_list in per_tool:
            if rank >= len(ev_list):
                continue
            item = ev_list[rank]
            if item["id"] in seen:
                continue
            seen.add(item["id"])
            picked.append(item)
            if len(picked) >= limit:
                return picked
    return picked


def _dedupe_evidence(evidence: list[dict]) -> list[dict]:
    seen: dict[str, dict] = {}
    for e in evidence:
        seen.setdefault(e["id"], e)
    return list(seen.values())


# The abstention is built without an LLM (that's the point — it must be
# reliable when everything else failed), so a non-English caller can only
# be answered in their language if the sentence is pre-written. Keyed to
# the same BCP-47 codes the voice stack uses.
_ABSTENTION = {
    "en-IN": "I don't have evidence for that — nothing I searched turned up anything relevant.",
    "hi-IN": "मेरे पास इसका कोई प्रमाण नहीं है — मुझे कुछ भी प्रासंगिक नहीं मिला।",
    "te-IN": "దీనికి నా దగ్గర ఆధారం లేదు — సంబంధించిన సమాచారం ఏమీ దొరకలేదు.",
    "ta-IN": "இதற்கு என்னிடம் ஆதாரம் இல்லை — தொடர்புடைய தகவல் எதுவும் கிடைக்கவில்லை.",
}


def _no_evidence_abstention(tool_trace: list[dict], language: str | None = None) -> str:
    """Deliberately does NOT name the tools it tried.

    It used to ("I checked search_code, search_docs and found nothing"),
    which broke the voice rule "lead with the finding, not the method" —
    heard live, the agent read internal tool names aloud mid-sentence, in
    Telugu. The tools are already shown as pills in the evidence panel,
    where they belong. It also used to say "I checked any tools" when no
    tool ran at all, which was simply broken English.
    """
    return _ABSTENTION.get(language or "en-IN", _ABSTENTION["en-IN"])


async def answer_question(
    question: str,
    repo_id: str | None = None,
    screen_context: str | None = None,
    screen_image_bytes: bytes | None = None,
    on_event: EventSink | None = None,
    language: str | None = None,
    workspace_id: str | None = None,
    allowed_tools: set[str] | None = None,
    bot_types: list[str] | None = None,
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

    on_event: optional sink for real-time stage/tool/latency events (see
    app.agent.events). Purely observational — the answer is byte-for-byte
    identical with or without it, and the loop never learns who's
    listening, so the transport-free rule still holds.

    workspace_id: only consulted when repo_id is omitted. With no repo_id
    and no workspace_id, falls back to the single seed repo (the original,
    pre-multi-tenant behavior). With a workspace_id and exactly one READY
    repo, that repo is resolved the same forced way a passed-in repo_id
    would be — no ambiguity, nothing changes. With 2+ READY repos, the
    loop switches to multi-repo mode: the plan prompt lists them
    (app.agent.prompts' known_repos block) so the planner can name one
    explicitly, and workspace-searchable tools fall back to searching
    every repo in the workspace when it doesn't.
    """
    known_repos: list[dict] = []
    if repo_id is None:
        if workspace_id:
            known_repos = await list_ready_repos(workspace_id)
            if len(known_repos) <= 1:
                repo_id = known_repos[0]["id"] if known_repos else None
                known_repos = []
        else:
            repo_id = get_seed_repo_id()
    known_repo_ids = {r["id"] for r in known_repos}

    tracer = TurnTracer(on_event)
    tracer.emit("turn.start", question=question)

    all_evidence: list[dict] = []
    tool_trace: list[dict] = []
    context_log = ""
    total_calls = 0

    if screen_image_bytes:
        tracer.emit("vision.start", bytes=len(screen_image_bytes))
        start = time.monotonic()
        description = await describe_screen(screen_image_bytes, question)
        ms = int((time.monotonic() - start) * 1000)
        tracer.emit("vision.done", ms=ms, ok=bool(description))
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

        plan_prompt = build_plan_prompt(
            question,
            context_log,
            screen_context,
            is_first_round=(round_num == 0),
            language=language,
            known_repos=known_repos,
        )
        tracer.emit("plan.start", round=round_num + 1)
        plan_started = time.monotonic()
        raw_plan = await generate(plan_prompt, max_output_tokens=400, temperature=0.0, json_mode=True)
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
            tracer.emit("plan.retry", round=round_num + 1, reason="empty plan on the first round")
            raw_plan = await generate(plan_prompt, max_output_tokens=400, temperature=0.4, json_mode=True)
            plan = extract_json(raw_plan) or {}
            calls = (plan.get("calls") or [])[: min(MAX_CALLS_PER_ROUND, remaining)]

        tracer.emit(
            "plan.done",
            round=round_num + 1,
            ms=int((time.monotonic() - plan_started) * 1000),
            calls=[{"tool": c.get("tool"), "args": c.get("args") or {}} for c in calls],
        )

        if not calls:
            break

        outcomes = await asyncio.gather(
            *[
                _run_one_call(
                    c,
                    repo_id,
                    tracer,
                    f"r{round_num + 1}c{i + 1}",
                    round_num + 1,
                    workspace_id=workspace_id,
                    known_repo_ids=known_repo_ids,
                    allowed_tools=allowed_tools,
                )
                for i, c in enumerate(calls)
            ]
        )
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

        if all_evidence:
            # A second planning round costs a full LLM round-trip (~1s) and
            # in practice returns "no further tools needed" nearly every
            # time once round 1 found anything — measured as pure latency
            # on the critical path of a live call. Round 2 still runs when
            # round 1 came back empty-handed, which is the case it exists
            # for.
            tracer.emit("plan.skipped", round=round_num + 2, reason="round 1 already gathered evidence")
            break

    dedup_evidence = _dedupe_evidence(all_evidence)

    tracer.emit("evidence.gathered", count=len(dedup_evidence), raw_count=len(all_evidence))

    if not dedup_evidence:
        result = {
            "answer": _no_evidence_abstention(tool_trace, language),
            "claims": [],
            "confidence": "low",
            "abstained": True,
            "escalation": None,
            "tool_trace": tool_trace,
        }
        tracer.emit("turn.done", ms=tracer.elapsed_ms, result=result, reason="no evidence")
        return result

    # Compose only ever cites a handful of items, but every extra one is
    # input tokens on the critical path (a 22-item set is ~8.2k chars of
    # prompt). Evidence arrives score-ordered per tool, so this keeps the
    # strongest and drops the tail. NOT a snippet-length cut — truncating
    # inside a snippet is what silently hid the S3 retry-policy paragraph
    # once before (see prompts._format_evidence).
    compose_evidence = _select_compose_evidence(tool_trace, COMPOSE_EVIDENCE_LIMIT) or dedup_evidence[
        :COMPOSE_EVIDENCE_LIMIT
    ]
    # The caller's language reaches ONLY compose. Planning stays in English
    # on purpose: tool names, the account directory and the corpus are all
    # English, and translating the planner's input buys nothing but a new
    # way for tool selection to go wrong.
    compose_prompt = build_compose_prompt(
        question, compose_evidence, language=language, persona_prompt=personas_prompt(bot_types)
    )
    tracer.emit("compose.start", evidence_count=len(compose_evidence), language=language or "en-IN")
    compose_started = time.monotonic()
    raw_composed = await generate(compose_prompt, max_output_tokens=700, temperature=0.1, json_mode=True)
    parsed = extract_json(raw_composed)
    tracer.emit(
        "compose.done",
        ms=int((time.monotonic() - compose_started) * 1000),
        # A parse failure here is the already-documented DeepSeek JSON
        # flakiness, and it's exactly the kind of thing the advanced panel
        # exists to make visible instead of it silently becoming a
        # low-confidence abstention.
        parsed=parsed is not None,
    )
    composed = parsed or {
        "answer": "I wasn't able to compose a reliable answer from the evidence I found.",
        "claims": [],
        "abstained": True,
        "escalation": None,
    }

    valid_ids = {e["id"] for e in compose_evidence}
    verify_started = time.monotonic()
    result = verify(composed, valid_ids)
    result["tool_trace"] = tool_trace
    tracer.emit(
        "verify.done",
        ms=int((time.monotonic() - verify_started) * 1000),
        claims_in=len(composed.get("claims") or []),
        claims_kept=len(result.get("claims") or []),
        confidence=result.get("confidence"),
        abstained=result.get("abstained"),
    )
    tracer.emit("turn.done", ms=tracer.elapsed_ms, result=result)
    return result
