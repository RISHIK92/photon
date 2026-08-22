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

**Phase 5 — Evidence panel.** Phase 0 (environment) is complete — the
manual two-person LiveKit test from its checklist is superseded by the
Phase 4 live verification (worker joined a real room, real Deepgram
STT/TTS). Phases 1-4 are complete — see their sections below. Phase 5
status below.

### Phase 5 — evidence panel (done)

The plan's Section 11 says to adapt `QueryPanel.tsx`/`CodeViewer.tsx` from
`apps/console` — but per the Phase 0 scoping decision, this repo's
`client/` was never seeded with YASML's original frontend (no `apps/console`
equivalent exists here), so this was built fresh, integrated directly into
`client/app/call/page.tsx` rather than ported from a component that
doesn't exist in this repo.

**The real gap this phase had to close first**: `POST /api/agent/ask`'s
Section 4 answer contract only carries `claims[].evidence_ids` and
`tool_trace` (tool/args/ms) — the actual evidence items (locator, snippet,
score) aren't in the response at all once composition discards the raw
tool results. Without them there's nothing for a panel to render. Fixed
in `server/app/agent/loop.py`: each `tool_trace` entry now also carries
its own `evidence: [...]` array — enriches an existing key rather than
adding a new top-level one, so the fixed 6-key answer contract is intact.

- `client/lib/evidence.ts` — shared types + `buildEvidenceMap()` (flattens
  every tool_trace entry's evidence into one `ev_id -> Evidence` lookup —
  the only place a citation chip's data comes from) + `findProvenanceChain()`
  (pulls `explain_why`'s evidence array as-is, since `provenance.py`
  already builds it in exact hop order: code → commit → pr → slack...).
- `client/app/call/EvidencePanel.tsx` — renders each turn's answer with
  `[ev_xxx]` markers replaced by clickable source-type-icon chips
  (clicking scrolls to and briefly highlights the matching evidence card,
  via a ref map + `scrollIntoView`); confidence/abstained/escalation
  badges; tool-trace pills (`tool · Nms`); the provenance strip (rendered
  only when an `explain_why` call produced >1 evidence item, connected
  hop-to-hop with arrows); and the evidence card grid (source icon,
  locator, snippet, score).
- `client/app/call/AccountSummary.tsx` — the idle state: calls
  `POST /api/tools/list_accounts` directly and renders all 3 known
  accounts as cards. (Simpler than the plan's "account summary for
  whoever's on the call" — there's no real caller-to-account identity
  mapping in this build, so it shows all known accounts rather than
  picking one.)
- `client/app/call/page.tsx` — restructured to a bounded two-pane layout
  (call controls left, evidence panel right, each independently
  scrollable) so the panel doesn't just grow the whole page.

**Live-verified in a real browser** (Chrome via the `claude-in-chrome`
tools), not just compiled: idle state shows real account data fetched
live from the brain-api; a submitted question shows a real "thinking…"
state; a real S2 question ("why does pricing have a special case for
Bangalore?") first hit the already-documented DeepSeek compose-JSON-parse
flakiness (correctly rendered as `confidence: low` / `abstained` with 20
real evidence cards, not a UI crash), then on retry produced a fully
grounded high-confidence answer with a working `code → commit` provenance
strip and real evidence cards pulled straight from the corpus (actual
Slack messages from Dev Sharma/Priya Nair/Alex Rao in `#pricing`, correct
locators/scores). Multi-turn stacking (asking a second question) also
confirmed working.

**Known gap, honestly**: this evidence panel only reflects the
text-input path. The voice path (`call-agent/orchestrator.py`) gets the
same `AgentAnswer` from the brain-api and speaks it via TTS, but doesn't
yet broadcast the structured result back into the room for the browser to
render — building that (LiveKit data-channel publish from the adapter,
`TransportAdapter` doesn't currently have a 4th method for it) is real
additional plumbing beyond "evidence panel" itself, and the plan's own
cut order ranks tight voice/UI sync low ("tool trace pills, live — nice,
not load-bearing"). Noting it here rather than silently leaving the
question unaddressed.

### Eval — is it still accurate after the latency work? (`server/evals/`)

The user pushed back on the latency result: fast is worthless if tool
selection got worse. Fair — the latency commit's evidence was 12
happy-path runs. So there is now a real eval harness,
**`server/evals/agent_eval.py`**, run it before trusting any change to
the model, the prompts, or the tool-selection guidance:

```
cd server && .venv/bin/python evals/agent_eval.py <model> [trials]
HARD=1 .venv/bin/python evals/agent_eval.py <model> [trials]
```

The model is a CLI arg rather than read from config specifically so two
models can be A/B'd on identical cases. Four things are scored per run,
independently: **tools** (did the planner call what the question needs,
and not a pile of extras), **content** (does the answer contain the known
ground truth from the seed corpus, and none of the known WRONG answers —
e.g. the documented "Bangalore isn't a special case" regression is a
literal `forbid` string), **abstain** (did it abstain exactly when it
should), **cites** (is every `[ev_xxx]` marker a real id from that turn —
a fabricated locator is a build-breaking bug, per the standing rule).

Two case sets. The base set is the demo scenarios. The HARD set exists
because the base set is written English and **a voice agent never gets
written English** — it includes unpunctuated lowercase ASR output, a
disfluent transcript ("uh so the webhooks for north wind are failing can
you check"), an account referenced only indirectly ("our Mumbai
customer"), a customer that doesn't exist (must abstain, not invent),
ambient small talk that open-mic will pick up mid-call, and a question
whose answer is nowhere in the corpus.

**Results — `gemini-3.5-flash-lite` (the new, fast model):**

| set | runs | tools | content | abstain | cites | all | median |
|---|---|---|---|---|---|---|---|
| base | 24 | 24/24 | 24/24 | 24/24 | 24/24 | **24/24** | 2216ms |
| hard | 16 | 15/16 | 16/16 | 16/16 | 16/16 | **15/16** | 2288ms |

The single flag was an over-strict threshold in the eval, not a bad
answer: one `conflict-docs` run called 4 tools where the case allowed 3.
Its answer was correct ("the code actually does three retries over a much
shorter window [ev_...] rather than five over 24 hours [ev_...]").

**A/B against the old `deepseek-v4-flash` on the identical base set** —
this is the important part, because it inverts the assumption behind the
question. The old model was not more accurate, it was **less**: repeated
`abstained: true` on questions it had evidence for, empty first-round
plans (the documented bug), and "I wasn't able to compose a reliable
answer from the evidence I found" — the compose-JSON parse failure —
across S2, S3 and even the trivial `list_accounts` case, at 13-48s per
run. The latency work did not trade accuracy for speed; the slow model
was ALSO the unreliable one, and its unreliability was mostly invisible
before because it surfaced as a plausible-looking abstention.

**What this does NOT prove**: the corpus is a fixture, so these numbers
measure the loop's behaviour on known-answer questions, not open-domain
accuracy. Tool selection is stable across the 40 runs here; it is not
guaranteed for question shapes nobody has written a case for. Add a case
when a new failure mode shows up — that's what the file is for.

### Fix — turn latency: 39.2s -> 2.4s median (LLM was 97% of it)

The trace panel above immediately paid for itself: it showed a real S2
turn as **39.2s total = 2.4s of tools + 38.0s of LLM**, with a single
compose call costing 27.4s. The user asked to get the whole turn under
3s. Everything below was measured, not assumed — the bench used the
agent's OWN plan/compose prompts against a real 22-item evidence set.

**1. Model (the big one).** Measured per-turn LLM time (plan + compose):

| model | plan+compose | JSON |
|---|---|---|
| `deepseek/deepseek-v4-flash-0731` (was) | 11.3s / 16.6s | 1 of 2 runs failed to parse |
| `openai/gpt-oss-120b` | 16.8s / 18.3s | both failed |
| `google/gemini-3.7-flash` | 6.1s / 7.6s | compose failed both |
| `anthropic/claude-haiku-4.5` | 4.6s / 6.1s | both failed (hit token cap) |
| `google/gemini-3.1-flash-lite` | 3.7s / 9.7s | ok, unstable |
| **`google/gemini-3.5-flash-lite`** | **2.43s / 2.49s** | **clean both** |

`openrouter_chat_model` is now `google/gemini-3.5-flash-lite`. **Do not
swap it without re-running the same measurement** — vendor benchmarks
don't predict this; deepseek was chosen originally for exactly the same
"it's a flash model" reasoning and was the slowest thing tested.
(Vision still routes to `google/gemini-3.7-flash`, unchanged.)

**2. Dropped the second planner round when round 1 found evidence**
(`loop.py`). It cost a full LLM round-trip (~1s) on the critical path and
returned "no further tools needed" nearly every time. Round 2 still runs
when round 1 came back empty — the case it actually exists for. Emits a
`plan.skipped` trace event so the panel shows it wasn't silently lost.

**3. Output tokens, not prompt size, are the latency.** Measured: a 13%
smaller plan prompt changed nothing (770ms either way), but a
pretty-printed plan cost 1421ms vs 770ms compact, and compose at 257
output tokens cost 1468ms vs 814ms at 91. So:
- both prompts now demand single-line JSON, no indentation;
- the voice answer cap dropped 60 -> 35 words (a latency rule as much as
  a style one — and better for a live call anyway);
- `claims[].text` asks for the SHORTEST verbatim substring rather than
  the whole sentence, halving the duplicated text in the output. Still a
  real substring, so `verifier.py`'s strip-the-uncited-claim logic works
  unchanged (and more surgically);
- `max_output_tokens` 800 -> 400 (plan), 1500 -> 700 (compose).

**4. Compose evidence capped at 6 items** (`COMPOSE_EVIDENCE_LIMIT`),
selected **round-robin across tools** via `_select_compose_evidence()`,
not by slicing the flat list. A plain slice would hand the whole budget
to whichever tool ran first and could drop the second tool's best item —
which for S2 is the one Slack message the entire answer depends on. NOT
a snippet-length cut: truncating inside a snippet is what silently hid
the S3 retry paragraph once before.

**Measured after (12 runs, 4 questions, live stack):**

```
min 1864ms   median 2375ms   p90 2976ms   max 3538ms   under 3s: 10/12
```

All 12 returned `confidence: high` or a correct clean abstention; the 4
agent-loop pytest tests still pass; S1 (Northwind 401s), S2 (Bangalore
partner rate, still citing the Slack thread), S3 (3 retries) and the
off-topic abstention were each re-verified end to end.

**Honest caveats.** (a) Both >3s runs were plan-call jitter upstream
(1.8-2.2s vs a 0.8-1.0s norm), not our code — OpenRouter latency variance
is still the dominant risk, as it was for deepseek. (b) These totals
include ~0-0.5s of tool time because our tools are fast (`get_account` is
a cached JSON read; `search_code` is ~0.4s). **If a deployment's tools
really cost 2-2.5s, the floor is ~2.0s of LLM + that, i.e. ~4-4.5s — the
under-3s result depends on sub-second tools, not just on the model.**
(c) The remaining floor is two sequential LLM calls (~0.8s plan + ~1.0s
compose); getting materially below that needs a structural change, e.g.
streaming compose into TTS so time-to-first-audio beats time-to-full-
answer, which the verify step currently forbids (it needs the complete
composed JSON before anything may be spoken).

### Feature — live pipeline trace ("Advanced" panel beside the captions)

The user asked to see latency in real time, which tool is being called
internally, and the whole flow — in an advanced panel beside the
captions. The blocker: `answer_question()` only ever returned its
finished `tool_trace` at the end, so nothing at all was observable
*during* a turn (and turns run tens of seconds — see the DeepSeek latency
notes above). Every layer needed a way to report progress as it happened.

**Server — `server/app/agent/events.py` (new)**: `TurnTracer` stamps each
event with `t` (ms since turn start) and `seq`, and forwards it to a
plain callable sink. Deliberately a callable, not a queue/stream/socket:
`app/agent/` must stay transport-free (Section 5), so the loop never
learns who is listening. A tracer with no sink is a no-op, and a sink
that raises is caught — tracing can never break the turn it traces.

- `app/agent/loop.py` — `answer_question(..., on_event=None)`. Emits
  `turn.start`, `vision.start/done`, `plan.start/retry/done` (per round,
  with the chosen tools), `tool.start`/`tool.done` (per call, with ms /
  status / evidence count), `evidence.gathered`, `compose.start/done`
  (incl. `parsed:false` for the known DeepSeek JSON flakiness),
  `verify.done` (claims in vs kept), `turn.done`. `tool.start` fires
  BEFORE the await, so a tool shows as running for the whole time it
  actually runs. The answer is byte-for-byte identical with or without a
  sink.
- `app/routers/agent.py` — `POST /api/agent/ask/stream`, SSE. Distinct
  from the pre-existing `/ask?stream=true`, which runs the entire turn
  first and only then chunks the finished answer word by word — useless
  for latency, since nothing is sent until everything is over. A
  disconnecting client cancels the turn task rather than orphaning it.

**call-agent — the transport contract widened to 4 methods**: `speak` is
the answer for the human's ear; `publish_event` is everything *about* the
answer that belongs on a screen. `adapters/base.py` documents it as
optional-by-degradation (a platform with no data channel no-ops it and
loses only the panel). `livekit_adapter.py` implements it via
`publish_data(..., reliable=True, topic="photon.trace")`.
`orchestrator.py` now consumes `/ask/stream` instead of `/ask` and
republishes every event into the room, tagged `source: "voice"` and a
`turn_id`. **This closes the Phase 5 "known gap" above** for trace data
(the structured answer/evidence still isn't republished — only the
pipeline events are).

**Client** — one reducer, two feeds:
- `client/lib/trace.ts` — `applyTraceEvent()` folds flat events into
  `TurnTrace` {stages, tools, totals, status}. Dedupes by `seq` (a
  re-delivered data packet would otherwise duplicate a tool row) and
  marks any still-running stage as failed when the turn ends, so nothing
  spins forever.
- `client/app/call/TraceBridge.tsx` — voice feed, filters
  `RoomEvent.DataReceived` on the `photon.trace` topic.
- `client/app/call/page.tsx` — the text path now reads the SSE stream
  (with proper partial-frame buffering) instead of a plain POST, feeding
  the same reducer; both panels moved OUT of the connected-only branch,
  since the text fallback works without joining the call.
- `client/app/call/AdvancedPanel.tsx` — ticking elapsed clock (100ms,
  frozen on the server's authoritative total once done), a voice/text
  badge, per-stage rows with tool calls nested under the plan round that
  chose them, bars scaled to the slowest step *in that turn*, and a
  totals footer (total / tool ms / llm ms).

**Live-verified in a real browser**, text path end to end: the panel
showed `Plan · round 1` running, then "chose search_code, explain_why"
at 8.8s with both tools live in amber "running…", then each completing
at 1.2s, `Plan · round 2` "no further tools needed" 1.7s, `Evidence
deduped 9 unique of 10`, `Compose answer` 27.4s, `Verify citations
4 claim(s) kept` 1ms — footer `total 39.2s · 2 tool calls 2.4s · llm
38.0s · confidence high`, alongside a correct grounded answer.

**What that immediately exposed** (the point of building it): on a real
S2 question, tools are 2.4s of a 39.2s turn — **97% of the latency is
LLM time**, and 27.4s of it is the single compose call. Any future
latency work belongs there (smaller compose prompt, a faster model, or
streaming compose), not in tool optimization.

**Not verified live**: the voice half. The events are published over the
LiveKit data channel, but the running worker was started before these
changes and its prewarmed process still holds the old modules — **the
`worker.py dev` process must be restarted for voice turns to emit any
trace at all.** The user is running the live call tests.

### Change — captions split by speaker (caller vs Photon)

The user asked for the live captions to visibly separate the human from
the agent. Previously `CaptionsBridge.tsx` threw the attribution away —
its handler took only `segments` and pushed bare strings, so a human
question and Photon's spoken answer rendered as identical grey lines in
one undifferentiated list, and interim segments appended as duplicate
half-sentences (the old code sliced to the last 8 with no dedup by id).

- `client/lib/captions.ts` (new) — the `Caption` type (id, speaker,
  display name, isLocal, text, final, at) and `mergeCaption()`, which
  **upserts by LiveKit's segment id** rather than appending. Interim
  results arrive repeatedly under the same id with growing text and
  `final: false`, then once more `final: true` — appending blindly is
  what made one sentence render as a dozen fragments.
- `client/app/call/CaptionsBridge.tsx` — the `transcriptionReceived`
  handler now takes its second arg (`participant?: Participant`) and
  resolves who spoke: agent if `participant.kind === ParticipantKind.AGENT`
  (value 4 in `@livekit/protocol`'s `ParticipantInfo_Kind`), if the
  identity starts with `agent-`, **or if participant is undefined** —
  the agent's own TTS transcript arrives with no participant attached,
  so an undefined participant means the agent, not an unknown human.
  Local participant is labelled "You", other humans by name/identity,
  the agent as "Photon".
- `client/app/call/CaptionsPanel.tsx` (new) — chat-style transcript:
  caller left-aligned in slate with their initial as an avatar, Photon
  right-aligned in indigo with a "P" avatar, each bubble carrying a name
  label; non-final segments render dimmed/italic with a pulsing caret so
  it's visible which line is still being transcribed. Colour legend in
  the header, autoscrolls to the newest line.
- `client/app/call/page.tsx` — captions state is now `Caption[]` merged
  via `mergeCaption`; renders `<CaptionsPanel>` instead of the inline
  20px-tall grey `<p>` list.

**Verified**: `npx tsc --noEmit` clean, and live in a real browser —
joined the `photon` room, the worker joined and spoke its announcement,
which rendered correctly as a right-aligned indigo "Photon" bubble. The
caller-side (left, slate) rendering was **not** confirmed against real
STT: the user stopped the live test to run their own, and the synthetic-
speech harness kept losing the race with LiveKit's `RoomIO`, which binds
STT to the *first* remote participant that joins — with the browser
joining first, the fake caller's audio was never transcribed at all.
Worth knowing independently of this change: **whoever joins the room
first is the only person the agent listens to.**

### Feature — screen-share vision, actually wired up (was a stub since Phase 4)

The user asked to build this. It was previously a deliberate stub —
`_wants_visual_context` detected a visual question and set
`screen_context = "a screen frame was captured but visual analysis isn't
wired up yet"`, and the compose LLM would honestly say it had no screen
access. Now real:

- **`server/app/tools/evidence.py`** — added `"screen"` to
  `VALID_SOURCE_TYPES`. A screen-frame description is folded into the
  evidence set as a real citable item (`source_type: "screen"`,
  `locator: "screen:{sha1(image_bytes)[:10]}"` — content-addressed so two
  different frames never collide), exactly like a tool result. This was
  a deliberate design choice over passing the description as free-text
  "context": the same "no uncited claim" rule now applies to what's on
  screen as to everything else, and it gets a real `[ev_xxx]` chip in the
  evidence panel.
- **`server/app/agent/loop.py`** — `answer_question()` gained a
  `screen_image_bytes` param. If present, calls `describe_screen()` once
  up front, wraps a successful result as evidence (see above), and skips
  it entirely on failure — never fabricates a description. Also: the
  `if not dedup_evidence: abstain` early-return now naturally allows a
  screen-only answer through if the frame was the only evidence gathered.
- **`server/app/agent/prompts.py`** — `build_compose_prompt()` dropped
  its `screen_context` parameter entirely; passing the same description
  twice (once as free-floating "context", once as citable evidence)
  risked the compose LLM treating the screen half as not needing
  citation. It's evidence now, full stop.
- **`server/app/routers/agent.py`** — `AgentAskRequest` gained
  `screen_image_base64: Optional[str]`, decoded and passed through.
- **`call-agent/orchestrator.py`** — `_handle_turn` now base64-encodes
  `state.latest_screen_frame` and sends it as `screen_image_base64`
  instead of the old stub string. `VISUAL_HINT_RE` was also broadened —
  the ORIGINAL pattern missed a real utterance from testing ("check my
  screen and help me open the search bar?"), matching only "where do i" /
  "this screen" / "on my screen" style phrasing. Now also matches
  "check/look at/share/see (my/the) screen", "what's on (my/the) screen",
  and "help me find/open/see/locate".

**Real blocker hit and resolved while building this**: the obvious choice
was Gemini's direct API (`gemini_vision_model = gemini-3.7-flash`,
already configured, unused since Phase 3). Testing it directly hit the
**exact same free-tier quota wall** as Gemini text generation did in
Phase 3 — confirmed with `ResourceExhausted` after only a handful of
test calls (some earlier calls that looked like plain `DeadlineExceeded`
timeouts were very likely the same quota problem manifesting as a hang
rather than a clean rejection). Fixed the same way Phase 3 fixed it:
moved vision to OpenRouter too. `google/gemini-3.7-flash` is available
there — same model, verified directly to work (fast, accurate, correctly
read text out of a test screenshot) — just billed through OpenRouter
instead of hitting the Gemini API's free tier. `app/core/llm/
gemini_vision.py` was deleted; `app/core/llm/vision.py` replaces it,
calling the new `sync_chat_vision()` in `openrouter.py`. `config.py`'s
`gemini_api_key`/`gemini_chat_model` are now fully unused (kept only
because the key is already in `.env`) — **do not route anything through
Gemini's direct API again without a paid tier**, both the text and vision
models on that key are confirmed to hit the same 20-req/day wall.

**Verified end to end, live, not just unit-level**: `POST /api/agent/ask`
with a real screenshot correctly described the exact text in it (a
search box reading "webhook secret rotation"), the planner intelligently
also called `search_docs` and connected the screen content to real
Meridian documentation (signing-secret rotation), and the final answer
cited both the screen evidence and the doc evidence correctly —
`confidence: high`, not abstained. Then re-tested through
`orchestrator.py` directly (mock adapter, real frame bytes, real HTTP
call to the live brain-api) with the exact phrase that had failed before
("check my screen and help me open the search bar?") — now gets a real,
helpful, cited answer instead of "I don't have access to your screen."

### Fix — planner over-calling tools, plus a wrong-answer regression from fixing it

The user asked to check tool-calling latency, suspecting the planner was
calling tools it didn't need. Confirmed directly: a generic "I would like
to know about Meridian" question was calling `search_docs` AND
`search_code` AND `list_accounts` AND `get_incidents` — four tools for a
question that only needed one. Root cause in `app/agent/prompts.py`'s
plan prompt: "call at most 4 tools this round" is a ceiling with no
incentive toward economy, so the planner defaulted to "gather everything
plausible" rather than being selective.

Fixed by rewriting the plan-prompt guidance to explicitly say most
questions need exactly 1 tool, occasionally 2, with worked examples
mapping question shape to tool choice (account questions -> account
tools, generic product questions -> one search_docs call, not four
tools "to be safe"). Re-verified: the same Meridian question now calls
just `search_docs`; an account question calls only account-scoped tools.

**Caught a real regression from this fix while re-verifying S2**: with
the new "call only 1 tool" framing, the Bangalore pricing "why" question
started calling `explain_why` alone — and got a **wrong answer**:
"Bangalore isn't a special case — it's one of five launch cities with a
base fare table," flatly contradicting the actual `PARTNER_CITY_RATES`
branch verified repeatedly earlier in this build. Cause: `explain_why`
has to self-locate the relevant code from the query text alone, and
without `search_code` alongside it as an independent check, it locked
onto the wrong file (`rate_service.py`'s base-fare table instead of
`pricing.py`'s partner-rate override) and confidently explained the
wrong thing. Fixed by special-casing "why does this code/behavior exist"
questions to call `search_code` + `explain_why` together — re-verified:
correct, fully-grounded answer, still only 2 tool calls (down from the
original 4, not regressed back to it).

**Lesson worth keeping in mind**: minimizing tool calls trades off
against redundant cross-checking. Cutting straight to "1 tool always" is
unsafe for any question where a single tool can silently mis-locate its
target — worth watching for the same failure mode in other tools if
future prompt tightening happens.

### Change — dropped the "Photon" wake word, open mic by explicit request

After the HTTP-client fix above, the user re-tested and reported the
agent still only responded to the initial greeting, nothing else. The
actual log line: they said **"Hello. How are you?"** — no wake word.
`orchestrator.py`'s original design (build plan Phase 4: "explicit
address, not open mic") only forwarded a turn that literally started with
"Photon" — that gate was working exactly as designed, it just wasn't
what they expected in the moment.

The user then explicitly asked to drop the wake word entirely: "dont
need any wakeup word let it start the communication." Done —
`orchestrator.on_speech` now forwards every finalized turn to the brain-
api unconditionally, no gating. `WAKE_WORD_RE` and the wake-word-strip
logic are removed. The client header text (`client/app/call/page.tsx`)
updated to match ("no wake word needed" instead of "say Photon").

**Trade-off now in effect, worth knowing**: with no wake word, side
comments, talking to someone else on the call, or ambient chatter all get
sent to the agent as if they were real questions. The "abstain over
guess" rule still applies, so irrelevant chatter should produce a clean
abstention rather than a fabricated answer (verified: "Hello. How are
you?" through the open-mic path now correctly returns "I don't have
evidence for that..." rather than inventing small talk) — but it does
mean the agent evaluates every utterance, which costs a real API call
each time and could talk over a live conversation if someone's mid-
sentence about something unrelated. If that proves noisy in practice,
reintroducing a lighter-weight local gate (e.g. only calling the brain-api
for utterances that look like questions) would be the next place to look
— not done here since it wasn't asked for.

Also fixed while making this change: the still-running-from-the-previous-
fix-test worker had to be restarted and the agent re-dispatched into the
live `photon` room via LiveKit's Agent Dispatch API (same situation as
the previous fix — killing the worker process drops its agent
participant, and an already-active room doesn't automatically get a new
one), so the room the user is testing in was continuously fixed forward
rather than requiring them to leave and rejoin.

### Fix — the worker closed its own HTTP client right after startup

The user reported audio/TTS not working and asked to check the logs.
Investigated with a rigorous live test (not guessing): synthesized real
speech with macOS `say -o ... --data-format=LEI16@16000`, published it as
a fake microphone track into an isolated LiveKit room via `rtc.AudioSource`
+ `rtc.LocalAudioTrack` (paced in real time, not dumped as one blob), and
watched the worker's own logs.

**What the logs showed**: STT transcribed correctly, wake-word detection
fired, `orchestrator.speech_finalized` logged the right text — but then
`orchestrator.brain_api_error error='Cannot send a request, as the client
has been closed.'`, and the agent spoke its fallback error line instead
of a real answer. Root cause in `call-agent/worker.py`: `entrypoint()`
called `await adapter.start()`, which returns as soon as the
`AgentSession` is up and the announcement has played — it does **not**
block for the life of the call. Execution fell straight through to the
`finally` block, which closed the orchestrator's `httpx.AsyncClient`
while the session kept running in the background. Every real question
asked any time after startup hit a closed client.

Fixed by blocking `entrypoint()` on `ctx.room`'s `"disconnected"` event
before falling into `finally`, so the orchestrator (and its HTTP client)
now lives for the actual duration of the call.

**Re-verified with the identical synthetic-speech method after the fix**:
same question, this time producing a real, fully-grounded, cited answer —
"Bangalore has a special case because Meridian has a reseller/referral
agreement with a partner (BLR Mobility Partners) that gives partner-tier
accounts a 0.88x commission rate in Bangalore only [ev_80abd768,
ev_94f68467]. This is a deliberate business decision, not a bug
[ev_7fa701ec, ev_646abbce]." — confirmed spoken (`conversation_item_added
{role: assistant, ...}`), not just composed. Took ~80s end to end,
consistent with the documented DeepSeek latency variance, but completed
correctly.

**Process note**: while debugging, I killed the running worker to test
the fix, which also dropped the agent's connection to the `photon` room —
where a participant named `rishik` (very likely the user testing live)
was already present. Restarted the worker immediately after: their
existing browser tab should reconnect on its own via LiveKit's automatic
reconnection, but flagging this here in case anything looked like it
glitched mid-session.

### Fix — the join page didn't actually look like a meeting

The user caught a real miss after Phase 5 shipped: `client/app/call/`
never rendered any video. It attached remote *audio* to a hidden `<div>`
and called it done — no video tiles, no participant grid, no visible
screen-share viewer, despite the plan's Section 10 explicitly asking for
"video tiles". The transport itself was genuinely real LiveKit (verified
in Phase 4), but the UI read as a chat app with buttons, not a call.

Fixed by adopting `@livekit/components-react` + `@livekit/components-styles`
(installed, confirmed peer-dep compatible with the already-installed
`livekit-client@2.22.0`/React 19) instead of hand-rolling tile rendering:
`<LiveKitRoom serverUrl token connect audio>` wrapping the `<VideoConference>`
prefab gives real participant tiles, a proper control bar (mic/camera/
screen-share/chat/leave), and screen-share handling for free. A small
`CaptionsBridge` component (using `useRoomContext()` inside the
`LiveKitRoom` tree) forwards STT transcriptions back out to the page so
captions can sit outside `VideoConference`'s own layout. The evidence
panel stays a sibling next to it, not inside — matches the plan's "beside
the video, not inside it."

**Live-verified, not just compiled**: joined as a browser participant —
got a real named video tile ("TestUser") with mic/camera/share-screen/
chat/leave controls, confirmed via console logs as a genuine LiveKit
connection (`connected to Livekit Server ... region: India South`, real
`connecting -> connected` state transitions, not mocked). Then started
`call-agent/worker.py` and it joined the same room as a second tile
(`agent-AJ_...`), with live captions showing real STT transcription of
actual microphone audio in real time. This is now a genuine two-
participant meeting view, not a hidden-audio chat page.

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
