# Agent spend

A local-only tool for a platform lead who pays for coding agents across a team. It reads the agents' session logs on the machine where they are written, and answers three questions:

- **What are the sessions used for?** Every turn (one request plus the agent's work on it) is put into a category: plan, research, implement, debug, test, refactor, review, ops, or unknown.
- **Where does the money go?** Every model call is priced at public API list prices and summed per turn, session, category and model.
- **Where do agents go in circles?** Two separate "suspected waste" signals: repeated failures of the same tool on the same target, and the developer correcting the agent several times in a row.

It reads Claude Code JSONL, Codex JSONL and a Cursor SQLite database (a synthetic one is included). Results come out as a JSON API and one plain web page. Nothing is sent anywhere: no network calls at runtime, the server binds to loopback only, and prompt text and full paths never leave the local store.

All amounts are **estimates at public API list prices**. They are a common yardstick across tools, not the bill: Claude Code and Cursor users are often on flat-rate plans.

## Run it

Needs Node.js 24 or newer (it runs TypeScript directly, and uses the built-in `node:sqlite`).

```bash
npm install
```

```bash
cp .env.example .env
```

```bash
npm start
```

Then open http://127.0.0.1:4680/. `npm start` builds the page, ingests everything, and serves. The `.env.example` values point at the inputs in `fixtures/`.

For development, use `npm run dev` instead. Saving HTML, CSS, TypeScript, or package settings rebuilds the page, restarts the server, and reloads the browser automatically. Changes to `.env` also restart it. A failed page build leaves the last working server running until you fix the errors and save. Reloads reset the page's current selection. Press Ctrl+C to stop.

### Commands

| Command | What it does |
|---|---|
| `npm start` | Ingest, then serve the API and page on `HOST:PORT` |
| `npm run dev` | Watch source files, rebuild, restart, and reload the browser |
| `npm run ingest` | Ingest only; prints the latest summary as JSON on stdout (progress on stderr) |
| `npm run eval` | Classifier evaluation; writes `eval/results.md` |
| `npm run gen:cursor` | Rebuild the synthetic Cursor database `fixtures/cursor/state.vscdb` (deterministic) |
| `npm run check` | Type check (every package), lint, all tests |

### Configuration (`.env`)

Every variable must be declared; the app refuses to start and lists every problem otherwise. An empty source path turns that source off; at least one source must be on.

| Variable | Meaning |
|---|---|
| `CLAUDE_LOGS_DIR` | Claude Code projects directory (real install: `~/.claude/projects`) |
| `CODEX_LOGS_DIR` | Codex sessions directory (real install: `~/.codex/sessions`) |
| `CURSOR_DB_PATH` | Cursor `state.vscdb` (opened read-only, never modified) |
| `OTEL_EVENTS_PATH` | Claude Code OTel events JSONL, used only to cross-check prices. Empty = off |
| `DATA_DIR` | Local store (SQLite). Created if missing; git-ignored |
| `HOST` | Must be loopback: `127.0.0.1`, `::1` or `localhost` |
| `PORT` | 1–65535 (default in the example: 4680) |

Environment variables already set in the shell take precedence over `.env`.

## API

| Endpoint | Returns |
|---|---|
| `GET /api/summary[?snapshot=<id>]` | The report: headline numbers, categories (also per source), spend by pricing status, models, coverage, suspected waste |
| `GET /api/sessions?category=&source=&flagged=` | Sessions with their turns, models and waste evidence (optional `snapshot=`) |
| `GET /api/snapshots` | Every stored snapshot, newest first |
| `GET /api/reconciliation[?snapshot=<id>]` | OTel pricing cross-check |
| `POST /api/ingest` | Read new data; returns the new snapshot, or `no-changes` |

Response shapes are zod schemas in [`packages/contract`](packages/contract/src/index.ts); the server and the page both use them, and the page rejects any response that does not match. Money is in US dollars at the API; internally it is integer nano-dollars. Projects appear by folder name only (`recipe-web`); prompt text is never returned, only the location of a prompt (`file:line` or a Cursor key).

## Results on the provided data

From the vendor dataset (34 Claude sessions, 12 Codex sessions) plus the synthetic Cursor fixture (10 sessions):

- **Estimated spend $43.34** over 56 sessions and 175 turns. By source: Claude Code $38.013590250, Codex $4.833722350, Cursor (synthetic) $0.493486250. These totals were checked against an independent script and are frozen in the golden test.
- **88% of spend is fully priced.** The rest is a lower bound (Claude Code CLI 1.0.83 and Cursor record no cache fields) or estimated (Codex records that report more cached tokens than input tokens). 34 calls stay unpriced: `gpt-5.5-codex` is not on OpenAI's pricing page, Cursor `auto` hides the model, and 10 Claude messages carry no usage.
- **Coverage:** 1,713 records, all accounted for: 3 unparsed (1 truncated Claude line, 1 malformed and 1 unknown Cursor key), 22 duplicates (Claude records written twice). 1 of 175 turns is unclassified.
- **Suspected waste:** 10 correction streaks (the longest: 4 corrections in a row, $1.52 of a $3.24 session). One failure streak, and it is the one seeded into the synthetic Cursor data: **no vendor session has 3 failures in a row on one target** (SPEC §3 item 13).
- **Pricing cross-check:** 346 of 465 OTel requests match our price within $0.000001. Every mismatch has a known cause: OTel prices `claude-sonnet-5` at $3/$15 where the official page says $2/$10 (37); OTel charges long-context rates on every `[1m]` request although none is long (57); one Claude file is not in chronological order, so pairing by position fails (15); 10 log messages have no usage. See SPEC §3 items 14–16.

## Classifier evaluation

`npm run eval` scores two sets ([eval/results.md](eval/results.md)):

| Set | Agreement | Cohen's kappa |
|---|---|---|
| 30 turns sampled from the inputs, labelled blind by a separate AI sub-agent | 30/30 (100%) | 1.000 |
| 40 held-out prompts in varied wording, written and labelled by another sub-agent, never used for tuning | 15/40 (37.5%) | 0.306 |

Read the first number as "the rules cover the dataset's prompt templates", not as accuracy: the dataset's prompts are filled-in templates, and the rule author saw those labels before writing the rules (NOTES.md). The second number is the honest one for real logs. The keyword rules miss most phrasings they were not written for; in 16 of the 25 misses they say `unknown` rather than guessing wrong.

## How it works

```
sources (adapters) ──► store (SQLite: events, analyses, snapshots) ──► core (pure) ──► server-node ──► web-plain
 Claude / Codex /        one transaction per ingest                   turns, classify,   node:http      plain TS page
 Cursor → normalized                                                  price, streaks,    JSON API       via contract
 events + dispositions                                                report
```

| Package | Responsibility |
|---|---|
| [`contract`](packages/contract) | zod schemas for every API response; no logic |
| [`core`](packages/core) | Pure logic, no Node APIs (compiled without Node types): normalized model, turn segmentation, classifier, price table and pricing, waste detectors, report |
| [`sources`](packages/sources) | Claude, Codex and Cursor adapters, incremental JSONL reader, OTel reconciliation |
| [`store`](packages/store) | `node:sqlite` store with numbered migrations |
| [`server-node`](packages/server-node) | Env checker, ingest orchestration, `node:http` API, CLIs |
| [`web-plain`](packages/web-plain) | The page: TypeScript compiled by `tsc`, no framework, hand-rolled SVG charts, light and dark |
| [`tools/gen-cursor-fixture`](tools/gen-cursor-fixture) | Seeded generator for the Cursor database |
| [`tools/eval`](tools/eval) | Evaluation sheet builder and `npm run eval` |

Key behaviour (details in [SPEC.md](SPEC.md)):

- **Every record gets a disposition** (processed, recognized-unused, duplicate, malformed, unknown) and is counted. Missing stays missing: no outcome is `unknown`, no usage is unpriced, an unknown model is unpriced.
- **Event order is file order** (row order for SQLite), never timestamps: timestamps go backwards in both JSONL formats.
- **Incremental ingest:** per JSONL file the byte offset, size and a hash of the first 4 KB; only new lines are read, a partial last line waits, a truncated or replaced file is re-read with dedupe. Cursor keys are tracked by value hash. Only sessions with new events are recomputed, unless the classifier or price table changed (their versions are content hashes), in which case everything is.
- **Snapshots** are stored only when something changed; the latest report never adds snapshots together.
- **Type rules:** no `any`, no type assertions, exhaustive switches ending in `assertNever`, no enums; external data enters as `unknown` and is parsed with zod, including rows read back from SQLite.

## Speed

Measured on this machine (Windows 11, Node 24.16), 5 runs each, full inputs (all three sources and the OTel file):

| | Ingest itself | Whole `npm run ingest` process |
|---|---|---|
| Cold (empty store) | 156–174 ms | 494–560 ms |
| Nothing new | 22–27 ms | 322–369 ms |

Targets were < 1 s cold and < 50 ms with nothing new; the process times include about 300 ms of Node startup.

## What works, what does not

Works and is tested (174 tests): the env checker; all three adapters with their dispositions; incremental ingest (append, partial line, truncation, replacement, restart, rollback, version change); pricing for all four statuses including a hand-calculated cache example; both waste detectors with near misses; the golden totals; the OTel cross-check; the HTTP API, including the Host check and path guard. Checked by hand: the page at desktop and phone width, light and dark; the Refresh button (nothing new); appending a line to a scratch copy of a log and calling `POST /api/ingest` (exactly the new call's $0.0045 was added, the earlier snapshot unchanged); every endpoint with curl; startup with an empty input, an invalid path and missing variables.

Known limits:

- **Classification is keyword rules.** Good on the dataset's templates, weak on other wording (37.5% held-out). Prompts in other languages are not understood.
- **Codex outcomes follow `exit_code`.** In 59 of 130 Codex results the output text says `FAILED` while the exit code is 0 (SPEC §3 item 12); judged by text, one more failure streak would appear.
- **OTel pairing is by position.** It fails, visibly, for the one Claude file whose lines are not in chronological order.
- **Ingest is synchronous.** It takes well under a second here; concurrent requests wait for it. The 409 guard only fires if an ingest is re-entered.
- **Records are never removed.** A replaced file's old events stay; re-read lines count as duplicates. A deleted Cursor key is not removed. A Cursor row written between rows that were already ingested sorts after them (this only happens if the database is rewritten, e.g. regenerating the fixture; Cursor itself appends).
- **Codex model changes mid-session** (`turn_context` records in newer CLIs) are not read: those payloads count as `unknown`, and the model comes from `session_meta`.
- A run in which only read errors change does not create a snapshot; the errors are in the ingest response.
- The local store is not encrypted. Prompt text is stored there, next to the original logs.

## What I would do next

- Better classification without sending prompts anywhere: a small local model, or rules grown from the held-out misses, judged on a fresh held-out set.
- Live OTLP collection, and file watching instead of Refresh.
- Model-choice analysis: which work could have run on a cheaper model.
- Read Codex `turn_context` and the newer `event_msg` types.
- Fallback OTel matching by exact token counts when positions disagree.
- Encrypt the local store; automatic discovery of installed agents.

## More

- [SPEC.md](SPEC.md): what was built, and the format findings (§3) with file and line references.
- [NOTES.md](NOTES.md): how AI was used, where it was wrong and how that was caught.
- [CLAUDE.md](CLAUDE.md): rules for agents working in this repo.
