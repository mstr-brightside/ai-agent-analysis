# CLAUDE.md

Local-only tool that ingests coding-agent session logs (Claude Code JSONL, Codex JSONL, Cursor SQLite), classifies the work per turn, prices it at public API list prices, flags suspected waste, and shows the result on one page backed by a JSON API.

The log formats have quirks that explain much of the adapter code (replayed records, Codex cached > input, timestamps running backwards, `[1m]` model names). They are listed with file and line examples in [SPEC.md](SPEC.md) §3. Read it before changing anything in `sources` or pricing.

## Type rules (non-negotiable)
- No `any`, explicit or implicit. External data enters as `unknown` and is parsed with zod.
- No type assertions (`as X`, `<X>`, `!`). `as const` and `satisfies` are fine.
- Every `switch` over a union is exhaustive and ends in `assertNever`.
- No enums: the code runs with Node's native type stripping (`erasableSyntaxOnly`). Use string-literal unions.
- Money is `NanoUsd` (branded integer nano-USD). Never a float, never mixed with token counts. Convert to dollars only at the API or display edge.

## Package boundaries
- `contract` ← imported by `server-node` and `web-plain`. No logic.
- `core` is pure: no I/O, no Node APIs, no knowledge of which source a session came from.
- `sources` depends on `core`. `store` depends on `core`. `server-node` wires everything together.
- `web-plain` talks to the server only over HTTP, through `contract` schemas.
- Never change `core` to suit a transport or UI.

## Privacy rules
- No network calls at runtime. The price table is the only thing ever fetched, once, by hand.
- Prompt text may be stored in the local SQLite store. It is never returned by the API and never written into snapshots.
- The API and page show project **folder names** only, never full paths.
- `HOST` stays loopback-only.

## Data rules
- Never drop a record silently: every record gets a disposition and is counted.
- Missing stays missing: unknown outcomes stay `unknown`, missing usage stays missing, unknown models stay `unpriced`.
- Event order is file or row order, never timestamps.

## Commands
- `npm run check`: type check, lint, tests. Run it before calling anything done.
- `npm start`, `npm run dev`, `npm run ingest`, `npm run eval`, `npm run gen:cursor`.

## Working habits
- Inputs live under `fixtures/`. Do not edit `fixtures/session-logs-dataset/`; it is the vendor dataset.
- Write user-facing text and docs in plain, concrete language.
