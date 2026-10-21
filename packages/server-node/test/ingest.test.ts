import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { Store } from '@agentspend/store';
import { ingest, type IngestResult, type IngestSources } from '../src/ingest.ts';
import { summaryResponse } from '../src/read.ts';

const SESSION = 'sess-1';
const common = { sessionId: SESSION, cwd: '/home/dev/projects/demo', version: '2.3.0', isSidechain: false };

function user(uuid: string, text: string): string {
  return JSON.stringify({ type: 'user', uuid, ...common, message: { role: 'user', content: text } });
}
// Sonnet 4.5: 1000 × 3,000 + 100 × 15,000 = 4,500,000 nano-USD per call.
function assistant(uuid: string, messageId: string): string {
  return JSON.stringify({
    type: 'assistant',
    uuid,
    ...common,
    message: {
      id: messageId,
      model: 'claude-sonnet-4-5-20250929',
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  });
}
const CALL_USD = 0.0045;

function setup(lines: readonly string[]): { sources: IngestSources; file: string; dataDir: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'agentspend-ingest-'));
  const claude = path.join(root, 'claude', '-home-dev-projects-demo');
  mkdirSync(claude, { recursive: true });
  const file = path.join(claude, `${SESSION}.jsonl`);
  writeFileSync(file, lines.map((l) => `${l}\n`).join(''));
  const dataDir = path.join(root, 'data');
  mkdirSync(dataDir);
  return {
    sources: { claudeLogsDir: path.join(root, 'claude'), codexLogsDir: null, cursorDbPath: null, otelEventsPath: null, evalDir: null },
    file,
    dataDir,
  };
}

function changed(result: IngestResult): Extract<IngestResult, { status: 'changed' }> {
  if (result.status !== 'changed') assert.fail(`expected a snapshot, got ${result.status}`);
  return result;
}

function latestSpend(store: Store): number {
  const latest = store.snapshot(null);
  if (latest === null) assert.fail('no snapshot');
  return summaryResponse(latest).headline.spendUsd;
}

describe('ingest', () => {
  it('first run reads everything and stores a snapshot', () => {
    const { sources, dataDir } = setup([user('u1', 'Add a feature.'), assistant('a1', 'm1')]);
    const store = Store.open(dataDir);
    const r = changed(ingest(store, sources, 'cli'));
    assert.equal(r.snapshot.id, 1);
    assert.equal(r.snapshot.changes.newRecords, 2);
    assert.equal(latestSpend(store), CALL_USD);
    store.close();
  });

  it('an empty source gives an empty report, not an error', () => {
    const { sources, dataDir } = setup([]);
    const store = Store.open(dataDir);
    const r = changed(ingest(store, sources, 'cli'));
    const summary = summaryResponse(store.snapshot(r.snapshot.id) ?? assert.fail());
    assert.equal(summary.headline.sessions, 0);
    assert.equal(summary.headline.fullyPricedShare, null);
    store.close();
  });

  it('re-ingesting unchanged input adds nothing and stores no snapshot', () => {
    const { sources, dataDir } = setup([user('u1', 'Add a feature.'), assistant('a1', 'm1')]);
    const store = Store.open(dataDir);
    changed(ingest(store, sources, 'cli'));
    const again = ingest(store, sources, 'cli');
    assert.equal(again.status, 'no-changes');
    assert.equal(again.status === 'no-changes' ? again.latestSnapshotId : null, 1);
    assert.equal(store.snapshotList().length, 1);
    store.close();
  });

  it('appended lines add only those lines and recompute only that session', () => {
    const { sources, dataDir, file } = setup([user('u1', 'Add a feature.'), assistant('a1', 'm1')]);
    const store = Store.open(dataDir);
    ingest(store, sources, 'cli');
    appendFileSync(file, `${assistant('a2', 'm2')}\n`);
    const r = changed(ingest(store, sources, 'refresh'));
    assert.equal(r.snapshot.changes.newRecords, 1);
    assert.equal(r.snapshot.changes.touchedSessions, 1);
    assert.equal(latestSpend(store), 2 * CALL_USD);
    store.close();
  });

  it('does not consume a partial last line until it is complete', () => {
    const { sources, dataDir, file } = setup([user('u1', 'Add a feature.')]);
    const full = assistant('a1', 'm1');
    appendFileSync(file, full.slice(0, 40));
    const store = Store.open(dataDir);
    const first = changed(ingest(store, sources, 'cli'));
    assert.equal(first.snapshot.changes.newRecords, 1);
    assert.equal(latestSpend(store), 0);
    appendFileSync(file, `${full.slice(40)}\n`);
    const second = changed(ingest(store, sources, 'cli'));
    assert.equal(second.snapshot.changes.newRecords, 1);
    assert.equal(latestSpend(store), CALL_USD);
    store.close();
  });

  it('a truncated or replaced file is re-read in full; seen records become duplicates, never double spend', () => {
    const { sources, dataDir, file } = setup([user('u1', 'Add a feature.'), assistant('a1', 'm1'), assistant('a2', 'm2')]);
    const store = Store.open(dataDir);
    ingest(store, sources, 'cli');
    writeFileSync(file, `${user('u1', 'Add a feature.')}\n${assistant('a1', 'm1')}\n`);
    const r = changed(ingest(store, sources, 'cli'));
    assert.deepEqual(r.snapshot.changes.rereadFiles, [`${SESSION}.jsonl`]);
    const summary = summaryResponse(store.snapshot(null) ?? assert.fail());
    assert.equal(summary.coverage.sources.find((s) => s.source === 'claude')?.records.duplicate, 2);
    assert.equal(summary.headline.spendUsd, 2 * CALL_USD, 'events already stored are kept, not charged twice');
    store.close();
  });

  it('marks a replayed record (same uuid) as duplicate and charges its usage once', () => {
    const { sources, dataDir } = setup([user('u1', 'Add a feature.'), assistant('a1', 'm1'), assistant('a1', 'm1')]);
    const store = Store.open(dataDir);
    ingest(store, sources, 'cli');
    const summary = summaryResponse(store.snapshot(null) ?? assert.fail());
    assert.equal(summary.coverage.sources.find((s) => s.source === 'claude')?.records.duplicate, 1);
    assert.equal(summary.headline.spendUsd, CALL_USD);
    store.close();
  });

  it('survives a restart without doubling the latest report', () => {
    const { sources, dataDir } = setup([user('u1', 'Add a feature.'), assistant('a1', 'm1')]);
    const first = Store.open(dataDir);
    ingest(first, sources, 'startup');
    first.close();
    const second = Store.open(dataDir);
    const r = ingest(second, sources, 'startup');
    assert.equal(r.status, 'no-changes');
    assert.equal(latestSpend(second), CALL_USD);
    second.close();
  });

  it('recomputes every session and snapshots when the classifier or price table changes', () => {
    const { sources, dataDir } = setup([user('u1', 'Add a feature.'), assistant('a1', 'm1')]);
    const store = Store.open(dataDir);
    ingest(store, sources, 'cli');
    store.setMeta('pricingVersion', 'an-older-price-table');
    const r = changed(ingest(store, sources, 'cli'));
    assert.equal(r.snapshot.changes.versionChanged, true);
    assert.equal(r.snapshot.changes.newRecords, 0);
    assert.equal(r.snapshot.changes.touchedSessions, 1);
    store.close();
  });

  it('records a file-level error, keeps going and marks the run partial', () => {
    const { sources, dataDir } = setup([user('u1', 'Add a feature.')]);
    const store = Store.open(dataDir);
    const r = changed(ingest(store, { ...sources, cursorDbPath: path.join(dataDir, 'missing.vscdb') }, 'cli'));
    assert.equal(r.snapshot.partial, true);
    const cursor = summaryResponse(store.snapshot(null) ?? assert.fail()).coverage.sources.find((s) => s.source === 'cursor');
    assert.equal(cursor?.errors[0]?.file, 'missing.vscdb');
    store.close();
  });

  it('rolls back everything when the ingest fails midway', () => {
    const { sources, dataDir } = setup([user('u1', 'Add a feature.')]);
    const store = Store.open(dataDir);
    assert.throws(() =>
      ingest(store, sources, 'cli', () => {
        throw new Error('clock exploded');
      }),
    );
    assert.equal(store.snapshotList().length, 0);
    assert.equal(store.sessionKeys().length, 0, 'no half-written records');
    store.close();
  });

  it('never puts prompt text into a snapshot', () => {
    const secret = 'Add the payroll export for ACME Corp.';
    const { sources, dataDir } = setup([user('u1', secret), assistant('a1', 'm1')]);
    const store = Store.open(dataDir);
    ingest(store, sources, 'cli');
    const snapshot = JSON.stringify(store.snapshot(null));
    assert.ok(!snapshot.includes('payroll'), 'prompt text leaked into the snapshot');
    assert.ok(!snapshot.includes('/home/dev/projects/demo'), 'full project path leaked into the snapshot');
    assert.ok(snapshot.includes('"demo"'), 'project folder name is shown');
    store.close();
  });

  it('measures the classifier against the label files and stores the result with the snapshot', () => {
    const { sources, dataDir } = setup([user('u1', 'Add a feature.'), assistant('a1', 'm1')]);
    const evalDir = path.join(dataDir, '..', 'eval');
    mkdirSync(evalDir);
    // One held-out prompt the rules get right (plan), one they cannot place (labelled research).
    writeFileSync(path.join(evalDir, 'heldout.csv'), 'id,prompt,label,note\nh1,draft a plan for the export,plan,\nh2,"what time is it, roughly",research,\n');
    writeFileSync(path.join(evalDir, 'labels.csv'), `id,label,note\nclaude:${SESSION}.jsonl:1,implement,\n`);
    const store = Store.open(dataDir);
    ingest(store, { ...sources, evalDir }, 'cli');
    const { classifier } = summaryResponse(store.snapshot(null) ?? assert.fail());
    assert.deepEqual(classifier, {
      heldout: { part: 1, total: 2 },
      labelledSample: { part: 1, total: 1 },
      turnsClassifiedBy: { promptRule: 1, toolShape: 0, unclassified: 0 },
    });
    store.close();
  });

  it('reports a label file it cannot use as not measured, and a labelled turn missing from the data likewise', () => {
    const { sources, dataDir } = setup([user('u1', 'Add a feature.'), assistant('a1', 'm1')]);
    const evalDir = path.join(dataDir, '..', 'eval');
    mkdirSync(evalDir);
    writeFileSync(path.join(evalDir, 'heldout.csv'), 'id,prompt,label,note\nh1,draft a plan,not-a-category,\n');
    writeFileSync(path.join(evalDir, 'labels.csv'), 'id,label,note\nclaude:other.jsonl:1,implement,\n');
    const store = Store.open(dataDir);
    ingest(store, { ...sources, evalDir }, 'cli');
    const { classifier } = summaryResponse(store.snapshot(null) ?? assert.fail());
    assert.equal(classifier?.heldout, null);
    assert.equal(classifier?.labelledSample, null);
    assert.deepEqual(classifier?.turnsClassifiedBy, { promptRule: 1, toolShape: 0, unclassified: 0 });
    store.close();
  });

  it('reads a snapshot stored before the classifier check existed', () => {
    const { sources, dataDir } = setup([user('u1', 'Add a feature.'), assistant('a1', 'm1')]);
    const store = Store.open(dataDir);
    ingest(store, sources, 'cli');
    const stored = store.snapshot(null) ?? assert.fail();
    const older: unknown = JSON.parse(JSON.stringify(stored.summary), (key, value: unknown) => (key === 'classifier' ? undefined : value));
    assert.equal(summaryResponse({ ...stored, summary: older }).classifier, null);
    store.close();
  });
});
