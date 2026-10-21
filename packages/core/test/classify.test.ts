import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyByTools, classifyPrompt, classifyTurn, CLASSIFIER_VERSION } from '../src/classify/classify.ts';
import { PROMPT_RULES } from '../src/classify/rules.ts';
import { segmentTurns } from '../src/segment/turns.ts';
import { builder } from './events.ts';

describe('prompt rules', () => {
  // One example per rule, worded differently from the dataset templates where possible.
  const examples: ReadonlyArray<readonly [ruleId: string, prompt: string]> = [
    ['plan.ask-for-plan', 'Give me a plan for the billing migration.'],
    ['plan.spec-for', 'Draft the design for webhooks retries.'],
    ['plan.no-code-yet', "Think through the cache invalidation approach. Don't code yet."],
    ['plan.scope', "Let's scope the export feature."],
    ['review.ready-to-ship', 'Is this branch ready to merge?'],
    ['review.review', 'Review my last commit.'],
    ['review.look-for-risks', 'Look over the payment handler for race conditions.'],
    ['debug.investigate', 'Checkout sometimes double-charges. Investigate.'],
    ['debug.wrong-behaviour', 'Why does the report show the wrong currency?'],
    ['debug.error-report', 'KeyError: user_id on login, see the logs.'],
    ['debug.fix-bug', 'Fix the regression in the date picker.'],
    ['test.write-tests', 'Add unit tests for the parser.'],
    ['test.coverage', 'Raise coverage on the auth module.'],
    ['refactor.explicit', 'Clean up the duplicated retry code. No behaviour change.'],
    ['refactor.move-code', 'Extract the validation into its own module.'],
    ['ops.infrastructure', 'Write a Dockerfile for the API.'],
    ['ops.ci', 'The CI is slow; cache node_modules.'],
    ['research.how-it-works', 'How does the session cookie get refreshed?'],
    ['research.compare', 'Compare SQS and Kafka for this queue.'],
    ['implement.build', 'Add dark mode to the settings page.'],
  ];

  it('has an example for every rule', () => {
    assert.deepEqual(examples.map(([id]) => id).sort(), PROMPT_RULES.map((r) => r.id).sort());
  });

  for (const [ruleId, prompt] of examples) {
    it(`${ruleId}: "${prompt}"`, () => {
      assert.equal(classifyPrompt(prompt)?.ruleId, ruleId);
    });
  }

  it('lets the most specific category win and records every match', () => {
    // implement ("Add"), test ("tests") and debug ("fails with") all match; debug has priority.
    const c = classifyPrompt("Add tests: the parser fails with 'unexpected token'.");
    assert.equal(c?.category, 'debug');
    assert.deepEqual(c?.matchedRuleIds, ['debug.error-report', 'test.write-tests', 'implement.build']);
  });

  it('does not treat "error handling" or a test file path as a debug or test request', () => {
    assert.equal(classifyPrompt('Is the error handling in api.go good enough to ship? Be specific.')?.category, 'review');
    assert.equal(
      classifyPrompt('Create src/__tests__/Card.test.tsx with a helper that formats prices.')?.category,
      'implement',
    );
  });

  it('does not take a Dockerfile that runs the tests for a test request', () => {
    assert.equal(classifyPrompt('Write a Dockerfile and a GitHub Actions workflow that runs the tests on PRs.')?.category, 'ops');
  });

  it('returns null when no prompt rule matches', () => {
    assert.equal(classifyPrompt('Hmm.'), null);
  });
});

describe('tool-shape fallback', () => {
  const b = builder();
  it('read and search only → research', () => {
    const c = classifyByTools([b.tool('Read', 'read', 'a.ts'), b.tool('Grep', 'search', 'x')]);
    assert.deepEqual(c, { category: 'research', ruleId: 'tools.read-only', matchedRuleIds: [] });
  });
  it('mostly edits and writes → implement', () => {
    const c = classifyByTools([b.tool('Edit', 'edit', 'a.ts'), b.tool('Write', 'write', 'b.ts'), b.tool('Read', 'read', 'a.ts')]);
    assert.equal(c?.ruleId, 'tools.mostly-edits');
  });
  it('mostly test commands → test', () => {
    const c = classifyByTools([b.tool('Bash', 'shell', 'pytest -q'), b.tool('Bash', 'shell', 'go test ./...'), b.tool('Read', 'read', 'a.ts')]);
    assert.equal(c?.ruleId, 'tools.mostly-tests');
  });
  it('a mixed bag → no decision', () => {
    assert.equal(classifyByTools([b.tool('Bash', 'shell', 'ls'), b.tool('Edit', 'edit', 'a.ts')]), null);
    assert.equal(classifyByTools([]), null);
  });
});

describe('classifyTurn', () => {
  it('uses the prompt first, then tools, then unknown', () => {
    const b = builder();
    const turns = segmentTurns([
      b.prompt('Hmm.'),
      b.tool('Read', 'read', 'a.ts'),
      b.prompt('Okay then.'),
      b.tool('Bash', 'shell', 'ls'),
    ]);
    assert.equal(classifyTurn(turns[0] ?? assert.fail()).ruleId, 'tools.read-only');
    assert.deepEqual(classifyTurn(turns[1] ?? assert.fail()), { category: 'unknown', ruleId: 'none', matchedRuleIds: [] });
  });

  it('classifies a no-prompt turn as unknown', () => {
    const b = builder();
    const [turn] = segmentTurns([b.call({})]);
    assert.deepEqual(classifyTurn(turn ?? assert.fail()), { category: 'unknown', ruleId: 'no-prompt', matchedRuleIds: [] });
  });

  it('classifies by the opening prompt, never by a correction', () => {
    const b = builder();
    const [turn] = segmentTurns([b.prompt('Explain how parse.py works.'), b.prompt('No — fix the bug instead.')]);
    assert.equal(classifyTurn(turn ?? assert.fail()).category, 'research');
  });

  it('has a content-hash version', () => {
    assert.match(CLASSIFIER_VERSION, /^[0-9a-f]{16}$/);
  });
});
