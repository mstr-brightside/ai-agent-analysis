// Claude Code JSONL (~/.claude/projects/**/*.jsonl).
// Dispositions: `user`, `assistant` → processed; `summary` → recognized-unused;
// any other `type` → unknown; a known type failing its schema, or a line that is not a
// JSON object, → malformed. Session identity comes from `sessionId` inside the records.
import { z } from 'zod';
import {
  assertNever,
  tokenCount,
  type SessionEvent,
  type SourceRecord,
  type SourceRef,
  type ToolKind,
  type ToolOutcome,
  type Usage,
} from '@agentspend/core';
import { normalizeCommand, relativePath } from './targets.ts';

const count = z.number().int().nonnegative();

// Usage in Claude Code CLI 1.0.83 has only input/output tokens; 2.x adds cache fields.
// Newer API responses split cache writes by TTL under `cache_creation`.
const UsageSchema = z.looseObject({
  input_tokens: count,
  output_tokens: count,
  cache_read_input_tokens: count.optional(),
  cache_creation_input_tokens: count.optional(),
  cache_creation: z
    .looseObject({ ephemeral_5m_input_tokens: count.optional(), ephemeral_1h_input_tokens: count.optional() })
    .optional(),
});

const TextBlock = z.looseObject({ type: z.literal('text'), text: z.string() });
const ToolUseBlock = z.looseObject({
  type: z.literal('tool_use'),
  id: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()),
});
const ToolResultBlock = z.looseObject({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  is_error: z.boolean().optional(),
});
const OtherBlock = z.looseObject({ type: z.string() });
const Block = z.union([TextBlock, ToolUseBlock, ToolResultBlock, OtherBlock]);

const Common = {
  uuid: z.string(),
  sessionId: z.string(),
  timestamp: z.string().optional(),
  cwd: z.string().optional(),
  version: z.string().optional(),
  isSidechain: z.boolean().optional(),
};

const UserRecord = z.looseObject({
  type: z.literal('user'),
  ...Common,
  message: z.looseObject({ role: z.literal('user'), content: z.union([z.string(), z.array(Block)]) }),
});

const AssistantRecord = z.looseObject({
  type: z.literal('assistant'),
  ...Common,
  message: z.looseObject({
    id: z.string().optional(),
    model: z.string().optional(),
    content: z.array(Block),
    usage: UsageSchema.optional(),
  }),
});

const SummaryRecord = z.looseObject({ type: z.literal('summary'), leafUuid: z.string().optional() });
const AnyRecord = z.looseObject({ type: z.string() });

function toolKind(name: string): ToolKind {
  switch (name) {
    case 'Read':
      return 'read';
    case 'Grep':
    case 'Glob':
    case 'LS':
      return 'search';
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return 'edit';
    case 'Write':
      return 'write';
    case 'Bash':
      return 'shell';
    default:
      return 'other';
  }
}

function str(input: Record<string, unknown>, key: string): string | null {
  const v = input[key];
  return typeof v === 'string' ? v : null;
}

/** Bash → command; file tools → project-relative file_path; Grep/Glob → pattern + path. */
export function claudeTarget(name: string, input: Record<string, unknown>, projectPath: string | null): string | null {
  const kind = toolKind(name);
  switch (kind) {
    case 'shell': {
      const command = str(input, 'command');
      return command === null ? null : normalizeCommand(command, projectPath);
    }
    case 'read':
    case 'edit':
    case 'write': {
      const file = str(input, 'file_path') ?? str(input, 'notebook_path');
      return file === null ? null : relativePath(file, projectPath);
    }
    case 'search': {
      const pattern = str(input, 'pattern');
      const where = str(input, 'path');
      if (pattern === null) return where === null ? null : relativePath(where, projectPath);
      return where === null ? pattern : `${pattern} in ${relativePath(where, projectPath)}`;
    }
    case 'other':
      return null;
    default:
      return assertNever(kind);
  }
}

export function claudeUsage(usage: z.infer<typeof UsageSchema> | undefined): Usage | null {
  if (usage === undefined) return null;
  const hasCache =
    usage.cache_read_input_tokens !== undefined || usage.cache_creation_input_tokens !== undefined || usage.cache_creation !== undefined;
  if (!hasCache) {
    return { freshInput: tokenCount(usage.input_tokens), output: tokenCount(usage.output_tokens), cache: null, estimate: null };
  }
  // Without a TTL split, cache writes are 5-minute writes (confirmed against OTel cost_usd).
  const split = usage.cache_creation;
  const write5m = split?.ephemeral_5m_input_tokens ?? (split === undefined ? (usage.cache_creation_input_tokens ?? 0) : 0);
  const write1h = split?.ephemeral_1h_input_tokens ?? 0;
  return {
    freshInput: tokenCount(usage.input_tokens),
    output: tokenCount(usage.output_tokens),
    cache: { read: tokenCount(usage.cache_read_input_tokens ?? 0), write5m: tokenCount(write5m), write1h: tokenCount(write1h) },
    estimate: null,
  };
}

function issues(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}

/** Parses one non-blank line. `file` is the file name shown in refs; `fileKey` makes identities unique across directories. */
export function parseClaudeLine(text: string, file: string, line: number, fileKey: string): SourceRecord {
  const ref: SourceRef = { kind: 'line', file, line };
  const lineId = `${fileKey}:${line}`;
  const base = { ref, sessionId: null, info: null, events: [] };

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ...base, disposition: 'malformed', nativeId: lineId, detail: 'not valid JSON (truncated line?)' };
  }
  const any = AnyRecord.safeParse(json);
  if (!any.success) {
    return { ...base, disposition: 'malformed', nativeId: lineId, detail: 'not a JSON object with a string `type`' };
  }

  switch (any.data.type) {
    case 'summary': {
      const s = SummaryRecord.safeParse(json);
      const nativeId = s.success && s.data.leafUuid !== undefined ? `summary:${s.data.leafUuid}` : lineId;
      return { ...base, disposition: 'recognized-unused', nativeId, detail: null };
    }
    case 'user': {
      const r = UserRecord.safeParse(json);
      if (!r.success) return { ...base, disposition: 'malformed', nativeId: lineId, detail: issues(r.error) };
      const u = r.data;
      const timestamp = u.timestamp ?? null;
      const events: SessionEvent[] = [];
      const content = u.message.content;
      const texts: string[] = [];
      if (typeof content === 'string') {
        texts.push(content);
      } else {
        for (const block of content) {
          const text = TextBlock.safeParse(block);
          if (text.success) {
            texts.push(text.data.text);
            continue;
          }
          const result = ToolResultBlock.safeParse(block);
          if (result.success) {
            let outcome: ToolOutcome = 'unknown';
            if (result.data.is_error !== undefined) outcome = result.data.is_error ? 'failure' : 'success';
            events.push({ type: 'tool-result', ref, timestamp, callId: result.data.tool_use_id, outcome });
          }
        }
      }
      const prompt = texts.join('\n');
      if (prompt.trim() !== '') events.unshift({ type: 'prompt', ref, timestamp, text: prompt });
      return {
        ref,
        disposition: 'processed',
        nativeId: u.uuid,
        sessionId: u.sessionId,
        info: { projectPath: u.cwd ?? null, agentVersion: u.version ?? null },
        events,
        detail: null,
      };
    }
    case 'assistant': {
      const r = AssistantRecord.safeParse(json);
      if (!r.success) return { ...base, disposition: 'malformed', nativeId: lineId, detail: issues(r.error) };
      const a = r.data;
      const timestamp = a.timestamp ?? null;
      const projectPath = a.cwd ?? null;
      const events: SessionEvent[] = [
        {
          type: 'model-call',
          ref,
          timestamp,
          messageId: a.message.id ?? null,
          model: a.message.model ?? null,
          usage: claudeUsage(a.message.usage),
          sidechain: a.isSidechain ?? false,
        },
      ];
      for (const block of a.message.content) {
        const use = ToolUseBlock.safeParse(block);
        if (!use.success) continue;
        events.push({
          type: 'tool-call',
          ref,
          timestamp,
          callId: use.data.id,
          tool: use.data.name,
          toolKind: toolKind(use.data.name),
          target: claudeTarget(use.data.name, use.data.input, projectPath),
        });
      }
      return {
        ref,
        disposition: 'processed',
        nativeId: a.uuid,
        sessionId: a.sessionId,
        info: { projectPath, agentVersion: a.version ?? null },
        events,
        detail: null,
      };
    }
    default:
      return { ...base, disposition: 'unknown', nativeId: lineId, detail: `unknown record type "${any.data.type}"` };
  }
}
