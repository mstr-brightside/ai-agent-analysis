import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { z } from 'zod';
import { generateCursorFixture, SYNTHETIC_MARKER_KEY } from '../src/generate.ts';

const dir = mkdtempSync(path.join(tmpdir(), 'agentspend-cursor-'));
const sha = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');

function rows(file: string): Array<{ key: string; value: string }> {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return z.array(z.object({ key: z.string(), value: z.string() })).parse(db.prepare('SELECT key, value FROM cursorDiskKV ORDER BY rowid').all());
  } finally {
    db.close();
  }
}

function json(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

const bubble = z.looseObject({
  _v: z.number(),
  type: z.number(),
  text: z.string().optional(),
  tokenCount: z.object({ inputTokens: z.number(), outputTokens: z.number() }).optional(),
  modelInfo: z.object({ modelName: z.string() }).optional(),
  toolFormerData: z.looseObject({ name: z.string(), status: z.string(), rawArgs: z.string() }).optional(),
});
const composer = z.looseObject({ _v: z.number(), workspaceFolder: z.string().optional(), modelConfig: z.object({ modelName: z.string() }).optional() });

describe('cursor fixture generator', () => {
  const a = path.join(dir, 'a.vscdb');
  const b = path.join(dir, 'b.vscdb');
  generateCursorFixture(a);
  generateCursorFixture(b);
  const all = rows(a);
  const bubbles = all.filter((r) => r.key.startsWith('bubbleId:')).flatMap((r) => {
    const parsed = bubble.safeParse(json(r.value));
    return parsed.success ? [{ key: r.key, ...parsed.data }] : [];
  });
  const composers = all.filter((r) => r.key.startsWith('composerData:')).map((r) => composer.parse(json(r.value)));

  it('is deterministic: same seed, same bytes', () => {
    assert.equal(sha(a), sha(b));
  });

  it('a different seed gives different content', () => {
    const c = path.join(dir, 'c.vscdb');
    generateCursorFixture(c, 7);
    assert.notEqual(sha(a), sha(c));
  });

  it('marks itself synthetic', () => {
    assert.ok(all.some((r) => r.key === SYNTHETIC_MARKER_KEY));
  });

  it('has ~10 composers across three schema versions; project folder only in the newest', () => {
    assert.equal(composers.length, 10);
    assert.deepEqual([...new Set(composers.map((c) => c._v))].sort(), [1, 2, 3]);
    assert.ok(composers.every((c) => (c.workspaceFolder !== undefined) === (c._v === 3)));
  });

  it('has tokenCount present, zero and missing, and the auto model', () => {
    const assistant = bubbles.filter((x) => x.type === 2 && x.toolFormerData === undefined);
    assert.ok(assistant.some((x) => (x.tokenCount?.inputTokens ?? 0) > 0));
    assert.ok(assistant.some((x) => x.tokenCount?.inputTokens === 0));
    assert.ok(assistant.some((x) => x.tokenCount === undefined));
    const models = new Set([...composers.map((c) => c.modelConfig?.modelName), ...bubbles.map((x) => x.modelInfo?.modelName)]);
    for (const m of ['claude-4.5-sonnet', 'gpt-5', 'auto']) assert.ok(models.has(m), m);
  });

  it('seeds a failure streak: npm test fails three times in a row in one composer', () => {
    const outcomes = bubbles.filter((x) => x.toolFormerData?.rawArgs === '{"command":"npm test"}').map((x) => x.toolFormerData?.status);
    assert.ok(outcomes.join(',').includes('error,error,error'));
  });

  it('seeds a correction streak: two corrections in a row', () => {
    const prompts = bubbles.filter((x) => x.type === 1).map((x) => x.text ?? '');
    const i = prompts.findIndex((p) => p.startsWith('Wrong file.'));
    assert.ok(i >= 0);
    assert.match(prompts[i + 1] ?? '', /^Still failing\./);
  });

  it('seeds exactly one malformed JSON value', () => {
    assert.equal(all.filter((r) => json(r.value) === undefined).length, 1);
  });

  it('seeds recognized-but-unused families and one unknown family', () => {
    const families = new Set(all.map((r) => r.key.split(':')[0]));
    for (const f of ['checkpointId', 'messageRequestContext', 'codeBlockDiff', 'featureFlagCache']) assert.ok(families.has(f), f);
  });

  it('uses Cursor tool shapes with completed and error statuses', () => {
    const names = new Set(bubbles.map((x) => x.toolFormerData?.name).filter((n) => n !== undefined));
    assert.deepEqual([...names].sort(), ['edit_file', 'grep_search', 'read_file', 'run_terminal_cmd']);
    const statuses = new Set(bubbles.map((x) => x.toolFormerData?.status).filter((s) => s !== undefined));
    assert.deepEqual([...statuses].sort(), ['completed', 'error']);
  });
});
