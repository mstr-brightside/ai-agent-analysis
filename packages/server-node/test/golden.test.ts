// Golden integration test over the real inputs (vendor dataset + generated Cursor fixture).
// The spend totals were checked once against an independent script that shares no code
// with the app (one pass over the raw files with the price table typed in by hand), then
// frozen here. A change in any of these numbers is a behaviour change: explain it or fix it.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { ReconciliationResponse, Source, SummaryResponse } from '@agentspend/contract';
import { Store } from '@agentspend/store';
import { ingest } from '../src/ingest.ts';
import { reconciliationResponse, summaryResponse } from '../src/read.ts';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const DATASET = path.join(ROOT, 'fixtures/session-logs-dataset');

const store = Store.open(mkdtempSync(path.join(tmpdir(), 'agentspend-golden-')));
const result = ingest(
  store,
  {
    claudeLogsDir: path.join(DATASET, 'claude-code/projects'),
    codexLogsDir: path.join(DATASET, 'codex/sessions'),
    cursorDbPath: path.join(ROOT, 'fixtures/cursor/state.vscdb'),
    otelEventsPath: path.join(DATASET, 'otel/claude-code-events.jsonl'),
    evalDir: path.join(ROOT, 'eval'),
  },
  'cli',
);
const snapshot = store.snapshot(null);
if (snapshot === null) throw new Error('golden ingest stored no snapshot');
const summary: SummaryResponse = summaryResponse(snapshot);
const recon: ReconciliationResponse = reconciliationResponse(snapshot);
store.close();

const nano = (usd: number): number => Math.round(usd * 1e9);
const sumBySource = (source: Source): number =>
  summary.categoriesBySource[source].reduce((n, c) => n + nano(c.spend.totalUsd), 0);

describe('golden: full dataset', () => {
  it('ingests in one snapshot without errors', () => {
    assert.equal(result.status, 'changed');
    assert.equal(summary.snapshot.partial, false);
  });

  it('accounts for every record with a disposition', () => {
    const by = Object.fromEntries(summary.coverage.sources.map((s) => [s.source, s.records]));
    assert.deepEqual(by, {
      claude: { processed: 1072, 'recognized-unused': 12, duplicate: 22, malformed: 1, unknown: 0 },
      codex: { processed: 506, 'recognized-unused': 0, duplicate: 0, malformed: 0, unknown: 0 },
      cursor: { processed: 94, 'recognized-unused': 4, duplicate: 0, malformed: 1, unknown: 1 },
    });
    assert.deepEqual(summary.headline.unparsedRecords, { part: 3, total: 1713 });
    assert.ok(summary.coverage.sources.find((s) => s.source === 'cursor')?.synthetic);
  });

  it('finds the expected sessions and turns', () => {
    assert.equal(summary.headline.sessions, 56);
    assert.equal(summary.headline.turns, 175);
    const sessions = summary.categories.reduce((n, c) => n + c.sessions, 0);
    assert.equal(sessions, 56, 'session counts by primary category sum to the total');
  });

  it('prices each source to the frozen nano-USD totals', () => {
    assert.equal(sumBySource('claude'), 38_013_590_250);
    assert.equal(sumBySource('codex'), 4_833_722_350);
    assert.equal(sumBySource('cursor'), 493_486_250);
    assert.equal(nano(summary.headline.spendUsd), 38_013_590_250 + 4_833_722_350 + 493_486_250);
  });

  it('keeps spend split by pricing status', () => {
    assert.deepEqual(summary.spend.calls, { complete: 469, 'complete-no-cache-data': 71, estimated: 48, unpriced: 34 });
    assert.equal(summary.spend.repeatedUsageCalls, 0);
  });

  it('turn spend sums to session spend in every category table', () => {
    const turns = summary.categories.reduce((n, c) => n + nano(c.spend.totalUsd), 0);
    assert.ok(Math.abs(turns - nano(summary.headline.spendUsd)) <= summary.categories.length, 'only float rounding at the edge');
  });

  it('finds the seeded failure streak and the vendor correction streaks', () => {
    assert.deepEqual(
      summary.waste.failureStreaks.map((f) => [f.source, f.tool, f.target, f.length]),
      [['cursor', 'run_terminal_cmd', 'npm test', 3]],
    );
    assert.ok((summary.waste.failureStreaks[0]?.costDuringStreakUsd ?? 0) > 0);
    assert.ok(summary.waste.correctionStreaks.length >= 2);
    assert.ok(summary.waste.correctionStreaks.some((c) => c.source === 'cursor' && c.length === 2), 'seeded Cursor correction streak');
  });

  it('measures the classifier against the hand labels, as npm run eval does', () => {
    const check = summary.classifier ?? assert.fail('no classifier check');
    assert.deepEqual(check.heldout, { part: 15, total: 40 });
    assert.deepEqual(check.labelledSample, { part: 30, total: 30 });
    // The templated fixture prompts almost all hit a prompt rule; the tool-shape fallback never decides.
    assert.deepEqual(check.turnsClassifiedBy, { promptRule: 174, toolShape: 0, unclassified: 1 });
    assert.equal(check.turnsClassifiedBy.unclassified, summary.coverage.unclassifiedTurns.part);
  });
});

describe('golden: OTel pricing oracle', () => {
  if (recon.status !== 'on') throw new Error('reconciliation is off');
  const sonnet5 = recon.mismatches.filter((m) => m.otel.model === 'claude-sonnet-5');
  const oneM = recon.mismatches.filter((m) => m.otel.model === 'claude-sonnet-4-5-20250929[1m]' && m.reason === 'cost-differs');

  it('pairs every OTel request with a log message', () => {
    assert.equal(recon.otelRequests, 465);
    assert.deepEqual([recon.unmatchedOtel.length, recon.unmatchedLog.length], [0, 0]);
  });

  it('every matched request is within $0.000001 of cost_usd', () => {
    assert.equal(recon.matched, 346);
    assert.equal(recon.toleranceUsd, 0.000001);
  });

  it('every mismatch has a known cause', () => {
    const reasons: Record<string, number> = {};
    for (const m of recon.mismatches) reasons[m.reason] = (reasons[m.reason] ?? 0) + 1;
    assert.deepEqual(reasons, { 'cost-differs': 94, 'no-usage-in-log': 10, 'tokens-differ': 15 });
    assert.equal(sonnet5.length + oneM.length, 94, 'cost differs only for claude-sonnet-5 and the [1m] variant');
  });

  it('OTel prices claude-sonnet-5 at $3/$15, not the official $2/$10', () => {
    for (const m of sonnet5) {
      const t = m.otel.tokens ?? assert.fail();
      const at3x15 = (t.freshInput * 3000 + t.cacheWrite * 3750 + t.cacheRead * 300 + t.output * 15000) / 1e9;
      assert.ok(Math.abs(at3x15 - (m.otel.costUsd ?? -1)) <= 0.000001);
    }
  });

  it('OTel prices every [1m] request at long-context rates, whatever its size', () => {
    assert.equal(oneM.length, 57);
    for (const m of oneM) {
      const t = m.otel.tokens ?? assert.fail();
      assert.ok(t.freshInput + t.cacheRead + t.cacheWrite < 200_000);
      const longRates = (t.freshInput * 6000 + t.cacheWrite * 7500 + t.cacheRead * 600 + t.output * 22500) / 1e9;
      assert.ok(Math.abs(longRates - (m.otel.costUsd ?? -1)) <= 0.000001);
    }
  });

  it('token mismatches come from the one file whose order is not chronological', () => {
    const sessions = new Set(recon.mismatches.filter((m) => m.reason === 'tokens-differ').map((m) => m.sessionId));
    assert.deepEqual([...sessions], ['3888cf6f-f20f-4113-9752-143c54690953']);
  });
});
