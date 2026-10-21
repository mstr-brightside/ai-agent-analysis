import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { readJsonl, type JsonlCursor } from '../src/jsonl.ts';

function file(content: string): string {
  const f = path.join(mkdtempSync(path.join(tmpdir(), 'agentspend-jsonl-')), 'x.jsonl');
  writeFileSync(f, content);
  return f;
}
const cursorOf = (r: ReturnType<typeof readJsonl>): JsonlCursor => ({ ...r.position, state: null });

describe('incremental JSONL reading', () => {
  it('reads everything first, counting blank lines separately', () => {
    const r = readJsonl(file('{"a":1}\n\n{"a":2}\r\n'), null);
    assert.equal(r.mode, 'full');
    assert.deepEqual(r.lines, [
      { line: 1, text: '{"a":1}' },
      { line: 3, text: '{"a":2}' },
    ]);
    assert.equal(r.blankLines, 1);
  });

  it('reads nothing when the file is unchanged', () => {
    const f = file('{"a":1}\n');
    const first = readJsonl(f, null);
    const again = readJsonl(f, cursorOf(first));
    assert.equal(again.mode, 'unchanged');
    assert.deepEqual(again.lines, []);
  });

  it('reads only appended lines, with line numbers continuing', () => {
    const f = file('{"a":1}\n{"a":2}\n');
    const first = readJsonl(f, null);
    appendFileSync(f, '{"a":3}\n');
    const next = readJsonl(f, cursorOf(first));
    assert.equal(next.mode, 'append');
    assert.deepEqual(next.lines, [{ line: 3, text: '{"a":3}' }]);
  });

  it('does not consume a last line without a newline until it is complete', () => {
    const f = file('{"a":1}\n{"a":');
    const first = readJsonl(f, null);
    assert.deepEqual(first.lines.map((l) => l.line), [1]);
    appendFileSync(f, '2}\n');
    const next = readJsonl(f, cursorOf(first));
    assert.deepEqual(next.lines, [{ line: 2, text: '{"a":2}' }]);
  });

  it('re-reads in full when the file was truncated', () => {
    const f = file('{"a":1}\n{"a":2}\n');
    const first = readJsonl(f, null);
    writeFileSync(f, '{"a":1}\n');
    const next = readJsonl(f, cursorOf(first));
    assert.equal(next.reread, true);
    assert.deepEqual(next.lines.map((l) => l.line), [1]);
  });

  it('re-reads in full when the head changed (file replaced), even if longer', () => {
    const f = file('{"a":1}\n');
    const first = readJsonl(f, null);
    writeFileSync(f, '{"b":1}\n{"b":2}\n');
    const next = readJsonl(f, cursorOf(first));
    assert.equal(next.reread, true);
    assert.equal(next.mode, 'full');
    assert.equal(next.lines.length, 2);
  });

  it('handles multi-byte characters split across reads by byte offset', () => {
    const f = file('{"t":"héllo"}\n');
    const first = readJsonl(f, null);
    appendFileSync(f, '{"t":"wörld"}\n');
    assert.deepEqual(readJsonl(f, cursorOf(first)).lines, [{ line: 2, text: '{"t":"wörld"}' }]);
  });
});
