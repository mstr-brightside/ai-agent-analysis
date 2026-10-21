import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { createPricer, type ModelCallEvent } from '@agentspend/core';
import { readCursorDb, SYNTHETIC_MARKER_KEY, type CursorRead } from '../src/cursor.ts';

const pricer = createPricer();

function database(rows: ReadonlyArray<readonly [string, unknown]>): string {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'agentspend-cursor-')), 'state.vscdb');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
  const insert = db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)');
  for (const [key, value] of rows) insert.run(key, typeof value === 'string' ? value : JSON.stringify(value));
  db.close();
  return file;
}

function ok(read: CursorRead): Extract<CursorRead, { status: 'ok' }> {
  if (read.status !== 'ok') assert.fail(read.message);
  return read;
}

const C = 'c0000000-0000-4000-a000-000000000001';
const user = (id: string, text: string) => [`bubbleId:${C}:${id}`, { _v: 3, type: 1, bubbleId: id, text }] as const;
const reply = (id: string, extra: Record<string, unknown>) => [`bubbleId:${C}:${id}`, { _v: 3, type: 2, bubbleId: id, text: 'Done.', ...extra }] as const;

describe('Cursor adapter', () => {
  it('reads bubbles in row order, model from the bubble or the composer', () => {
    const file = database([
      user('b1', 'Add a feature.'),
      reply('b2', { tokenCount: { inputTokens: 1000, outputTokens: 100 }, modelInfo: { modelName: 'gpt-5' } }),
      reply('b3', { tokenCount: { inputTokens: 1000, outputTokens: 100 } }),
      [`composerData:${C}`, { _v: 3, composerId: C, workspaceFolder: '/home/dev/projects/ledger-cli', modelConfig: { modelName: 'claude-4.5-sonnet' } }],
    ]);
    const read = ok(readCursorDb(file, new Map()));
    const events = read.records.flatMap((r) => r.record.events);
    assert.deepEqual(events.map((e) => e.type), ['prompt', 'model-call', 'model-call']);
    const calls = events.filter((e): e is ModelCallEvent => e.type === 'model-call');
    assert.deepEqual(calls.map((c) => c.model), ['gpt-5', 'claude-4.5-sonnet']);
    assert.equal(read.records[0]?.record.sessionId, C);
    assert.equal(read.records[0]?.record.info?.projectPath, '/home/dev/projects/ledger-cli');
    // No cache fields in Cursor's tokenCount: a lower bound.
    assert.equal(pricer.price(calls[0]?.model ?? null, calls[0]?.usage ?? null).status, 'complete-no-cache-data');
  });

  it('auto, zero and missing tokenCount stay unpriced', () => {
    const file = database([
      reply('b1', { tokenCount: { inputTokens: 1000, outputTokens: 100 }, modelInfo: { modelName: 'auto' } }),
      reply('b2', { tokenCount: { inputTokens: 0, outputTokens: 0 }, modelInfo: { modelName: 'gpt-5' } }),
      reply('b3', { modelInfo: { modelName: 'gpt-5' } }),
    ]);
    const calls = ok(readCursorDb(file, new Map())).records.flatMap((r) => r.record.events.filter((e): e is ModelCallEvent => e.type === 'model-call'));
    assert.deepEqual(
      calls.map((c) => {
        const p = pricer.price(c.model, c.usage);
        return p.status === 'unpriced' ? p.reason : p.status;
      }),
      ['unknown-model', 'no-usage', 'no-usage'],
    );
  });

  it('tool bubbles become a call and its result with a normalized target', () => {
    const file = database([
      [`composerData:${C}`, { _v: 3, workspaceFolder: '/home/dev/projects/recipe-web' }],
      reply('b1', { text: '', toolFormerData: { name: 'run_terminal_cmd', toolCallId: 'tc1', status: 'error', rawArgs: '{"command":"npm  test"}' } }),
      reply('b2', { text: '', toolFormerData: { name: 'edit_file', toolCallId: 'tc2', status: 'completed', rawArgs: '{"target_file":"/home/dev/projects/recipe-web/src/a.ts"}' } }),
    ]);
    const events = ok(readCursorDb(file, new Map())).records.flatMap((r) => r.record.events);
    assert.deepEqual(
      events.map((e) => {
        if (e.type === 'tool-call') return `${e.tool}:${e.target ?? ''}`;
        if (e.type === 'tool-result') return e.outcome;
        return e.type;
      }),
      ['run_terminal_cmd:npm test', 'failure', 'edit_file:src/a.ts', 'success'],
    );
  });

  it('assigns dispositions by key family and flags the synthetic marker', () => {
    const file = database([
      [SYNTHETIC_MARKER_KEY, { synthetic: true }],
      [`checkpointId:${C}:x`, {}],
      ['featureFlagCache:x', {}],
      [`bubbleId:${C}:broken`, '{"_v": 3, "type": 2, "te'],
    ]);
    const read = ok(readCursorDb(file, new Map()));
    assert.equal(read.synthetic, true);
    assert.deepEqual(
      read.records.map((r) => r.record.disposition),
      ['recognized-unused', 'recognized-unused', 'unknown', 'malformed'],
    );
  });

  it('returns only new or changed keys on the next read', () => {
    const file = database([user('b1', 'Add a feature.'), [`composerData:${C}`, { _v: 3 }]]);
    const first = ok(readCursorDb(file, new Map()));
    assert.equal(first.records.length, 2);
    const again = ok(readCursorDb(file, first.hashes));
    assert.equal(again.records.length, 0);

    const db = new DatabaseSync(file);
    db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run(`composerData:${C}`, JSON.stringify({ _v: 3, workspaceFolder: '/w/p' }));
    db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run(`bubbleId:${C}:b9`, JSON.stringify({ _v: 3, type: 1, text: 'More.' }));
    db.close();
    const changed = ok(readCursorDb(file, first.hashes));
    assert.deepEqual(
      changed.records.map((r) => [r.record.ref.kind === 'key' ? r.record.ref.key.split(':')[0] : '', r.replace]),
      [
        ['composerData', true],
        ['bubbleId', false],
      ],
    );
  });

  it('reports a missing or invalid database as unavailable instead of throwing', () => {
    const read = readCursorDb(path.join(tmpdir(), 'agentspend-does-not-exist.vscdb'), new Map());
    assert.equal(read.status, 'unavailable');
  });
});
