# Photon — Company Brain + Live Call Support Agent

Layout note: this repo uses `client/` (frontend, was `apps/console` in the
original plan) and `server/` (backend, was `services/brain-api`). All plan
references to `services/brain-api` mean `server/`; all references to
`apps/console` mean `client/`.

## Current phase

**Phase 2 — Tool layer.** Phase 0 (environment) is complete except for the
manual two-person LiveKit transport test (not a blocker for Phase 1/2/3
work). Phase 1 (seed corpus) is complete and passed its acceptance test
(5/5 off-script questions hit real evidence). Phase 2 status below.

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
