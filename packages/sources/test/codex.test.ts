import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createPricer, type ModelCallEvent } from '@agentspend/core';
import { INITIAL_CODEX_STATE, parseCodexLine, type CodexState } from '../src/codex.ts';

const pricer = createPricer();

/** Parses lines in order, threading the adapter state like the ingest does. */
function run(records: readonly unknown[]): ReturnType<typeof parseCodexLine>['record'][] {
  let state: CodexState = INITIAL_CODEX_STATE;
  return records.map((r, i) => {
    const out = parseCodexLine(typeof r === 'string' ? r : JSON.stringify(r), 'rollout.jsonl', i + 1, '2026/08/rollout.jsonl', state);
    state = out.state;
    return out.record;
  });
}

const meta = {
  timestamp: '2026-08-09T18:00:00Z',
  type: 'session_meta',
  payload: { id: 'sess-1', cwd: '/home/dev/projects/recipe-web', cli_version: '0.51.2', model: 'gpt-5-mini', instructions: null },
};
const usage = (input: number, cached: number, output: number) => ({ input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: 1 });
const tokenCount = (last: unknown, total: unknown) => ({
  timestamp: 't',
  type: 'event_msg',
  payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: last, model_context_window: 272000 } },
});

describe('Codex adapter', () => {
  it('takes session id, project and model from session_meta for every later line', () => {
    const [m, p] = run([meta, { timestamp: 't', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Add a feature.' }] } }]);
    assert.equal(m?.sessionId, 'sess-1');
    assert.equal(m?.info?.agentVersion, '0.51.2');
    assert.equal(p?.sessionId, 'sess-1');
    assert.deepEqual(p?.events.map((e) => e.type), ['prompt']);
  });

  it('prices the per-call increment, never the running total', () => {
    const records = run([meta, tokenCount(usage(9376, 1000, 692), usage(9376, 1000, 692)), tokenCount(usage(100, 0, 10), usage(9476, 1000, 702))]);
    const calls = records.flatMap((r) => r.events.filter((e): e is ModelCallEvent => e.type === 'model-call'));
    assert.equal(calls.length, 2);
    assert.equal(calls[1]?.usage?.freshInput, 100);
    assert.equal(calls[0]?.model, 'gpt-5-mini');
    // OpenAI semantics: cached ⊂ input. 8376 fresh × 250 + 1000 cached × 25 + 692 out × 2000.
    const priced = pricer.price(calls[0]?.model ?? null, calls[0]?.usage ?? null);
    assert.equal(priced.status, 'complete');
    assert.equal(priced.cost, 8376 * 250 + 1000 * 25 + 692 * 2000);
  });

  it('cached > input → fresh clamped to 0, status estimated', () => {
    const [, r] = run([meta, tokenCount(usage(9376, 19001, 692), usage(9376, 19001, 692))]);
    const call = r?.events[0];
    assert.equal(call?.type, 'model-call');
    if (call?.type !== 'model-call') return;
    assert.equal(call.usage?.freshInput, 0);
    assert.equal(call.usage?.cache?.read, 19001);
    assert.equal(pricer.price(call.model, call.usage).status, 'estimated');
  });

  it('shell calls drop the bash -lc wrapper; outcome comes from exit_code only', () => {
    const records = run([
      meta,
      { timestamp: 't', type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{"command": ["bash", "-lc", "pytest  -q"]}', call_id: 'c1' } },
      { timestamp: 't', type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: '{"output": "FAILED tests/x", "metadata": {"exit_code": 0}}' } },
      { timestamp: 't', type: 'response_item', payload: { type: 'function_call_output', call_id: 'c2', output: '{"output": "ok", "metadata": {"exit_code": 1}}' } },
      { timestamp: 't', type: 'response_item', payload: { type: 'function_call_output', call_id: 'c3', output: 'plain text' } },
    ]);
    const call = records[1]?.events[0];
    assert.equal(call?.type === 'tool-call' ? call.target : null, 'pytest -q');
    assert.deepEqual(
      records.slice(2).map((r) => (r.events[0]?.type === 'tool-result' ? r.events[0].outcome : null)),
      ['success', 'failure', 'unknown'],
    );
  });

  it('identity is file + line; unknown payloads and broken lines are counted', () => {
    const records = run([meta, { timestamp: 't', type: 'response_item', payload: { type: 'reasoning', summary: [] } }, '{"timestamp": "t", "type": "resp']);
    assert.equal(records[0]?.nativeId, '2026/08/rollout.jsonl:1');
    assert.equal(records[1]?.disposition, 'unknown');
    assert.equal(records[2]?.disposition, 'malformed');
  });

  it('ignores injected environment context as a prompt', () => {
    const [, r] = run([meta, { timestamp: 't', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context>' }] } }]);
    assert.equal(r?.disposition, 'processed');
    assert.deepEqual(r?.events, []);
  });
});
