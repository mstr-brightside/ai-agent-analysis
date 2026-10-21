# SPEC

Status: implemented (2026-10-11).

## 1. Problem as understood

- A platform lead pays for several coding agents across many engineers. They know the total bill but not:
  - what the sessions are used for,
  - where the money goes,
  - where agents waste money going in circles.
- The logs live on engineers' laptops. Source code and prompts must not leave the machine.
- Deliverable: a local-only tool that ingests agent session logs, classifies the work, prices it, flags suspected waste, and shows the result through an HTTP API and one plain page.

## 2. Scope

### In scope
- Sources (paths from the env file; see §4.2):
  - Claude Code JSONL (`~/.claude/projects/**/*.jsonl` shape)
  - Codex JSONL (`~/.codex/sessions/**/*.jsonl` shape)
  - Cursor SQLite (synthetic fixture modelled on the real `state.vscdb` layout, see §6)
- Normalized model: sessions → turns → events, with tokens, model, timestamps, tool name and outcome.
- Every record gets a disposition: `processed`, `recognized-unused`, `duplicate`, `malformed`, `unknown`. Counts are shown; nothing is dropped silently.
- Turn-level classification with explainable rules, plus a session primary category, plus a hand-labelled evaluation.
- Per-event pricing from a committed public price table, aggregated per turn, session and category.
- Pricing cross-check against the OTel `cost_usd` field (§4.6).
- Extra: waste detector with two separate signals, failure streaks and correction streaks (§4.7).
- Incremental ingestion: full read on first run, then only new data.
- Snapshot history: each ingest stores the report it produced.
- HTTP API (§4.8) and one plain page that reads it.

### Deliberate departures from the brief
- **Three log formats instead of one.** We treat this as a potential product. Each source adapter is independent; the core (normalize → classify → price → detect → report) does not know which source a session came from.
- **OTel JSONL is not ingested.** It describes the same 34 sessions as the Claude JSONL, so ingesting both would double-count spend. It is used instead as an independent pricing oracle (§4.6).

### Out of scope
- Live OTLP collection (next step).
- Automatic discovery of installed agents. Paths are explicit.
- Continuous file watching. Ingestion runs at startup and on demand.
- Model-choice analysis (second extra).
- Multi-process or concurrent writers to the local store. Single process assumed.
- Encryption of the local store at rest (next step).
- Recording the video (done separately by the author).

## 3. Format findings

Paths are relative to `fixtures/session-logs-dataset/`.

### The two strongest findings

**A. The Claude log replays earlier records, so a naive sum double-charges.**
- Data: `claude-code/projects/-home-dev-projects-recipe-web/b7dab20e-479d-4d1b-b6e4-8ac4e6451e08.jsonl` lines 2 and 46 are the same assistant record (`uuid` `ea87143f-b5f4-4cc8-a02a-2b1f75f5961b`, message `msg_bf1953ec680544d2bff579fa`, usage included). 22 records in the Claude data are replays like this.
- Evidence that dedupe is right: OTel has 465 `api_request` events, exactly the number of unique Claude `message.id`s.
- Handling: identity is the record `uuid` ([claude.ts:208](packages/sources/src/claude.ts:208)); a seen identity becomes `duplicate` ([ingest.ts:89](packages/server-node/src/ingest.ts:89)); usage is charged at most once per `message.id` ([analyze.ts:102](packages/core/src/analyze.ts:102)). Covered by the golden test (22 duplicates) and unit tests.

**B. Codex reports more cached tokens than input tokens.**
- Data: `codex/sessions/2026/08/rollout-2026-08-09T18-00-00-0116ccc5-0b7a-4cd7-ad35-8d7fc1d3b88d.jsonl` line 5: `last_token_usage` has `input_tokens` 9,376 and `cached_input_tokens` 19,001. In OpenAI's usage format cached tokens are a subset of input, so this cannot be true as documented. It happens in 55 of 130 `token_count` events. The same file also shows why the running total must never be summed: by line 63 `total_token_usage.input_tokens` is 308,513 while that call's `last_token_usage.input_tokens` is 18,839.
- Handling: OpenAI semantics, fresh input clamped to 0, call marked `estimated` and kept apart in every total ([codex.ts:93](packages/sources/src/codex.ts:93)). 48 priced calls are `estimated` (the other 7 are in the unpriced `gpt-5.5-codex` session).

### Everything observed

Survey on 2026-10-11, extended during implementation (items 12–16).

Dataset shape: Claude JSONL 34 sessions / 34 files, CLI versions 1.0.83, 2.0.14, 2.1.3, 2.3.0. Codex JSONL 12 sessions, CLI 0.42.0 and 0.51.2, models `gpt-5.5`, `gpt-5.5-codex`, `gpt-5-mini`, single tool `shell`. OTel JSONL 1,071 events (`user_prompt`, `api_request`, `tool_result`) for the same 34 Claude sessions.

1. **Duplicate records in Claude JSONL.** `claude-code/projects/-home-dev-projects-recipe-web/b7dab20e-….jsonl` re-writes 22 earlier records with identical `uuid` (e.g. lines 2 and 46 are the same assistant message, `msg_bf1953ec…`). Summing usage naively double-charges these calls. The OTel file has 465 `api_request` events, exactly the number of unique Claude `message.id`s, which confirms dedupe by id is correct.
2. **Codex `cached_input_tokens` exceeds `input_tokens`** in 55 of 130 `token_count` events. In OpenAI's usage format cached tokens are a subset of input, so this cannot be true as documented.
3. **Timestamps go backwards in both formats.** Codex: 157 records where a `function_call_output` or `token_count` is stamped earlier than the record before it. Claude: 22 such records.
4. **Version differences in Claude usage.** CLI 1.0.83 records carry only `input_tokens` / `output_tokens` (59 records; one 1.0.83 Haiku record is the exception and has cache fields); 2.x records add `cache_read_input_tokens` / `cache_creation_input_tokens`. No record splits cache writes by TTL.
5. **Model names that are not price-list keys.** `claude-sonnet-4-5-20250929[1m]` (1M-context suffix) and `claude-sonnet-5`.
6. **Codex token usage is cumulative.** `total_token_usage` is a running total; `last_token_usage` is the per-call increment. Summing `total_token_usage` would massively overcount.
7. **Malformed line.** `claude-code/projects/-home-dev-projects-ledger-cli/6061f190-….jsonl:7` is truncated JSON.
8. Codex rollout files dated September 2026 sit under `codex/sessions/2026/08/` (directory date ≠ file date).
9. **OTel `cost_usd` matches Anthropic list prices with 5-minute cache writes.** Checked by hand: Opus 4.1 request (in 341, out 562, cache read 58,269, cache write 1,988) = $0.171943; Sonnet 4.5 request (126 / 1,147 / 47,689 / 3,299) = $0.044261. So cache writes without a TTL split are priced at the 5-minute rate (1.25 × input).
10. **OTel prompts are redacted inconsistently.** 110 of 192 `user_prompt` events have `prompt: null`, the rest carry text.
11. Claude user prompt `content` is sometimes a plain string and sometimes an array of `{type: "text"}` blocks (23 string vs 173 array). Claude has 12 `summary` records (no `sessionId`, `version` or `timestamp`).
12. **Codex output text and exit code disagree** in 59 of 130 `function_call_output` records (e.g. output `FAILED tests/test_parse.py::test_rounding` with `exit_code: 0`). Outcomes follow `exit_code` as decided (§4.7); judged by output text instead, one more failure streak would qualify (`go test ./...`, 3 in a row, Codex session `0116ccc5`). Found during implementation, 2026-10-11.
13. **No vendor session has a qualifying failure streak.** The longest run of failures on one tool + target in the Claude and Codex data is 2 (checked by the detector and by an independent script). The only failure streak in the report is the one seeded into the synthetic Cursor fixture. Correction streaks do occur in the vendor data.
14. **The OTel oracle disagrees with the official price page in two places** (reconciliation, 2026-10-11: 346 of 465 requests match within $0.000001):
    - `claude-sonnet-5` (37 requests): OTel prices at $3/$15 per MTok. The official page says $2/$10 is the standard price and the planned rise to $3/$15 "will not occur". We follow the page.
    - `claude-sonnet-4-5-20250929[1m]` (57 requests): OTel charges long-context rates ($6 / $22.50 / $0.60 / $7.50) on every `[1m]` request, although none exceeds 94k input tokens. We price `[1m]` at the base rate (§4.5).
15. **One Claude file is not in chronological order.** In `claude-code/projects/-home-dev-projects-ledger-cli/3888cf6f-….jsonl` the assistant messages are shuffled relative to OTel's (timestamp-ordered) `api_request` events. Pairing by position (§4.6) then fails for 15 requests: their token counts do not agree, so they are reported as mismatches, not forced. Matched by token counts instead, all 16 requests with usage would pair up.
16. 10 Claude assistant messages carry no `usage`; OTel has token counts for all 10. Missing stays missing: they are `unpriced` in the report and `no-usage-in-log` in the reconciliation.

## 4. Decisions on points the brief leaves open

### 4.1 Stack and structure
- TypeScript on Node 24, run directly with Node's native type stripping (no build step for server code).
- Type rules (enforced, not advisory):
  - tsconfig: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `erasableSyntaxOnly` (no enums).
  - typescript-eslint: `no-explicit-any`, `consistent-type-assertions: never`, `switch-exhaustiveness-check`; an `assertNever` helper for every union switch.
  - `npm run check` = `tsc --noEmit` + eslint + tests.
- Runtime dependency: **zod** only. It validates every external input (env, log records, SQLite rows) from `unknown`, and its schemas are the written-down shape of each vendor format. Everything else is Node built-ins: `node:sqlite`, `node:http`, `node:test`.
- npm workspaces, boundaries enforced by package dependencies:

| Package | Responsibility |
|---|---|
| `packages/contract` | zod schemas and types for every API response; shared by server and UI |
| `packages/core` | Pure logic: normalized model, turn segmentation, classification, pricing, waste detection, report building |
| `packages/sources` | Claude, Codex and Cursor adapters: read raw data, validate, assign dispositions, emit normalized events |
| `packages/store` | `node:sqlite` storage behind a repository interface |
| `packages/server-node` | `node:http` transport adapter |
| `packages/web-plain` | Plain HTML page that consumes the JSON API |
| `tools/gen-cursor-fixture` | Seeded generator for the synthetic Cursor DB |

- Swapping the server (Hono, NestJS…) or the UI (React, TanStack…) means adding a sibling package; core, sources and store stay untouched.

### 4.2 Configuration
- Variables: `CLAUDE_LOGS_DIR`, `CODEX_LOGS_DIR`, `CURSOR_DB_PATH`, `OTEL_EVENTS_PATH`, `DATA_DIR`, `PORT`, `HOST` (default `127.0.0.1`).
- `OTEL_EVENTS_PATH` points at a Claude Code OTel events JSONL file used only for the pricing cross-check (§4.6). Same rules as a source path (declared; empty = off; bad path = refuse to start), but it is not a source and does not count toward "at least one source on".
- No credential variables for SQLite: SQLite has no users or passwords.
- Loaded with Node's built-in `process.loadEnvFile()` (no dotenv). `.env.example` is committed; `.env` is git-ignored.
- An env checker validates the environment with a zod schema at startup. On failure it prints every invalid variable and refuses to start. The application never runs with a half-resolved configuration.
  - Every variable must be **declared**. Forgetting one is an error.
  - A source path declared **empty** (`CODEX_LOGS_DIR=`) means that source is deliberately off. At least one source must be on.
  - A non-empty source path that does not exist or is unreadable stops startup, naming the variable and the problem.
  - `PORT` is an integer 1–65535. `DATA_DIR` is created if missing.
  - `HOST` must be loopback (`127.0.0.1`, `::1`, `localhost`). "Local-only" is enforced, not just defaulted.
- In a production deployment the same fail-fast rule would hold for platform-managed configuration: with Cloudflare Wrangler, for example, the app must not start if a binding or variable it requires is unresolved or empty.

### 4.3 Ingestion and storage
- Storage: `node:sqlite`, one transaction per ingest. A failed ingest rolls back completely; a corrupt database is reported, never silently recreated.
- First run reads everything. Later runs read only new data:
  - **JSONL:** per file, store path, byte offset, size and a hash of the first 4 KB. Longer file with the same head → continue from the offset. Shorter file or changed head → truncated or replaced: full re-read with dedupe, reported in the run result. An incomplete last line (no trailing newline) is not consumed. Session identity comes from `sessionId` inside the records, not the file name.
  - **Cursor SQLite:** opened read-only (Cursor may hold it open); brief retry on lock, then reported as unavailable for this run. Never copied or modified. A hash per key detects new or changed values (`composerData` changes in place; bubbles are written once).
- After an ingest, only sessions that received new events are recomputed. A change of classifier or pricing version triggers a full recompute from stored events, without re-reading sources.
- Ingestion runs at startup and on `POST /api/ingest` (a Refresh button on the page). No file watching.
- Normalized events are persisted; reports are recomputed from stored events, because new records can belong to existing sessions.
- An ingest stores a snapshot **only when something changed** (new records, or a classifier or pricing version change). Otherwise it returns "no changes" and the latest snapshot id. Snapshots are kept indefinitely. The latest report never adds snapshots together.
- Event order is **file order** (or row order for SQLite). Timestamps are kept as data but never used for ordering, because they go backwards in both JSONL formats.
- Duplicates: a record whose source-native identity has already been seen (Claude `uuid`; Codex file + line) gets the `duplicate` disposition and is counted. Usage is charged at most once per Claude `message.id`.
- Dispositions per source:
  - Claude: `user`, `assistant` → `processed`; `summary` → `recognized-unused`; unknown `type` → `unknown`; known type failing its schema → `malformed`.
  - Codex: `session_meta`, `message`, `function_call`, `function_call_output`, `token_count` → `processed`; other payload types → `unknown`.
  - Cursor: `composerData:*`, `bubbleId:*` → `processed`; other known Cursor key families → `recognized-unused`; anything else → `unknown`.
  - Blank lines are not records; they are counted and shown separately.
- Errors: a file that cannot be read is recorded as a file-level error, other files continue, and the run is marked `partial`. A second ingest while one is running gets `409 Conflict`.
- Versions: the classifier version and pricing version are **content hashes** of the rule definitions and price table, so any change triggers a recompute automatically. Both appear in every snapshot.
- Store schema: numbered migrations at startup. A database written by newer code makes startup refuse with a clear message. Snapshots are not reproducible, so the store is never wiped silently.
- Speed targets (measured and reported in README): cold full ingest of the dataset < 1 s; ingest with nothing new < 50 ms. Reads stream from the stored offset; writes use prepared statements in one transaction.
- Generated data (`DATA_DIR`) is git-ignored.

### 4.4 Classification
- Taxonomy: `plan | research | implement | debug | test | refactor | review | ops | unknown`.
- Unit: the **turn** = an intent prompt plus all work up to the next intent prompt.
- Every user prompt gets a kind, checked in this order:
  1. `ack` ("Thanks — ship it", "Looks good. Move on…", "Great, that works. Commit it…"): joins the current turn.
  2. `correction` ("Wrong file…", "No — that broke…", "You hallucinated…", "Too much. Undo…"): joins the current turn and is counted.
  3. `intent`: opens a new turn and is classified.
- Category spend = sum of turn spend. Each session also gets a **primary category**: the category with the highest spend in that session. Ties: more turns wins, then priority order; a session whose turns are all `unknown` is `unknown`.
- **Session count by category** counts each session once, under its primary category, so the counts sum to the total. Turn counts are reported alongside, plus "sessions touching this category" (labelled: a session can count in several).
- Edge cases, so that turn spend always sums exactly to session spend:
  - A session that opens with an ack or correction: that prompt becomes an `intent` turn.
  - Assistant spend before the first user prompt, or in a session with no prompt: its own turn, category `unknown`, rule `no-prompt`.
  - Claude sidechain records (`isSidechain: true`) belong to the turn they occur in, by file order.
- Pipeline:
  1. **Prompt rules**: regex rules with ids, in priority order `plan > review > debug > test > refactor > ops > research > implement`. The most specific category wins; `implement` is the catch-all for build requests.
  2. **Tool-shape fallback**, only when no prompt rule matches: only Read/Grep/Glob → `research`; mostly Edit/Write → `implement`; mostly test commands → `test`.
  3. Otherwise `unknown`.
- Each result stores category, the rule that fired, every other rule that matched, and evidence (source reference, not copied prompt text).
- Evaluation: 30 turns, sampled with a fixed seed across sources and projects, labelled **before** looking at predictions. Report agreement, Cohen's kappa, a confusion table and concrete misclassifications.
- Held-out check: 40 prompts written and labelled by a separate sub-agent in wording unlike the dataset's templates (`eval/heldout.csv`), committed before scoring and never used to tune rules. Classified from the prompt alone (no tools), reported next to the 30-turn result.
- Caveats on the evaluation:
  - The dataset's prompts are synthetic and templated (e.g. "Implement cursor-based pagination in README.md"). Keyword rules can match the generator's templates closely, so agreement here probably **overstates** accuracy on real logs.
  - Labels are produced by a separate AI sub-agent with a fresh context, from a sheet showing only prompt text and tools used. It never sees the rules, and labels are saved before any classifier code exists. This removes the rule-author/labeller loop, but the labeller is still a model, not a human, and shares the same blind spots about templated prompts.

### 4.5 Pricing
- Every figure is **estimated at public API list prices**, in API field names and on the page. Claude Code and Cursor users are often on flat-rate plans or credits; list price is our common yardstick across tools, not the customer's actual bill.
- Price each usage event, then aggregate by turn, session and category.
- Money is stored and summed as **integer nano-USD** (branded `NanoUsd` type). Every list rate is a whole number of nano-USD per token ($0.30/MTok = 300, $18.75/MTok = 18,750), so sums are exact up to ~$9M. Conversion to dollars happens only at the API and display edges.
- Price table: a TypeScript module checked with `satisfies` against a `PriceTable` type (typos fail compilation). Each entry carries model-name mappings, per-token rates, official source URL and retrieval date. The only network access is building this table once. Nothing is fetched at runtime.
- Cursor events are priced only when both a token count and a concrete model are present. `auto`, zero or missing tokens → `unpriced`.
- Fresh input, cache reads, cache writes and output are priced separately where the format carries them.
- Model names:
  - `…[1m]` suffix is stripped and priced at the base rate. The long-context tier rule (>200k input tokens) is still implemented; no request in the dataset exceeds 94k.
  - Names not found on an official price page stay `unpriced`. No guessing from similar names.
  - Price table as built on 2026-10-11 (`packages/core/src/pricing/price-table.ts`): `gpt-5.5-codex` (1 Codex session) is on neither OpenAI's pricing page nor a model page, so it is `unpriced`. Anthropic's current page lists no >200k tier for Sonnet 4.5 (Claude 4.6+ get 1M context at standard rates), so the tier rule is data-driven per entry; today only `gpt-5.5` has one (>272k input tokens).
- Pricing status per event, carried up to every total:
  - `complete`: all fields present and priced.
  - `complete-no-cache-data`: the format has no cache fields (Claude CLI 1.0.83). Priced as a lower bound and counted separately.
  - `estimated`: Codex events with `cached_input_tokens > input_tokens`. OpenAI semantics are applied (cached ⊂ input), fresh input is clamped to 0, and the anomaly is counted.
  - `unpriced`: model not in the price table, or no usage.
- Codex `reasoning_output_tokens` are already part of `output_tokens`; they are not charged again.
- Duplicated usage is charged once (§4.3).

### 4.6 Pricing cross-check (OTel oracle)
- Each OTel `api_request` event carries `cost_usd`. Matching: same session; the n-th OTel `api_request` pairs with the n-th unique Claude `message.id` in file order. Token counts must agree exactly before cost is compared; otherwise the pair is reported as a mismatch, not forced.
- Our price for a matched request must equal `cost_usd` within $0.000001.
- Implemented as an automated test and shown on the page as a reconciliation panel: matched requests, mismatches with both values, and unmatched requests on either side.
- The OTel file is read on every ingest from `OTEL_EVENTS_PATH`; the reconciliation result is stored with the snapshot. When the variable is empty, `/api/reconciliation` reports `off`.

### 4.7 Waste detector
Two separate signals, each with its own evidence, never merged into a single score:
- **Failure streak.** 3 or more consecutive failures among invocations of the **same tool with the same normalized target**. Other tool calls may occur in between.
  - Target: Claude `Bash` → command with whitespace collapsed; `Edit`/`Write`/`Read` → `file_path`; `Grep`/`Glob` → pattern + path; Codex `shell` → joined command with a leading `bash -lc` removed; Cursor → fixture tool fields.
  - Outcome: Claude `is_error`; Codex `exit_code ≠ 0`. A call with no result, or a missing outcome field, is `unknown`: it neither extends nor breaks a streak.
- **Correction streak.** 2 or more consecutive correction prompts (§4.4). An `ack` or `intent` prompt ends the streak.
- Output per session: streak length, the evidence (which events and turns), cost incurred during the streak, and total session cost. Ranked by streak length.
- Named *suspected* on purpose: repeated failure or correction does not prove the money was wasted.

### 4.8 API
- `GET /api/summary` — latest report; `?snapshot=<id>` for an earlier one.
- `POST /api/ingest` — read new data; returns the new snapshot id (or "no changes") and what changed.
- `GET /api/snapshots` — list of snapshots.
- `GET /api/sessions?category=&source=&flagged=` — session list with waste evidence.
- `GET /api/reconciliation` — OTel pricing cross-check.
- Response shapes are zod schemas in `packages/contract`. Server and UI both import them; the UI validates every response, so a replacement server or UI cannot drift from the contract.
- Projects are shown by **folder name only** (`recipe-web`). Full `cwd` paths stay in the local DB, because real paths leak user and client names.
- Page: TypeScript compiled by `tsc`, no framework, hand-rolled SVG charts, served as static files by the server package. Light and dark. Sections, top to bottom:
  1. Header: snapshot picker, Refresh (`POST /api/ingest`), analysis time, "estimated at public API list prices" badge.
  2. Headline numbers: total estimated spend, sessions, turns, % of spend fully priced, % of records unparsed.
  3. What sessions are used for: turns and spend per category, filterable by source.
  4. Where the money goes: spend per category stacked by pricing status, unpriced tokens alongside; per-model table.
  5. Coverage: per source, records by disposition; unclassified turns and sessions, with denominators.
  6. Suspected waste: ranked streaks, expandable evidence (normalized target, outcome sequence, cost during streak).
  7. Pricing reconciliation: OTel matched n/n, largest difference, mismatches.

### Commands
- `npm run dev`: watch package source files and settings, rebuild the page on saves, restart the local server, and reload the browser. Development only; no new dependencies. A failed page build keeps the previous server running.
- `npm start`: ingest, then serve.
- `npm run ingest`: ingest only, print the summary as JSON.
- `npm run eval`: classifier agreement report.
- `npm run gen:cursor`: rebuild the Cursor fixture.
- `npm run check`: type check, lint, tests.

### 4.9 Reporting
- Two separate denominators, never mixed:
  - records: unparseable or unrecognized / total records,
  - turns and sessions: unclassified / total.
- Spend is split by pricing status, so complete, lower-bound, estimated and unpriced amounts are never blended silently.
- Default `PORT=4680`, chosen to avoid common dev ports and OTLP 4317/4318.

## 5. Privacy: how customer and employer data is kept out
- Inputs are the vendor's synthetic dataset (stated to contain no real prompts) and a Cursor fixture we generate ourselves. No real session logs are used or committed.
- Analysis makes no network calls. Classification is rule-based and local.
- Prompt text **is stored locally** in the SQLite store under `DATA_DIR`, next to the original logs on the same machine, so the classifier can re-run without re-reading sources. It is **never returned by the API** and **never written into snapshots**. Evidence references a source location and a rule id instead.
- `DATA_DIR` and `.env` are git-ignored.

## 6. Synthetic Cursor data
- The dataset has no Cursor data. A seeded, deterministic generator (`tools/gen-cursor-fixture`, `npm run gen:cursor`) writes `fixtures/cursor/state.vscdb`.
- Layout mirrors Cursor's real `state.vscdb`: a `cursorDiskKV` key-value table with `composerData:<composerId>` and `bubbleId:<composerId>:<bubbleId>` JSON values.
- Contents: ~10 composers across 2–3 schema versions; models `claude-4.5-sonnet`, `gpt-5`, `auto`; Cursor tool shapes (`run_terminal_cmd`, `edit_file`, `read_file`, `grep_search`) with `completed`/`error` status; prompts in the dataset's template style, including corrections.
- Realistic gaps on purpose: `tokenCount` present, zero or missing; `auto` hides the real model and stays unpriced; project folder recorded only in the newest schema version.
- Seeded on purpose: one failure streak, one correction streak, one malformed JSON value, some recognized-but-unused key families.
- The fixture is labelled synthetic wherever it is shown.
- All inputs live under `fixtures/` (`fixtures/session-logs-dataset/`, `fixtures/cursor/`).

## 7. Verification
- Unit tests with tiny inline fixtures; one golden integration test over the real dataset (dispositions per source, session and turn counts, total nano-USD), with the golden numbers checked by hand once.
- Hand-calculated cost example covering cache fields.
- OTel cross-check: every matched Claude request prices within $0.000001 of `cost_usd`.
- Malformed and unknown records are counted.
- Duplicate usage is not charged twice.
- Codex cumulative usage: per-call increments are summed, not running totals.
- Loop detector separates a qualifying streak from ordinary failures.
- Incremental run: re-running on unchanged input adds nothing; appending lines adds only those lines.
- Two runs survive a restart without doubling the latest report.
- Env checker refuses to start on missing or invalid variables.
- Manual: startup, endpoints, page, empty input, invalid path.
