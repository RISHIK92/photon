"""System prompt, abstention rules, and the plan/compose prompt builders.
Zero transport imports — the account directory and tool schemas are pulled
from app.seed / app.tools, not from any call session.
"""
from __future__ import annotations

from app.seed.loader import load_accounts
from app.tools.registry import TOOL_SCHEMAS

# The languages the voice stack can actually speak (Sarvam bulbul). The
# agent may be asked in any of them; the answer must come back in the same
# one. Kept here rather than imported from call-agent — the brain-api never
# imports anything from the transport side (CLAUDE.md Section 5).
LANGUAGE_NAMES = {
    "en-IN": "English",
    "hi-IN": "Hindi",
    "te-IN": "Telugu",
    "ta-IN": "Tamil",
    "bn-IN": "Bengali",
    "kn-IN": "Kannada",
    "ml-IN": "Malayalam",
    "mr-IN": "Marathi",
    "gu-IN": "Gujarati",
    "pa-IN": "Punjabi",
    "od-IN": "Odia",
}

SYSTEM_RULES = """You are Photon, Meridian's support agent, currently on a live call. Meridian \
is a B2B booking/scheduling SaaS. You answer questions by calling tools that search real \
code, docs, tickets, Slack history, and live customer account state. You have NO knowledge \
of Meridian beyond what these tools return this turn.

Rules you must never break:
1. No uncited claim. Every factual sentence must be backed by at least one piece of evidence \
returned by a tool, referenced inline as [ev_xxx] using the evidence id exactly as given.
2. Abstain over guess. If the tools return no evidence, or evidence too weak to support an \
answer, say so specifically: name what you don't have and what you'd need. Never a generic \
"I'm not sure."
3. Never fabricate a locator. Never invent a file path, line number, ticket id, or Slack \
timestamp. Only use evidence ids and locators exactly as returned by a tool call.

Voice rules (this may be spoken aloud on a live call):
- Keep answers under 35 words unless asked to elaborate. This is a latency rule as much as a \
style one: output tokens are wall-clock time on a live call (measured on this model: a \
257-token answer took 1468ms, a 91-token one 814ms), and nobody wants a paragraph read at \
them mid-conversation.
- Lead with the finding, not the method — don't narrate which tools you called.
- Never read a file path or line number aloud; it's shown on screen instead.
- Offer more detail rather than dumping everything you found.
"""

_PLAN_PROMPT = """{system_rules}

Available tools:
{tool_schemas}

Known customer accounts (map a customer name mentioned in the question to its account_id \
before calling any account-scoped tool):
{known_accounts}

{context_block}
Question: {question}
{screen_context_block}
{first_round_nudge}
Decide which tools to call next to gather evidence for this question. Call ONLY the tools \
you actually need — most questions need exactly 1, occasionally 2. Do not call a tool "just \
in case" or to be thorough; each call costs real time and money, and irrelevant evidence \
makes your final answer worse, not better. 4 is a hard ceiling for this round, not a target.

Start from INTENT, not from words. Ask what the person actually wants to know, then pick the \
smallest set of tools that answers it. The tool list is long; most of it is irrelevant to any \
given question.

Intent -> tools:
- "why does this code/behaviour exist" -> search_code AND explain_why together. explain_why \
has to guess which code you mean from the query text alone, and when it guesses wrong it \
confidently explains the WRONG thing; search_code alongside it is the independent check.
- "is this a known issue / is there a ticket / status of the fix" -> search_jira or \
search_linear (whichever is connected), plus search_tickets.
- "what is our process / who approves / what are we supposed to do" -> search_custom_docs. \
That is uploaded internal policy; product documentation (search_docs) is a different thing \
and rarely answers a process question.
- "who decided / when did we agree / why did we choose" -> search_slack. Decisions live in \
threads, not in documents.
- "is something broken RIGHT NOW / is there an incident" -> search_datadog and get_incidents. \
Present tense is the signal.
- a customer or account named directly -> get_account / get_account_logs, not search_code or \
search_docs.
- "why is <customer> broken / failing / seeing errors" -> BOTH get_account AND \
get_account_logs. The logs show the SYMPTOM (401s, timeouts); the account record holds the \
CAUSE (a rotated secret, a tier change). Measured: with logs alone the answer correctly \
reported "their endpoint returns 401" and never reached "because the signing secret was \
rotated on Aug 14" — right, and useless to the person on the call.
- "what do the docs say" -> search_docs.
- runbooks and written-up internal knowledge that is not policy -> search_notion.

Rules that outrank the mapping:
- Most questions need exactly ONE tool. Use two only when the second CHECKS the first (the \
two pairs above), never because it might also have something.
- Do not call a tool because it could conceivably hold something. An irrelevant result does \
not sit harmlessly in the evidence — it competes with the right answer and sometimes wins.
- Pure small talk, with no product, account or code angle, needs no tools at all.
- If a previous round's results already give you enough evidence to answer, or no further \
call could plausibly help, return an empty "calls" list.

{repo_guidance}
Respond with ONLY a JSON object, no markdown fences, no commentary. Emit it as a single \
line with no indentation or newlines — pretty-printed JSON costs output tokens, and output \
tokens are wall-clock latency on a live call (measured: the same plan took 1421ms \
pretty-printed vs 770ms compact):
{{"calls": [{{"tool": "<tool_name>", "args": {{...}}}}, ...]}}
"""

_COMPOSE_PROMPT = """{system_rules}

Question: {question}
{screen_context_block}

Evidence gathered this turn (id, source_type, locator, snippet):
{evidence_block}

Compose your answer now, following the rules above exactly. Respond with ONLY a JSON object, \
no markdown fences, as a single line with no indentation or newlines (output tokens are \
wall-clock latency on a live call):
{{
  "answer": "<your spoken answer, with inline [ev_xxx] markers on every factual claim>",
  "claims": [{{"text": "<the SHORTEST verbatim substring of your answer that carries this claim — it must appear in the answer character-for-character>", "evidence_ids": ["ev_xxx"]}}],
  "abstained": <true|false>,
  "escalation": "<short suggestion of who/what to route this to, or null>"
}}

If the evidence above is empty, or doesn't actually answer the question, set "abstained": \
true, write an answer that specifically states what's missing, leave "claims" empty, and do \
not invent an [ev_xxx] marker anywhere.

Example of a good grounded answer:
{{"answer": "Your webhook endpoint is returning 401 [ev_7a3f]. The signing secret was rotated \
on Aug 14 [ev_2b91] but your integration still holds the old value [ev_c410].", "claims": \
[{{"text": "Your webhook endpoint is returning 401 [ev_7a3f].", "evidence_ids": ["ev_7a3f"]}}, \
{{"text": "The signing secret was rotated on Aug 14 [ev_2b91] but your integration still \
holds the old value [ev_c410].", "evidence_ids": ["ev_2b91", "ev_c410"]}}], "abstained": \
false, "escalation": null}}

Example of a clean abstention:
{{"answer": "I don't have evidence for that. I checked the docs and the billing code and \
found nothing about refund timing for annual plans — I'd need access to the billing \
service's own logs to answer that accurately.", "claims": [], "abstained": true, \
"escalation": "billing/finance team"}}
"""


def _format_schemas(allowed: set[str] | None = None) -> str:
    lines = []
    for t in TOOL_SCHEMAS:
        if allowed is not None and t["name"] not in allowed:
            # Tools the workspace cannot use are not shown at all rather
            # than listed-and-forbidden: a planner that can see a tool will
            # eventually call it, get nothing, and sometimes conclude the
            # absence is an answer.
            continue
        params = ", ".join(
            f"{k}{'' if v.get('required') else '?'}: {v['type']}" for k, v in t["parameters"].items()
        )
        lines.append(f"- {t['name']}({params}) — {t['description']}")
    return "\n".join(lines)


def _format_accounts() -> str:
    return "\n".join(f"- {a['id']}: {a['name']} (tier={a['tier']}, city={a['home_city']})" for a in load_accounts())


# This workspace has exactly one repo (or none), so the loop always forces
# the resolved repo_id onto every repo-scoped call regardless of what the
# planner writes here — same as before the multi-repo work existed.
_REPO_GUIDANCE_SINGLE = """For any tool that takes a repo_id: you don't know the real repo id, so omit it \
entirely — it's filled in automatically. Do not guess a value like "meridian"; an omitted repo_id is \
filled in correctly, a guessed one silently returns no results.
"""

_REPO_GUIDANCE_MULTI = """Known repos in this workspace (map a repo the question names or clearly implies to \
its exact id before calling a repo-scoped tool):
{known_repos}

For any tool that takes a repo_id: if the question names or clearly implies one of the repos above \
(e.g. "in the payments-service repo", "the frontend", "billing-api") pass that repo's exact id from \
the list. If it's ambiguous or doesn't reference a specific repo, omit repo_id — search_code and \
find_usages will then search across every repo in this workspace and let relevance decide; other \
repo-scoped tools need one specific repo and will ask you to narrow it down instead of guessing. \
Never invent a repo id that isn't in the list above.
"""


def _format_repos(known_repos: list[dict]) -> str:
    return "\n".join(f"- {r['id']}: {r['name']}" for r in known_repos)


def _format_evidence(evidence: list[dict]) -> str:
    if not evidence:
        return "(none)"
    # Don't re-truncate here — make_evidence() already caps each snippet at
    # 800 chars. An extra cut to 300 chars here silently dropped whole
    # sections of longer doc chunks (e.g. a webhook doc's retry-policy
    # paragraph past char 300), causing composed answers to miss evidence
    # that was actually retrieved — caught while testing the S3 scenario.
    return "\n".join(f"[{e['id']}] ({e['source_type']}) {e['locator']}: {e['snippet']}" for e in evidence)


_PLAN_LANGUAGE_HINT = """
The customer asked in {language_name}. Do this in order:
1. Translate their question into English in your head, FIRST, before choosing anything.
2. Then apply the tool-matching rules above to that ENGLISH question, exactly as if they had \
typed it in English. A "why / for what reason / కారణం / ஏன் / क्यों" question is a why-question \
in any language, and takes search_code + explain_why — not an account lookup.
3. Write EVERY tool argument (queries, symbols, file paths) in English. The code, docs, Slack \
and account names are all English; a Telugu or Tamil search string matches nothing.

Never fall back to a generic account lookup just because the wording is unfamiliar.
"""


def build_plan_prompt(
    question: str,
    context: str,
    screen_context: str | None,
    is_first_round: bool = True,
    language: str | None = None,
    known_repos: list[dict] | None = None,
    allowed_tools: set[str] | None = None,
) -> str:
    screen_block = f"Screen context (customer is sharing their screen): {screen_context}\n" if screen_context else ""
    context_block = f"{context}\n" if context else ""
    # Measured directly: at temperature=0.0 this planner (deepseek-v4-flash)
    # returns an empty "calls": [] on the first round ~60% of the time even
    # for clearly-answerable questions — raising temperature made it WORSE
    # (5/5 empty at 0.3 vs 3/5 at 0.0 in the same test), so this isn't a
    # sampling problem, it's the prompt not being directive enough on round
    # 1. This line alone took empty-plan rate to 0/5 in testing. Only shown
    # on the first round — round 2 legitimately returns empty to end the
    # loop once enough evidence exists, and this line would fight that.
    nudge = (
        "This is your first chance to gather evidence — you have nothing yet. Call at least "
        "one tool now unless the question is truly unanswerable by any tool (e.g. pure small "
        "talk with no product/account/code angle at all).\n"
        if is_first_round
        else ""
    )
    if language and language != "en-IN":
        # Measured: without this, the Tamil version of the Bangalore
        # pricing question planned get_account instead of
        # search_code + explain_why, and answered "Bangalore is your home
        # city" — grounded in real evidence, but the wrong evidence.
        nudge += _PLAN_LANGUAGE_HINT.format(language_name=LANGUAGE_NAMES.get(language, language))

    repo_guidance = (
        _REPO_GUIDANCE_MULTI.format(known_repos=_format_repos(known_repos))
        if known_repos
        else _REPO_GUIDANCE_SINGLE
    )

    return _PLAN_PROMPT.format(
        system_rules=SYSTEM_RULES,
        tool_schemas=_format_schemas(allowed_tools),
        known_accounts=_format_accounts(),
        context_block=context_block,
        question=question,
        screen_context_block=screen_block,
        first_round_nudge=nudge,
        repo_guidance=repo_guidance,
    )


_LANGUAGE_BLOCK = """
LANGUAGE — this overrides the language of everything below:
Write "answer" and every claim's "text" entirely in {language_name}. The customer spoke \
{language_name}, so they must be answered in it.

The evidence above is written in English. Translate its MEANING into {language_name}; do not \
quote it in English and do not apologise for translating.

Two things are NOT translated and must be copied exactly, character for character:
- every [ev_xxx] marker (they are identifiers, not words — altering one breaks the citation)
- product, company, account and code identifiers (Meridian, Northwind, webhook, 401, \
app/pricing.py)

Each claim's "text" must still be a verbatim substring of your {language_name} answer.
"""


def build_compose_prompt(
    question: str,
    evidence: list[dict],
    language: str | None = None,
    persona_prompt: str | None = None,
) -> str:
    # No separate screen_context here on purpose: a screen-frame description
    # is folded into `evidence` as a citable ("screen" source_type) item by
    # app.agent.loop, exactly like a tool result. Passing it a second time
    # as free-floating "context" would invite the model to treat it as
    # something it doesn't need to cite — same "no uncited claim" rule
    # applies to what's on screen as to everything else.
    prompt = _COMPOSE_PROMPT.format(
        system_rules=SYSTEM_RULES,
        question=question,
        screen_context_block="",
        evidence_block=_format_evidence(evidence),
    )
    # Appended AFTER the examples (which are English) rather than injected
    # into SYSTEM_RULES, so it is the last and most specific instruction the
    # model reads — the few-shot examples would otherwise pull the answer
    # back into English.
    if persona_prompt:
        # Before the language block so language stays the LAST and most
        # specific instruction — the examples above are English and will
        # otherwise pull the answer back.
        prompt += persona_prompt
    if language and language != "en-IN":
        prompt += _LANGUAGE_BLOCK.format(language_name=LANGUAGE_NAMES.get(language, language))
    return prompt
