// Codex JSONL (~/.codex/sessions/**/*.jsonl).
// Dispositions: `session_meta`, `message`, `function_call`, `function_call_output`,
// `token_count` → processed; other payload types → unknown; a known type failing its
// schema, or a line that is not JSON, → malformed. Identity is file + line.
//
// The session id and model come from `session_meta` (the first line), so they are kept
// as adapter state in the file cursor and survive incremental reads.
//
// Usage: `token_count.info.last_token_usage` is the per-call increment;
// `total_token_usage` is a running total and is never summed. OpenAI semantics:
// `cached_input_tokens` is a subset of `input_tokens`. When a record says cached > input
// (impossible as documented), fresh input is clamped to 0 and the call is `estimated`.
import { z } from 'zod';
import { tokenCount, type SessionEvent, type SourceRecord, type SourceRef, type ToolOutcome, type Usage } from '@agentspend/core';
import { normalizeCommand } from './targets.ts';

export const CodexState = z.object({
  sessionId: z.string().nullable(),
  model: z.string().nullable(),
  projectPath: z.string().nullable(),
});
export type CodexState = z.infer<typeof CodexState>;
export const INITIAL_CODEX_STATE: CodexState = { sessionId: null, model: null, projectPath: null };

const count = z.number().int().nonnegative();

const Envelope = z.looseObject({ type: z.string(), timestamp: z.string().optional(), payload: z.unknown() });

const SessionMeta = z.looseObject({
  id: z.string(),
  cwd: z.string().optional(),
  cli_version: z.string().optional(),
  model: z.string().optional(),
});
const PayloadType = z.looseObject({ type: z.string() });
const Message = z.looseObject({
  type: z.literal('message'),
  role: z.string(),
  content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })),
});
const FunctionCall = z.looseObject({
  type: z.literal('function_call'),
  name: z.string(),
  arguments: z.string(),
  call_id: z.string(),
});
const FunctionCallOutput = z.looseObject({
  type: z.literal('function_call_output'),
  call_id: z.string(),
  output: z.string(),
});
const TokenUsage = z.looseObject({
  input_tokens: count,
  cached_input_tokens: count.optional(),
  output_tokens: count,
  reasoning_output_tokens: count.optional(),
});
const TokenCount = z.looseObject({
  type: z.literal('token_count'),
  info: z.looseObject({ last_token_usage: TokenUsage }).nullable(),
});
const ShellArgs = z.looseObject({ command: z.union([z.array(z.string()), z.string()]) });
const OutputBody = z.looseObject({ metadata: z.looseObject({ exit_code: z.number().int() }) });

/** Codex wraps commands as ["bash", "-lc", "<cmd>"]; the wrapper is dropped from the target. */
export function codexCommand(args: string): string | null {
  let json: unknown;
  try {
    json = JSON.parse(args);
  } catch {
    return null;
  }
  const parsed = ShellArgs.safeParse(json);
  if (!parsed.success) return null;
  const parts = typeof parsed.data.command === 'string' ? [parsed.data.command] : parsed.data.command;
  const unwrapped = parts[0] === 'bash' && parts[1] === '-lc' ? parts.slice(2) : parts;
  return unwrapped.join(' ');
}

/** exit_code 0 → success, anything else → failure, missing → unknown. Output text is not interpreted. */
export function codexOutcome(output: string): ToolOutcome {
  let json: unknown;
  try {
    json = JSON.parse(output);
  } catch {
    return 'unknown';
  }
  const parsed = OutputBody.safeParse(json);
  if (!parsed.success) return 'unknown';
  return parsed.data.metadata.exit_code === 0 ? 'success' : 'failure';
}

export function codexUsage(u: z.infer<typeof TokenUsage>): Usage {
  const cached = u.cached_input_tokens ?? 0;
  const exceeds = cached > u.input_tokens;
  return {
    freshInput: tokenCount(Math.max(0, u.input_tokens - cached)),
    // reasoning_output_tokens are already part of output_tokens.
    output: tokenCount(u.output_tokens),
    cache: { read: tokenCount(cached), write5m: tokenCount(0), write1h: tokenCount(0) },
    estimate: exceeds ? 'cached-exceeds-input' : null,
  };
}

/** Text Codex injects as a user message (environment, instructions) rather than something the developer typed. */
function isInjectedContext(text: string): boolean {
  return /^\s*<(environment_context|user_instructions|user_action)>/.test(text);
}

export function parseCodexLine(
  text: string,
  file: string,
  line: number,
  fileKey: string,
  state: CodexState,
): { record: SourceRecord; state: CodexState } {
  const ref: SourceRef = { kind: 'line', file, line };
  const nativeId = `${fileKey}:${line}`;
  const fail = (disposition: 'malformed' | 'unknown', detail: string): { record: SourceRecord; state: CodexState } => ({
    record: { ref, disposition, nativeId, sessionId: state.sessionId, info: null, events: [], detail },
    state,
  });
  const ok = (events: SessionEvent[], next: CodexState = state): { record: SourceRecord; state: CodexState } => ({
    record: {
      ref,
      disposition: 'processed',
      nativeId,
      sessionId: next.sessionId,
      info: { projectPath: next.projectPath, agentVersion: null },
      events,
      detail: null,
    },
    state: next,
  });

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return fail('malformed', 'not valid JSON (truncated line?)');
  }
  const envelope = Envelope.safeParse(json);
  if (!envelope.success) return fail('malformed', 'not a JSON object with a string `type`');
  const timestamp = envelope.data.timestamp ?? null;
  const payload = envelope.data.payload;

  if (envelope.data.type === 'session_meta') {
    const meta = SessionMeta.safeParse(payload);
    if (!meta.success) return fail('malformed', 'session_meta without a string `id`');
    const next: CodexState = { sessionId: meta.data.id, model: meta.data.model ?? null, projectPath: meta.data.cwd ?? null };
    return {
      record: {
        ref,
        disposition: 'processed',
        nativeId,
        sessionId: next.sessionId,
        info: { projectPath: next.projectPath, agentVersion: meta.data.cli_version ?? null },
        events: [],
        detail: null,
      },
      state: next,
    };
  }

  const kind = PayloadType.safeParse(payload);
  if (!kind.success) return fail('unknown', `unknown record type "${envelope.data.type}"`);

  switch (kind.data.type) {
    case 'message': {
      const m = Message.safeParse(payload);
      if (!m.success) return fail('malformed', 'message without role or content');
      if (m.data.role !== 'user') return ok([]);
      const prompt = m.data.content.flatMap((c) => (c.text === undefined ? [] : [c.text])).join('\n');
      if (prompt.trim() === '' || isInjectedContext(prompt)) return ok([]);
      return ok([{ type: 'prompt', ref, timestamp, text: prompt }]);
    }
    case 'function_call': {
      const f = FunctionCall.safeParse(payload);
      if (!f.success) return fail('malformed', 'function_call without name, arguments or call_id');
      const command = f.data.name === 'shell' ? codexCommand(f.data.arguments) : null;
      return ok([
        {
          type: 'tool-call',
          ref,
          timestamp,
          callId: f.data.call_id,
          tool: f.data.name,
          toolKind: f.data.name === 'shell' ? 'shell' : 'other',
          target: command === null ? null : normalizeCommand(command, state.projectPath),
        },
      ]);
    }
    case 'function_call_output': {
      const o = FunctionCallOutput.safeParse(payload);
      if (!o.success) return fail('malformed', 'function_call_output without call_id or output');
      return ok([{ type: 'tool-result', ref, timestamp, callId: o.data.call_id, outcome: codexOutcome(o.data.output) }]);
    }
    case 'token_count': {
      const t = TokenCount.safeParse(payload);
      if (!t.success) return fail('malformed', 'token_count with invalid usage');
      // info is null on rate-limit-only updates: no model call happened.
      if (t.data.info === null) return ok([]);
      return ok([
        {
          type: 'model-call',
          ref,
          timestamp,
          messageId: null,
          model: state.model,
          usage: codexUsage(t.data.info.last_token_usage),
          sidechain: false,
        },
      ]);
    }
    default:
      return fail('unknown', `unknown payload type "${kind.data.type}"`);
  }
}
