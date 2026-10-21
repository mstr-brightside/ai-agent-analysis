import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { analyzeSession, primaryCategory } from '../src/analyze.ts';
import { createPricer } from '../src/pricing/pricing.ts';
import { EMPTY_SPEND } from '../src/spend.ts';
import { nanoUsd, sumUsd } from '../src/units.ts';
import { findCorrectionStreaks, findFailureStreaks } from '../src/waste/streaks.ts';
import { builder, session, usage } from './events.ts';

const pricer = createPricer();
// Sonnet 4.5, 1000 fresh input + 100 output: 1000 × 3,000 + 100 × 15,000 nano-USD.
const CALL = 4_500_000;

describe('analyzeSession', () => {
  it('sums turn spend exactly to session spend, edge turns included', () => {
    const b = builder();
    const a = analyzeSession(
      session([
        b.call({}), // no-prompt turn
        b.prompt('Thanks — ship it.'), // opening ack → intent turn
        b.call({ usage: usage(341, 562, 58_269, 1_988), model: 'claude-opus-4-1-20250805' }),
        b.call({ sidechain: true, model: 'claude-haiku-4-5-20251001' }),
        b.prompt('Write table-driven tests for api.go.'),
        b.call({ model: 'gpt-5.5-codex' }), // unpriced
        b.call({ usage: null }), // no usage
        b.call({}),
      ]),
      pricer,
    );
    assert.equal(a.turns.length, 3);
    assert.equal(a.spend.total, sumUsd(a.turns.map((t) => t.spend.total)));
    assert.equal(a.spend.total, CALL + 171_943_500 + 1_500_000 + CALL);
    assert.equal(a.spend.calls.unpriced, 2);
    assert.equal(a.turns[0]?.category, 'unknown');
    assert.equal(a.turns[0]?.ruleId, 'no-prompt');
  });

  it('charges usage once per message id', () => {
    const b = builder();
    const a = analyzeSession(
      session([b.prompt('Add a feature.'), b.call({ messageId: 'msg_1' }), b.call({ messageId: 'msg_1' }), b.call({ messageId: 'msg_2' })]),
      pricer,
    );
    assert.equal(a.spend.total, 2 * CALL);
    assert.equal(a.spend.repeatedUsageCalls, 1);
  });

  it('keeps spend split by pricing status', () => {
    const b = builder();
    const a = analyzeSession(
      session([
        b.prompt('Add a feature.'),
        b.call({}),
        b.call({ usage: { ...usage(1000, 100), cache: null } }),
        b.call({ usage: { ...usage(1000, 100), estimate: 'cached-exceeds-input' } }),
      ]),
      pricer,
    );
    assert.deepEqual(a.spend.byStatus, { complete: CALL, 'complete-no-cache-data': CALL, estimated: CALL });
  });

  it('reports the project as a folder name only', () => {
    const a = analyzeSession(session([]), pricer);
    assert.equal(a.project, 'recipe-web');
    assert.equal(a.primaryCategory, 'unknown');
  });

  it('prices the cost during a failure streak and names its turns', () => {
    const b = builder();
    const a = analyzeSession(
      session([
        b.prompt('Fix the bug in parse.py.'),
        b.call({}),
        ...b.attempt('Bash', 'shell', 'pytest -q', 'failure'),
        b.call({}),
        ...b.attempt('Bash', 'shell', 'pytest -q', 'failure'),
        b.call({}),
        ...b.attempt('Bash', 'shell', 'pytest -q', 'failure'),
        b.call({}),
      ]),
      pricer,
    );
    const [streak] = a.failureStreaks;
    assert.equal(streak?.length, 3);
    assert.equal(streak.costDuringStreak, 2 * CALL, 'the two calls between the first failed call and the last result');
    assert.deepEqual(streak.turnIndexes, [0]);
  });

  it('prices the cost during a correction streak up to the prompt that ends it', () => {
    const b = builder();
    const a = analyzeSession(
      session([
        b.prompt('Implement pagination.'),
        b.call({}),
        b.prompt('Wrong file. It lives in api.go.'),
        b.call({}),
        b.prompt('Still failing. Run the tests.'),
        b.call({}),
        b.prompt('Thanks — ship it.'),
        b.call({}),
      ]),
      pricer,
    );
    assert.equal(a.correctionStreaks.length, 1);
    assert.equal(a.correctionStreaks[0]?.length, 2);
    assert.equal(a.correctionStreaks[0]?.costDuringStreak, 2 * CALL);
  });
});

describe('failure streaks', () => {
  it('qualifies at 3 failures of the same tool and target, other tools in between', () => {
    const b = builder();
    const streaks = findFailureStreaks([
      ...b.attempt('Bash', 'shell', 'go test ./...', 'failure'),
      ...b.attempt('Edit', 'edit', 'api.go', 'success'),
      ...b.attempt('Bash', 'shell', 'go test ./...', 'failure'),
      ...b.attempt('Edit', 'edit', 'api.go', 'success'),
      ...b.attempt('Bash', 'shell', 'go test ./...', 'failure'),
    ]);
    assert.equal(streaks.length, 1);
    assert.equal(streaks[0]?.target, 'go test ./...');
    assert.deepEqual(
      streaks[0]?.attempts.map((x) => x.outcome),
      ['failure', 'failure', 'failure'],
    );
  });

  it('near miss: two failures then a success do not qualify', () => {
    const b = builder();
    const streaks = findFailureStreaks([
      ...b.attempt('Bash', 'shell', 'npm test', 'failure'),
      ...b.attempt('Bash', 'shell', 'npm test', 'failure'),
      ...b.attempt('Bash', 'shell', 'npm test', 'success'),
      ...b.attempt('Bash', 'shell', 'npm test', 'failure'),
    ]);
    assert.deepEqual(streaks, []);
  });

  it('near miss: three failures on different targets do not qualify', () => {
    const b = builder();
    const streaks = findFailureStreaks([
      ...b.attempt('Edit', 'edit', 'a.ts', 'failure'),
      ...b.attempt('Edit', 'edit', 'b.ts', 'failure'),
      ...b.attempt('Edit', 'edit', 'c.ts', 'failure'),
    ]);
    assert.deepEqual(streaks, []);
  });

  it('unknown outcomes neither extend nor break a streak', () => {
    const b = builder();
    const missing = b.tool('Bash', 'shell', 'make', 'no-result'); // a call with no result at all
    const streaks = findFailureStreaks([
      ...b.attempt('Bash', 'shell', 'make', 'failure'),
      ...b.attempt('Bash', 'shell', 'make', 'unknown'),
      missing,
      ...b.attempt('Bash', 'shell', 'make', 'failure'),
      ...b.attempt('Bash', 'shell', 'make', 'unknown'),
    ]);
    assert.deepEqual(streaks, [], 'two failures plus unknowns is not a streak');

    const c = builder();
    const three = findFailureStreaks([
      ...c.attempt('Bash', 'shell', 'make', 'failure'),
      ...c.attempt('Bash', 'shell', 'make', 'unknown'),
      ...c.attempt('Bash', 'shell', 'make', 'failure'),
      ...c.attempt('Bash', 'shell', 'make', 'failure'),
      ...c.attempt('Bash', 'shell', 'make', 'unknown'),
    ]);
    assert.equal(three[0]?.length, 3);
    assert.deepEqual(
      three[0]?.attempts.map((x) => x.outcome),
      ['failure', 'unknown', 'failure', 'failure'],
      'unknowns inside are evidence; trailing ones are trimmed',
    );
  });

  it('ignores calls with no target', () => {
    const b = builder();
    const call = (): ReturnType<typeof b.tool> => b.tool('mystery', 'other', null);
    const events = [call(), call(), call()].flatMap((c) => [c, b.result(c.callId, 'failure')]);
    assert.deepEqual(findFailureStreaks(events), []);
  });
});

describe('correction streaks', () => {
  const ref = { kind: 'line', file: 'f', line: 1 } as const;
  it('qualifies at 2 consecutive corrections', () => {
    const streaks = findCorrectionStreaks(
      [
        { index: 0, ref, kind: 'intent' },
        { index: 2, ref, kind: 'correction' },
        { index: 4, ref, kind: 'correction' },
        { index: 6, ref, kind: 'intent' },
      ],
      8,
    );
    assert.deepEqual(
      streaks.map((s) => [s.length, s.start, s.end]),
      [[2, 2, 5]],
    );
  });

  it('near miss: an ack between corrections ends the streak', () => {
    const streaks = findCorrectionStreaks(
      [
        { index: 0, ref, kind: 'correction' },
        { index: 1, ref, kind: 'ack' },
        { index: 2, ref, kind: 'correction' },
      ],
      3,
    );
    assert.deepEqual(streaks, []);
  });

  it('a streak running to the end of the session ends at the last event', () => {
    const streaks = findCorrectionStreaks(
      [
        { index: 0, ref, kind: 'intent' },
        { index: 1, ref, kind: 'correction' },
        { index: 2, ref, kind: 'correction' },
        { index: 3, ref, kind: 'correction' },
      ],
      10,
    );
    assert.deepEqual(
      streaks.map((s) => [s.length, s.end]),
      [[3, 9]],
    );
  });
});

describe('primary category', () => {
  const turn = (category: 'implement' | 'test' | 'debug' | 'unknown', spend: number) => ({
    category,
    spend: { ...EMPTY_SPEND, total: nanoUsd(spend) },
  });
  it('picks the highest-spend category', () => {
    assert.equal(primaryCategory([turn('implement', 10), turn('test', 30), turn('implement', 15)]), 'test');
  });
  it('breaks spend ties by turn count, then priority', () => {
    assert.equal(primaryCategory([turn('implement', 10), turn('implement', 0), turn('test', 10)]), 'implement');
    assert.equal(primaryCategory([turn('implement', 0), turn('debug', 0)]), 'debug');
  });
  it('ignores unknown turns unless every turn is unknown', () => {
    assert.equal(primaryCategory([turn('unknown', 100), turn('implement', 1)]), 'implement');
    assert.equal(primaryCategory([turn('unknown', 100)]), 'unknown');
    assert.equal(primaryCategory([]), 'unknown');
  });
});
