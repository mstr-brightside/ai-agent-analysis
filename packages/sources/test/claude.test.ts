import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { analyzeSession, createPricer, type ModelCallEvent, type SessionEvent } from '@agentspend/core';
import { parseClaudeLine } from '../src/claude.ts';

const pricer = createPricer();
const parse = (record: unknown, line = 1): ReturnType<typeof parseClaudeLine> =>
  parseClaudeLine(typeof record === 'string' ? record : JSON.stringify(record), 's.jsonl', line, 'p/s.jsonl');

const common = { sessionId: 's1', cwd: '/home/dev/projects/recipe-web', version: '2.3.0', timestamp: '2026-09-03T10:56:00Z', isSidechain: false };

function assistant(uuid: string, messageId: string | undefined, usage: unknown, content: unknown[] = []): unknown {
  return {
    type: 'assistant',
    uuid,
    ...common,
    message: { ...(messageId === undefined ? {} : { id: messageId }), model: 'claude-opus-4-1-20250805', content, usage },
  };
}

function modelCall(events: readonly SessionEvent[]): ModelCallEvent {
  const call = events.find((e): e is ModelCallEvent => e.type === 'model-call');
  if (call === undefined) assert.fail('no model call');
  return call;
}

describe('Claude adapter', () => {
  it('turns a user prompt (string or text blocks) into a prompt event', () => {
    const a = parse({ type: 'user', uuid: 'u1', ...common, message: { role: 'user', content: 'Add a feature.' } });
    const b = parse({ type: 'user', uuid: 'u2', ...common, message: { role: 'user', content: [{ type: 'text', text: 'Add a feature.' }] } });
    for (const r of [a, b]) {
      assert.equal(r.disposition, 'processed');
      assert.deepEqual(r.events.map((e) => e.type), ['prompt']);
      assert.equal(r.sessionId, 's1');
      assert.equal(r.info?.projectPath, '/home/dev/projects/recipe-web');
    }
  });

  it('turns tool results into outcomes, never into prompts', () => {
    const r = parse({
      type: 'user',
      uuid: 'u3',
      ...common,
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'FAIL', is_error: true },
          { type: 'tool_result', tool_use_id: 't2', content: 'ok', is_error: false },
          { type: 'tool_result', tool_use_id: 't3', content: '?' },
        ],
      },
    });
    assert.deepEqual(
      r.events.map((e) => (e.type === 'tool-result' ? e.outcome : e.type)),
      ['failure', 'success', 'unknown'],
    );
  });

  it('emits a model call and tool calls with project-relative targets', () => {
    const r = parse(
      assistant('a1', 'msg_1', { input_tokens: 1, output_tokens: 1 }, [
        { type: 'text', text: 'Running.' },
        { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'go   test\n ./...' } },
        { type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: '/home/dev/projects/recipe-web/src/a.ts', old_string: 'x', new_string: 'y' } },
        { type: 'tool_use', id: 't3', name: 'Grep', input: { pattern: 'TODO', path: '/home/dev/projects/recipe-web/src' } },
        { type: 'tool_use', id: 't4', name: 'Read', input: { file_path: '/etc/hosts' } },
      ]),
    );
    const calls = r.events.flatMap((e) => (e.type === 'tool-call' ? [[e.tool, e.toolKind, e.target]] : []));
    assert.deepEqual(calls, [
      ['Bash', 'shell', 'go test ./...'],
      ['Edit', 'edit', 'src/a.ts'],
      ['Grep', 'search', 'TODO in src'],
      ['Read', 'read', '…/hosts'],
    ]);
  });

  it('CLI 1.0.83 usage without cache fields → complete-no-cache-data', () => {
    const r = parse(assistant('a2', 'msg_2', { input_tokens: 100, output_tokens: 10 }));
    const call = modelCall(r.events);
    assert.equal(call.usage?.cache, null);
    assert.equal(pricer.price(call.model, call.usage).status, 'complete-no-cache-data');
  });

  it('cache writes without a TTL split are 5-minute writes; a TTL split is respected', () => {
    const plain = modelCall(parse(assistant('a3', 'm', { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 5, cache_creation_input_tokens: 7 })).events);
    assert.deepEqual(plain.usage?.cache, { read: 5, write5m: 7, write1h: 0 });
    const split = modelCall(
      parse(
        assistant('a4', 'm', {
          input_tokens: 1,
          output_tokens: 1,
          cache_read_input_tokens: 5,
          cache_creation_input_tokens: 10,
          cache_creation: { ephemeral_5m_input_tokens: 4, ephemeral_1h_input_tokens: 6 },
        }),
      ).events,
    );
    assert.deepEqual(split.usage?.cache, { read: 5, write5m: 4, write1h: 6 });
  });

  it('keeps missing usage missing', () => {
    assert.equal(modelCall(parse(assistant('a5', 'msg_5', undefined)).events).usage, null);
  });

  it('a replayed record has the same identity (the store marks it duplicate)', () => {
    const line = JSON.stringify(assistant('a6', 'msg_6', { input_tokens: 1, output_tokens: 1 }));
    assert.equal(parse(line, 2).nativeId, parse(line, 46).nativeId);
  });

  it('charges usage once per message.id when one message spans several records', () => {
    const usage = { input_tokens: 341, output_tokens: 562, cache_read_input_tokens: 58_269, cache_creation_input_tokens: 1_988 };
    const events = [
      ...parse({ type: 'user', uuid: 'u9', ...common, message: { role: 'user', content: 'Add a feature.' } }).events,
      ...parse(assistant('a7', 'msg_same', usage, [{ type: 'text', text: 'part 1' }])).events,
      ...parse(assistant('a8', 'msg_same', usage, [{ type: 'tool_use', id: 't', name: 'Read', input: { file_path: 'x' } }])).events,
    ];
    const analysis = analyzeSession({ source: 'claude', sessionId: 's1', info: { projectPath: null, agentVersion: null }, events }, pricer);
    assert.equal(analysis.spend.total, 171_943_500);
    assert.equal(analysis.spend.repeatedUsageCalls, 1);
  });

  it('summary → recognized-unused; unknown type → unknown; truncated JSON and schema failures → malformed', () => {
    assert.equal(parse({ type: 'summary', summary: 'x', leafUuid: 'l1' }).disposition, 'recognized-unused');
    const unknown = parse({ type: 'file-history-snapshot', uuid: 'f' });
    assert.equal(unknown.disposition, 'unknown');
    assert.match(unknown.detail ?? '', /file-history-snapshot/);
    assert.equal(parse('{"type": "assistant", "uuid": "a9", "mess').disposition, 'malformed');
    const bad = parse({ type: 'assistant', uuid: 'a10', sessionId: 's1', message: { content: [], usage: { input_tokens: -1, output_tokens: 1 } } });
    assert.equal(bad.disposition, 'malformed');
    assert.match(bad.detail ?? '', /usage/);
    assert.equal(parse('[1, 2]').disposition, 'malformed');
  });
});
