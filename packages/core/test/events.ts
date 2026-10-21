// Tiny builders for inline test sessions. Refs are synthetic line numbers in file order.
import type {
  ModelCallEvent,
  PromptEvent,
  SessionEvent,
  SessionInput,
  ToolCallEvent,
  ToolKind,
  ToolOutcome,
  ToolResultEvent,
} from '../src/model.ts';
import { tokenCount } from '../src/units.ts';
import type { Usage } from '../src/usage.ts';

export function builder(): {
  prompt(text: string): PromptEvent;
  call(opts: { model?: string | null; usage?: Usage | null; messageId?: string | null; sidechain?: boolean }): ModelCallEvent;
  tool(tool: string, toolKind: ToolKind, target: string | null, callId?: string): ToolCallEvent;
  result(callId: string, outcome: ToolOutcome): ToolResultEvent;
  attempt(tool: string, toolKind: ToolKind, target: string, outcome: ToolOutcome): [ToolCallEvent, ToolResultEvent];
} {
  let line = 0;
  let ids = 0;
  const ref = (): { kind: 'line'; file: string; line: number } => ({ kind: 'line', file: 's.jsonl', line: ++line });
  return {
    prompt: (text) => ({ type: 'prompt', ref: ref(), timestamp: null, text }),
    call: (opts) => ({
      type: 'model-call',
      ref: ref(),
      timestamp: null,
      messageId: opts.messageId ?? null,
      model: opts.model === undefined ? 'claude-sonnet-4-5-20250929' : opts.model,
      usage: opts.usage === undefined ? usage(1000, 100) : opts.usage,
      sidechain: opts.sidechain ?? false,
    }),
    tool: (tool, toolKind, target, callId) => ({
      type: 'tool-call',
      ref: ref(),
      timestamp: null,
      callId: callId ?? `c${++ids}`,
      tool,
      toolKind,
      target,
    }),
    result: (callId, outcome) => ({ type: 'tool-result', ref: ref(), timestamp: null, callId, outcome }),
    attempt(tool, toolKind, target, outcome) {
      const call = this.tool(tool, toolKind, target);
      return [call, this.result(call.callId, outcome)];
    },
  };
}

/** Anthropic-style usage with cache fields. Sonnet 4.5: 1000 in + 100 out = 3,000,000 + 1,500,000 nano-USD. */
export function usage(freshInput: number, output: number, cacheRead = 0, cacheWrite5m = 0): Usage {
  return {
    freshInput: tokenCount(freshInput),
    output: tokenCount(output),
    cache: { read: tokenCount(cacheRead), write5m: tokenCount(cacheWrite5m), write1h: tokenCount(0) },
    estimate: null,
  };
}

export function session(events: readonly SessionEvent[]): SessionInput {
  return {
    source: 'claude',
    sessionId: 's1',
    info: { projectPath: '/home/dev/projects/recipe-web', agentVersion: '2.3.0' },
    events,
  };
}
