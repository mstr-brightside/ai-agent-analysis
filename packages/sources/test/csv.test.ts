import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { csvLine, readCsv } from '../src/csv.ts';

describe('csv', () => {
  it('round-trips commas, quotes and newlines', () => {
    const rows = [
      ['id', 'prompt', 'tools'],
      ['a:1', 'Before writing code, give me a "plan".', 'shell(sed -n \'1,80p\' x)'],
      ['b:2', 'line one\nline two', ''],
    ];
    assert.deepEqual(readCsv(rows.map(csvLine).join('\n') + '\n'), rows);
  });
});
