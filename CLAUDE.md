# Photon — Company Brain + Live Call Support Agent

Layout note: this repo uses `client/` (frontend, was `apps/console` in the
original plan), `server/` (backend, was `services/brain-api`), and
`call-agent/` (was `services/call-agent/`). All plan references to
`services/brain-api` mean `server/`; `apps/console` means `client/`;
`services/call-agent` means `call-agent/`. `apps/call` (the join page)
lives at `client/app/call/`.

## LLM providers — text vs vision split (resolved the Gemini quota blocker)

`GEMINI_API_KEY`'s free tier turned out to be capped at **20 requests/DAY**
for `gemini-2.5-*` (`GenerateRequestsPerDayPerProjectPerModel-FreeTier`) —
a hard daily cap, not a per-minute one retries can wait out. Each agent
turn burns 2-4 LLM calls (plan + compose, up to 2 rounds), so this was a
real blocker for Phase 3.

**Fix**: all TEXT generation moved to OpenRouter (`app/core/llm/
openrouter.py`, model `deepseek/deepseek-v4-flash-0731`) — the agent
loop's plan/compose calls, `check_conflict`'s judge call, and the web
console's `/api/query` streaming (`llm_orchestrator.py`). Gemini
(`gemini_vision_model = gemini-3.7-flash`) is now reserved exclusively for
image/screen-frame analysis, once Phase 4 needs it — not used by any code
yet. Both `OPENROUTER_API_KEY` and the model id were verified live against
OpenRouter's `/models` list before wiring anything up.

**New known constraint**: OpenRouter's routing to this model has highly
variable latency in testing — most calls land in ~1s, but one single-call
`httpx.ReadTimeout` was directly observed at 60s+ with no error, just a
slow upstream response. This is a real latency risk for the live-call demo
(Section 17's "gemini-2.5-pro is too slow for a live call" gotcha applies
here too, just for a different reason). `sync_chat` (`app/core/llm/
openrouter.py`) now retries `ReadTimeout`/`ConnectTimeout` once (capped at
2 total attempts, so a stuck call fails in a bounded ~90s rather than
compounding with the 429/5xx retry budget) — a mitigation, not a fix. If
this proves frequent during Phase 4 rehearsal, the real fix is a paid/
dedicated OpenRouter tier or a different model, not more retry tuning.

## Current phase

**Phase 4 — Live call transport.** Phase 0 (environment) is complete —
the manual two-person LiveKit test from its checklist is superseded by
the Phase 4 live verification below (worker joined a real room, real
Deepgram STT/TTS). Phases 1-3 are complete — see their sections below.
Phase 4 status below.

### Phase 4 — live call transport (done)

New top-level service, `call-agent/`, with its **own venv** — same reason
as the CLAUDE.md gotcha above: `livekit-api` force-upgrades `protobuf` and
would break `server/.venv`'s Gemini/embedding stack if shared. `call-agent/`
and `server/` only ever talk over plain HTTP (`POST /api/agent/ask`).

- `call-agent/adapters/base.py` — the transport boundary contract: three
  methods (`speak`/`cancel_speech`/`announce`, implemented by a concrete
  adapter, called by the orchestrator) and two callbacks (`on_speech`/
  `on_frame`, implemented by the orchestrator as `SessionCallbacks`,
  called by the adapter). Split into two Protocols since the plan's single
  combined code block conflates "implemented by" and "called by" — see
  the module docstring for why.
- `call-agent/orchestrator.py` — `Orchestrator` (implements
  `SessionCallbacks`): explicit wake-word gating (only a turn starting
  with "Photon" triggers anything — see build plan Phase 4 for why this
  beats open-mic/turn-detection), rolling transcript, latest-screen-frame
  buffer (gated on `source == "screen"`, camera frames are dropped),
  `POST {BRAIN_API_URL}/api/agent/ask` on every addressed turn, hands the
  answer to `adapter.speak()`. Zero LiveKit imports — verified directly by
  running it against a `MockAdapter` with no transport in the loop at all
  (see verification below), same spirit as `server/tests/test_agent_loop.py`.
- `call-agent/adapters/livekit_adapter.py` — the one `TransportAdapter`
  implementation. `AgentSession(stt=deepgram.STT(model="nova-3"),
  tts=deepgram.TTS(model="aura-2-thalia-en"), vad=silero.VAD.load())`, a
  custom `Agent` subclass whose `on_user_turn_completed` hook forwards
  every turn to the orchestrator's `on_speech` and always raises
  `StopResponse()` — LiveKit's own (unconfigured) LLM node never runs;
  the orchestrator/brain-api is the only thing that ever composes an
  answer. Screen-share frames are pumped from a dedicated `track_subscribed`
  handler filtered to `rtc.TrackSource.SOURCE_SCREENSHARE` (never
  `SOURCE_CAMERA`), throttled to ~1fps speaking / ~0.3fps idle via
  `session.user_state`, resized/JPEG-encoded via Pillow, capped at 1024px.
- `call-agent/worker.py` — entrypoint; `python3 worker.py dev` for local
  testing, `start` for prod. Every API call/method used here
  (`AgentSession`, `Agent.on_user_turn_completed`, `StopResponse`,
  `RoomInputOptions`, `rtc.VideoStream.from_track`, `rtc.TrackSource`) was
  verified against the actually-installed `livekit-agents==1.7.0`'s real
  signatures via `inspect`, not assumed from training-data familiarity
  with older SDK versions — this API has moved a lot across majors.
- `client/app/api/livekit-token/route.ts` — mints a join token
  server-side (holds `LIVEKIT_API_SECRET`, never sent to the browser).
- `client/app/call/page.tsx` — the join page: mic/screen-share toggles via
  `livekit-client` (`setMicrophoneEnabled`/`setScreenShareEnabled`), live
  captions from `RoomEvent.TranscriptionReceived`, and a text-input
  fallback that calls `POST /api/agent/ask` directly (bypassing voice
  entirely) — satisfies the Definition of Done's "text-input fallback
  works if audio fails" without depending on the call-agent service at all.

**Live-verified, not just written and assumed correct** (this environment
has no real microphone, so audio content itself can't be tested, but
everything up to and around that boundary was):
1. `python3 worker.py dev` registered with LiveKit Cloud for real —
   `"registered worker" {"id": "AW_...", "url": "wss://photon-
   ter1p8y0.livekit.cloud", "region": "India South"}`.
2. A real second participant (a throwaway script using `livekit.rtc.Room`,
   playing the human) joined a real room and the worker was dispatched,
   joined as `agent-AJ_...`, and ran `entrypoint()` end to end with no
   errors.
3. Real Deepgram STT and TTS WebSocket connections were established
   (visible in the worker's own debug log).
4. `announce()` actually spoke: the log shows `conversation_item_added
   {role: assistant, text: "Hi, I'm Meridian's support agent..."}` —
   confirms `adapter.speak()` -> `session.say()` -> real TTS synthesis
   worked, not just that the call didn't throw.
5. Clean shutdown on participant disconnect, confirmed in the log.
6. `orchestrator.py` run standalone against a `MockAdapter` (no LiveKit
   object anywhere in the process): unaddressed speech correctly ignored,
   interim (non-final) speech correctly ignored, camera frames correctly
   never treated as screen frames, and an addressed question ("Photon,
   why does pricing have a special case for Bangalore?") correctly
   triggered a real HTTP call to the live brain-api and produced a
   fully-grounded S2 answer via `adapter.speak()`.
7. The Next.js `/call` page and `/api/livekit-token` route both compile
   and serve (200) under `next dev`; the token route mints a real,
   correctly-scoped JWT.

**Known gaps, honestly**: real audio in/out (a human speaking, hearing the
agent) is untested — this environment has no microphone/speaker to drive
that, so it needs an actual human on a real call, same as the Phase 0
LiveKit box that was never checked off. Screen-frame capture
(`_pump_screen_frames`) is written against a verified API but never
exercised with a live screen-share track — lowest priority per the plan's
own cut order ("Screen share / vision — First to go"). `RoomInputOptions`
logged a deprecation warning in favor of `RoomOptions` in 1.7.0 — still
functionally correct, not yet migrated.

Not built yet: the evidence panel (Phase 5) — the join page above is
functional but has no citation/evidence UI yet, just live captions and a
plain text Q&A fallback.

### Phase 3 — agent loop (done)

- `app/agent/llm.py` — `generate()` (OpenRouter via `app/core/llm/
  openrouter.py`, `json_mode` supported) + a tolerant `extract_json()`
  (strips markdown fences, falls back to regex-extracting the first
  `{...}` block).
- `app/agent/prompts.py` — `SYSTEM_RULES` (the three non-negotiable rules
  + voice rules for a live call), plan-prompt builder (includes the tool
  schema list and the known-accounts directory so the planner can map a
  customer name like "Northwind" to `acct_northwind` without a round-trip),
  compose-prompt builder with one grounded-answer few-shot and one clean-
  abstention few-shot.
- `app/agent/verifier.py` — deterministic, no LLM call: strips any claim
  whose `evidence_ids` aren't fully in the tool-verified set, forces full
  abstention if >50% of claims fail or zero evidence came back at all,
  downgrades confidence to `low` on any stripped claim.
- `app/agent/loop.py` — `answer_question(question, repo_id=None,
  screen_context=None)`: plan (max 4 calls/round) → execute tools in
  parallel via `asyncio.gather` → up to `MAX_ROUNDS=2` rounds, `
  MAX_TOOL_CALLS_TOTAL=6` → compose → verify. `repo_id` defaults to
  `get_seed_repo_id()` if not passed.
- `app/routers/agent.py` — `POST /api/agent/ask` (+ `?stream=true`, which
  chunks the already-verified answer word-by-word over SSE rather than a
  true token stream — verification needs the complete composed JSON first,
  so real mid-generation streaming isn't compatible with the verify step).
- `tests/test_agent_loop.py` — `test_agent_package_has_zero_transport_imports`
  is a static AST check (no LLM call) that nothing under `app/agent/`
  imports anything transport-shaped; the other three exercise S1, S2, and
  a clean-abstention question live against the real corpus/stack. All 4
  passing as of the last full run.

**Three real bugs caught and fixed while testing this against the live
stack** (all in git history, not just asserted fixed):
1. `_format_evidence()` in `prompts.py` re-truncated each evidence snippet
   to 300 chars on top of `make_evidence()`'s own 800-char cap. For a doc
   chunk where the relevant section isn't near the top of the file (e.g.
   `05-webhooks.md`'s retry-policy paragraph starts at char 458), the
   compose LLM never saw it — a real S3 answer went from correctly
   flagging the conflict to a false "I don't have evidence for that."
   Fixed by not re-truncating; `make_evidence()`'s cap is the only one now.
2. `loop.py`'s `_run_one_call` only auto-filled `repo_id` when the planner
   omitted it — a planner guess like `"repo_id": "meridian"` (plausible-
   looking, wrong) silently overrode the correct UUID and emptied out
   `search_code` results with no error. Fixed to always force the loop's
   own resolved `repo_id` for repo-scoped tools; also told the planner in
   the prompt not to bother guessing it.
3. The planner (`deepseek-v4-flash-0731`) sometimes returns an empty
   `"calls": []` plan on the very first round even for clearly-answerable
   questions — observed directly (a rerun of the exact S1 pytest failed
   with `abstained: True` and an empty `tool_trace` after passing cleanly
   moments earlier). Before any evidence exists, that's essentially always
   premature. Fixed with one retry (slightly higher temperature, a firmer
   nudge) when round 0 comes back empty — confirmed to resolve it on
   rerun, though given the model's variability this is a mitigation, not
   a guarantee; worth watching for during the demo.

Not built yet: `services/call-agent/` (Phase 4 — LiveKit transport
adapter) and the evidence panel UI (Phase 5).

### Phase 2 — tool layer (done)

- `app/seed/loader.py` — `ensure_repo_ingested()` runs the Meridian repo
  through the normal ingestion pipeline (Postgres `Repo`/`Job`, Neo4j module
  graph, `code_chunks` Qdrant collection) — idempotent, looks up by repo
  name `meridian-api` before re-ingesting. `embed_knowledge_base()` embeds
  `docs/` (12 files — **`CONFLICTS.md` is deliberately excluded**, see
  below), `tickets.jsonl`, `slack.jsonl` into three separate Qdrant
  collections (`kb_docs`, `kb_tickets`, `kb_slack`) via `embed_texts`.
  `load_accounts/commits/prs/tickets/logs/incidents/slack()` are plain
  cached JSON/JSONL readers for the deterministic tools.
  Run once per fresh stack: `python3 -c "from app.seed.loader import
  load_all; print(load_all())"` from `server/` (venv activated) — ingestion
  takes ~15s, KB embedding ~15s.
- `app/tools/evidence.py` — `make_evidence()`/`tool_result()`/`tool_error()`
  are the ONLY place the Section-4 evidence/tool-result shape is built. Every
  tool in `code.py`/`knowledge.py`/`tenant.py`/`provenance.py`/`conflict.py`
  goes through these — don't hand-build the dict shape elsewhere.
- `app/tools/code.py` — `search_code`, `trace_symbol`, `find_usages`,
  `read_file`, all wrapping the existing `vector_search`/`hybrid_retrieve`
  internals. Qdrant payloads don't carry a real cosine score (dropped in
  `context_assembler.py` too) — `_rank_score()` approximates a descending
  score from result order.
- `app/tools/knowledge.py` — `search_docs`, `search_tickets` (optional
  `account_id` filter), `search_slack` (optional `channel` filter).
- `app/tools/tenant.py` — `get_account` (secrets redacted to last 4 chars),
  `get_account_logs`, `get_incidents`, `list_accounts`. All deterministic
  JSON reads, no vector search — this is why S1 answers are exact.
  `get_incidents(account_id=...)` cross-references `related_tickets` against
  that account's tickets, then falls back to matching the account's first
  name-word or id in the incident text — matching the literal account_id or
  full account name against incident prose was too strict and silently
  returned nothing (caught and fixed while testing).
- `app/tools/provenance.py` — `explain_why(symbol_or_path, repo_id)`: code
  → commit (via `files` list) → ticket (`MER-\d+` regex on commit message)
  → PR (commit hash or ticket id in description) → Slack thread (keyword-
  scored match to find the root, then all messages sharing its
  `thread_ts`). Verified end-to-end on `app/pricing.py`: returns the full
  MER-412 chain down to all 12 messages in the `#pricing` thread. Any hop
  that can't be found stops the chain there with a `note` — never guesses.
- `app/tools/conflict.py` — `check_conflict(claim, repo_id)`: top-1
  `search_docs` + top-1 `search_code`, one narrow LLM judgment
  (agrees/conflicts/insufficient + <20-word reason), folded into `note`
  (the tool contract has no extra top-level keys). **Gotcha**: `gemini-2.5-
  flash` burns hidden reasoning tokens against `max_output_tokens` — 150 was
  silently truncating the answer mid-sentence; needed 1500 to reliably leave
  room for ~2 visible lines. Verified stable "conflicts" verdict on the
  retry-policy question and "agrees" on the secret-rotation question across
  repeated calls.
- `app/tools/registry.py` + `app/routers/tools.py` — `GET /api/tools` (schema
  list) and `POST /api/tools/{name}` (`{"args": {...}}` body), mounted
  unauthenticated at `/api/tools` in `main.py` per the plan's demo-scope
  auth decision. All 13 tools curl-tested individually, plus the unknown-
  tool (404) and missing-required-arg (422) error paths.

**Bug caught and fixed during testing**: `CONFLICTS.md` was initially
embedded into `kb_docs` like a real product doc. Since it accurately
narrates what the code does (that's its whole purpose), `check_conflict`
would sometimes retrieve it as the "docs" side and correctly report
"agrees" — silently defeating the S3 scenario. Fixed in `loader.py` by
excluding it from `embed_docs()`; stale embedded copy purged from Qdrant.
If `embed_docs(force=True)` is ever re-run, double check `CONFLICTS.md`
didn't sneak back in.

Not built yet: `app/agent/` (Phase 3 — the planning loop that calls these
tools and composes a cited answer) and `services/call-agent/` (Phase 4).

## Seed corpus (Phase 1)

The Meridian seed corpus is written at `server/app/seed/data/`:

- `repo/` — ~20-file FastAPI codebase (`meridian-api`). Load-bearing files:
  `app/pricing.py` (S2 — the unexplained Bangalore partner-rate branch),
  `app/webhooks.py` (S1 — signature verification + retry backoff that
  contradicts the docs for S3).
- `commits.jsonl` (30), `prs.jsonl` (10) — the commit touching `pricing.py`
  for the Bangalore rate references `MER-412`; PR #128 closes it and links
  the Slack thread.
- `slack.jsonl` (80 msgs / 6 channels: #pricing #eng #support #partnerships
  #incidents #general) — the `#pricing` thread starting at `t0` in
  `generate.py` is the ONLY place the Bangalore reason exists (BLR Mobility
  Partners reseller deal, signed by Legal, negotiated by Priya Nair /
  Partnerships). Not in docs, not in code comments — intentional per S2.
- `docs/` (12 pages + `CONFLICTS.md`) — `05-webhooks.md` claims "5 retries
  over 24h"; the actual code (`webhooks.py` `RETRY_BACKOFF_SECONDS`) does 3
  retries over ~12.5 min. This is the intentional S3 conflict;
  `CONFLICTS.md` documents it — don't "fix" it by editing one side to agree.
- `tickets.jsonl` (25), `accounts.json` (3: `acct_northwind` webhooks
  failing since the Aug 14 secret rotation — S1; `acct_calico` Bangalore
  partner tier — S2; `acct_orion` healthy control), `logs.jsonl` (138,
  includes the Northwind 401 spike since the rotation), `incidents.jsonl`
  (3, including the Northwind rotation-gap incident).
- `screens/` — 2 static HTML mockups (Integrations index, Signing/webhook
  settings page showing Northwind's stale-secret state) for the screen-share
  demo beat.
- `generate.py` — regenerates the volume data (commits/PRs/Slack/tickets/
  logs/incidents/accounts). Hand-authored load-bearing fixtures are inline
  in the script; re-running overwrites output, so diff before re-running if
  anything's been hand-edited since.

### Phase 0 checklist status
- [x] `GEMINI_API_KEY` and `VOYAGE_API_KEY` present in `server/.env`
- [x] LiveKit Cloud project + `LIVEKIT_URL`/`LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET` in `server/.env` — verified live via a raw signed REST call to `ListRooms` (200 `{"rooms":[]}`). Do NOT `pip install livekit-api` (or any livekit SDK) into `server/.venv` — it force-upgrades `protobuf` to 7.x and breaks `google-ai-generativelanguage` (Gemini), which needs `protobuf<5`. The LiveKit adapter is a separate service (`services/call-agent/` in the plan) with its own venv/dependencies — that's where livekit SDKs belong.
- [x] `DEEPGRAM_API_KEY` in `server/.env` — verified live (200 from `/v1/projects`). Deepgram covers both STT (`nova-3`) and TTS (`aura-2-thalia-en`) per the user's chosen `AgentSession` config, so no separate TTS provider is needed.
- [x] `docker compose up -d` — postgres, redis, neo4j, qdrant all healthy (api/worker/frontend run locally, not in Docker — see `docker-compose.yml`)
- [x] `cd server && source .venv/bin/activate && uvicorn app.main:app --reload --port 8000` → `GET /health` → 200
- [x] Celery worker running: `cd server && source .venv/bin/activate && celery -A app.tasks.celery_app worker --loglevel=info`
- [x] `cd client && npm run dev` → localhost:3000 loads
- [x] Ingested httpie/cli (236 files, 1066 functions) end to end — queued → cloning → parsing → graphing → embedding → READY, ~56s
- [x] `POST /api/query` streams a sensible answer with real cited chunks (file_path + line ranges) about that repo
- [ ] Two people in a LiveKit room, one sharing a screen, audio both ways — credentials verified server-side, but this specific box needs a real two-human microphone/screen-share test, which can't be run headlessly. Fastest path: open https://meet.livekit.io, paste in `LIVEKIT_URL` + a generated token (or your key/secret) from `server/.env`, and do it manually with a second person/device — that's the "stock quickstart" the plan means. Flip this box once done.

Phase 0 is otherwise complete — all keys are live-verified, ingestion and
query work end to end. Only the manual two-person transport smoke test is
outstanding.

Python note: pin the venv to **python3.12**, not 3.13 — `voyageai==0.3.2` has
no 3.13 wheel. Also `pip install greenlet` explicitly; it's a transitive
dependency of the async SQLAlchemy engine that isn't pinned in
`requirements.txt` but is required for `create_db_and_tables()` to work.

`REPOS_STORAGE_PATH` was moved from the default `/tmp/yasml-repos` to
`server/data/repos` (gitignored) — the default gets wiped on reboot.

## Tool contract (Section 4 of the plan)

Every tool returns:
```json
{
  "tool": "search_code",
  "status": "ok" | "empty" | "error",
  "evidence": [
    {
      "id": "ev_7a3f",
      "source_type": "code" | "docs" | "ticket" | "slack" | "account" | "log" | "commit",
      "locator": "backend/app/pricing.py:L42-L58",
      "snippet": "...",
      "score": 0.83,
      "retrieved_at": "2026-08-22T10:14:00Z"
    }
  ],
  "note": null
}
```

Every agent answer returns:
```json
{
  "answer": "... [ev_7a3f]",
  "claims": [{"text": "...", "evidence_ids": ["ev_7a3f"]}],
  "confidence": "high" | "medium" | "low",
  "abstained": false,
  "escalation": null,
  "tool_trace": [{"tool": "get_account", "args": {}, "ms": 240}]
}
```

Three rules the agent must never break: no uncited claim, abstain over guess,
never fabricate a locator.

## Transport boundary (Section 5)

`app/agent/` and `app/tools/` (to be created under `server/`) must contain
**zero transport imports** — no LiveKit types, no session objects, no room
handles. The agent loop must be callable from a plain unit test with no call
in progress. `services/call-agent/adapters/base.py`'s `TransportAdapter`
protocol (3 methods, 2 callbacks) is the only seam.

## Standing rule

**Never invent an evidence locator.** If a tool returns nothing, the agent
abstains. A fake file path, line number, ticket ID, or Slack timestamp is a
build-breaking bug, not a UI nit.

## File map (target — not all created yet)

```
server/app/
├── tools/          NEW — code.py, knowledge.py, tenant.py, provenance.py, conflict.py
├── agent/          NEW — loop.py, prompts.py, verifier.py (zero transport imports)
├── routers/tools.py, routers/agent.py   NEW
└── seed/           NEW — loader.py, data/ (fictional "Meridian" company corpus)

call-agent/          NEW top-level service — adapters/base.py, adapters/livekit_adapter.py, orchestrator.py, worker.py
client/app/call/     NEW — join page + evidence pane
```

See the full build plan (pasted into the conversation that created this repo
state) for Sections 6–18: seed corpus spec, tool layer detail, agent loop
design, LiveKit adapter, evidence panel, cut order, and demo script.
