import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { promptKind } from '../src/segment/prompt-kind.ts';

describe('prompt kind', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['Thanks — ship it.', 'ack'],
    ['Looks good. Move on to the next step in the plan.', 'ack'],
    ['Great, that works. Commit it with a sensible message.', 'ack'],
    ['Perfect, tests pass.', 'ack'],
    ['Wrong file. The logic lives in cmd/server/main.go, not where you edited.', 'correction'],
    ["No — that broke package.json. The test still fails with 'x'. Look again.", 'correction'],
    ['You hallucinated a function that doesn\'t exist in chi. Check the actual source.', 'correction'],
    ['Too much. Undo the refactor and only do the minimal fix.', 'correction'],
    ['Still failing. Run the tests yourself before telling me it works.', 'correction'],
    ["That's not what I asked. I said keep the public API unchanged. Revert the signature change.", 'correction'],
    ['Implement cursor-based pagination in README.md. Follow the existing patterns.', 'intent'],
    ['Now add a test for it.', 'intent'],
    ['Note: the wrong total comes from rounding.', 'intent'],
    ['Nothing else to add; write the migration.', 'intent'],
    ['Why does ledger/cli.py return the wrong total when there are duplicate SKUs?', 'intent'],
  ];
  for (const [text, kind] of cases) {
    it(`${kind}: ${text.slice(0, 50)}`, () => {
      assert.equal(promptKind(text).kind, kind);
    });
  }

  it('reports the rule that fired', () => {
    assert.deepEqual(promptKind('Thanks — ship it.'), { kind: 'ack', ruleId: 'ack.thanks' });
    assert.deepEqual(promptKind('Add a test.'), { kind: 'intent', ruleId: 'intent.default' });
  });
});
