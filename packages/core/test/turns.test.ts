import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { OPENING_PROMPT_RULE, segmentTurns } from '../src/segment/turns.ts';
import { builder } from './events.ts';

describe('turn segmentation', () => {
  it('attaches acks and corrections to the current turn', () => {
    const b = builder();
    const turns = segmentTurns([
      b.prompt('Implement cursor-based pagination.'),
      b.call({}),
      b.prompt('Wrong file. The logic lives in api.go, not where you edited.'),
      b.call({}),
      b.prompt('Thanks — ship it.'),
      b.prompt('Write table-driven tests for api.go.'),
      b.call({}),
    ]);
    assert.equal(turns.length, 2);
    assert.deepEqual(
      turns[0]?.prompts.map((p) => p.kind),
      ['intent', 'correction', 'ack'],
    );
    assert.equal(turns[0]?.events.length, 5);
    assert.deepEqual(
      turns[1]?.prompts.map((p) => p.kind),
      ['intent'],
    );
  });

  it('turns an opening ack or correction into an intent turn', () => {
    const b = builder();
    const turns = segmentTurns([b.prompt('Still failing. Run the tests yourself.'), b.call({}), b.prompt('No — that broke it.')]);
    assert.equal(turns.length, 1);
    assert.equal(turns[0]?.opening?.ruleId, OPENING_PROMPT_RULE);
    assert.equal(turns[0]?.opening?.kind, 'intent');
    assert.equal(turns[0]?.prompts[1]?.kind, 'correction');
  });

  it('puts work before the first prompt into its own no-prompt turn', () => {
    const b = builder();
    const turns = segmentTurns([b.call({}), b.call({}), b.prompt('Thanks — ship it.'), b.call({})]);
    assert.equal(turns.length, 2);
    assert.equal(turns[0]?.opening, null);
    assert.equal(turns[0]?.events.length, 2);
    // The ack after a no-prompt turn opens a real turn rather than joining "nothing".
    assert.equal(turns[1]?.opening?.ruleId, OPENING_PROMPT_RULE);
  });

  it('makes one no-prompt turn for a session with no prompt at all', () => {
    const b = builder();
    const turns = segmentTurns([b.call({}), b.tool('Read', 'read', 'a.ts'), b.call({})]);
    assert.equal(turns.length, 1);
    assert.equal(turns[0]?.opening, null);
  });

  it('keeps sidechain events in the turn they occur in', () => {
    const b = builder();
    const turns = segmentTurns([b.prompt('Explain how parse.py works.'), b.call({ sidechain: true }), b.call({})]);
    assert.equal(turns.length, 1);
    assert.equal(turns[0]?.events.length, 3);
  });

  it('returns no turns for no events', () => {
    assert.deepEqual(segmentTurns([]), []);
  });
});
