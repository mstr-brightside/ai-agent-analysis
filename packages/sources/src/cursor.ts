// Cursor `state.vscdb` (SQLite, key-value table `cursorDiskKV`).
// Opened read-only (Cursor may hold it open); retried briefly when locked; never copied
// or modified. A hash per key detects new or changed values: `composerData` changes in
// place, bubbles are written once.
//
// Dispositions: `composerData:*`, `bubbleId:*` → processed; other known Cursor key
// families → recognized-unused; anything else → unknown; invalid JSON or a failing
// schema → malformed. Event order is row order.
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { assertNever, tokenCount, type SessionEvent, type SourceRecord, type SourceRef, type ToolKind, type ToolOutcome, type Usage } from '@agentspend/core';
import { normalizeCommand, relativePath } from './targets.ts';

/** Written by tools/gen-cursor-fixture: the database is synthetic, not a real Cursor install. */
export const SYNTHETIC_MARKER_KEY = 'agentspend:fixture';

/** Cursor key families we know but do not analyse. */
const RECOGNIZED_UNUSED = ['checkpointId', 'messageRequestContext', 'codeBlockDiff', 'inlineDiffs', 'composer.content'];

const Row = z.object({ key: z.string(), value: z.union([z.string(), z.instanceof(Uint8Array), z.null()]) });

const count = z.number().int().nonnegative();
const Composer = z.looseObject({
  workspaceFolder: z.string().optional(),
  modelConfig: z.looseObject({ modelName: z.string() }).optional(),
});
const Bubble = z.looseObject({
  type: z.union([z.literal(1), z.literal(2)]),
  createdAt: z.string().optional(),
  text: z.string().optional(),
  tokenCount: z.looseObject({ inputTokens: count, outputTokens: count }).optional(),
  modelInfo: z.looseObject({ modelName: z.string() }).optional(),
  toolFormerData: z
    .looseObject({
      name: z.string(),
      toolCallId: z.string().optional(),
      status: z.string().optional(),
      rawArgs: z.string().optional(),
    })
    .optional(),
});

export type CursorRead =
  | {
      readonly status: 'ok';
      /** New or changed keys only, in row order. `replace` = the key was seen before with another value. */
      readonly records: ReadonlyArray<{ readonly record: SourceRecord; readonly replace: boolean; readonly hash: string }>;
      /** Hash of every key now present, to store for the next run. */
      readonly hashes: ReadonlyMap<string, string>;
      readonly synthetic: boolean;
    }
  | { readonly status: 'unavailable'; readonly message: string };

function toolKind(name: string): ToolKind {
  switch (name) {
    case 'run_terminal_cmd':
      return 'shell';
    case 'edit_file':
    case 'search_replace':
      return 'edit';
    case 'read_file':
      return 'read';
    case 'grep_search':
    case 'codebase_search':
    case 'file_search':
    case 'list_dir':
      return 'search';
    default:
      return 'other';
  }
}

const Args = z.record(z.string(), z.unknown());
function cursorTarget(name: string, rawArgs: string | undefined, projectPath: string | null): string | null {
  if (rawArgs === undefined) return null;
  let parsed;
  try {
    parsed = Args.safeParse(JSON.parse(rawArgs));
  } catch {
    return null;
  }
  if (!parsed.success) return null;
  const s = (k: string): string | null => {
    const v = parsed.data[k];
    return typeof v === 'string' ? v : null;
  };
  const kind = toolKind(name);
  switch (kind) {
    case 'shell': {
      const command = s('command');
      return command === null ? null : normalizeCommand(command, projectPath);
    }
    case 'edit':
    case 'read':
    case 'write': {
      const file = s('target_file') ?? s('file_path');
      return file === null ? null : relativePath(file, projectPath);
    }
    case 'search': {
      const query = s('query') ?? s('relative_workspace_path');
      const include = s('include_pattern');
      if (query === null) return null;
      return include === null ? query : `${query} in ${include}`;
    }
    case 'other':
      return null;
    default:
      return assertNever(kind);
  }
}

function outcome(status: string | undefined): ToolOutcome {
  if (status === 'completed') return 'success';
  if (status === 'error') return 'failure';
  return 'unknown';
}

/** Cursor's tokenCount has no cache fields. Zero or missing counts mean Cursor did not record usage. */
function usageOf(tc: { inputTokens: number; outputTokens: number } | undefined): Usage | null {
  if (tc === undefined || (tc.inputTokens === 0 && tc.outputTokens === 0)) return null;
  return { freshInput: tokenCount(tc.inputTokens), output: tokenCount(tc.outputTokens), cache: null, estimate: null };
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

type ComposerInfo = { projectPath: string | null; model: string | null };

function parseRow(key: string, value: string, composers: ReadonlyMap<string, ComposerInfo>): SourceRecord {
  const ref: SourceRef = { kind: 'key', key };
  const base = { ref, nativeId: key, sessionId: null, info: null, events: [] };
  const family = key.split(':')[0] ?? key;

  if (key === SYNTHETIC_MARKER_KEY) return { ...base, disposition: 'recognized-unused', detail: null };

  if (family === 'composerData') {
    const composerId = key.slice('composerData:'.length);
    const json = parseJson(value);
    if (json === undefined) return { ...base, sessionId: composerId, disposition: 'malformed', detail: 'not valid JSON' };
    const c = Composer.safeParse(json);
    if (!c.success) return { ...base, sessionId: composerId, disposition: 'malformed', detail: 'composerData schema mismatch' };
    return {
      ...base,
      disposition: 'processed',
      sessionId: composerId,
      info: { projectPath: c.data.workspaceFolder ?? null, agentVersion: null },
      detail: null,
    };
  }

  if (family === 'bubbleId') {
    const [, composerId, bubbleId] = key.split(':');
    if (composerId === undefined || bubbleId === undefined) {
      return { ...base, disposition: 'malformed', detail: 'bubble key without composer and bubble ids' };
    }
    const json = parseJson(value);
    if (json === undefined) return { ...base, sessionId: composerId, disposition: 'malformed', detail: 'not valid JSON' };
    const b = Bubble.safeParse(json);
    if (!b.success) return { ...base, sessionId: composerId, disposition: 'malformed', detail: 'bubble schema mismatch' };
    const bubble = b.data;
    const composer = composers.get(composerId) ?? { projectPath: null, model: null };
    const timestamp = bubble.createdAt ?? null;
    const events: SessionEvent[] = [];
    if (bubble.type === 1) {
      const text = bubble.text ?? '';
      if (text.trim() !== '') events.push({ type: 'prompt', ref, timestamp, text });
    } else {
      const tool = bubble.toolFormerData;
      const hasText = (bubble.text ?? '').trim() !== '';
      const usage = usageOf(bubble.tokenCount);
      if (tool === undefined || hasText || usage !== null) {
        events.push({
          type: 'model-call',
          ref,
          timestamp,
          messageId: null,
          model: bubble.modelInfo?.modelName ?? composer.model,
          usage,
          sidechain: false,
        });
      }
      if (tool !== undefined) {
        const callId = tool.toolCallId ?? bubbleId;
        events.push({
          type: 'tool-call',
          ref,
          timestamp,
          callId,
          tool: tool.name,
          toolKind: toolKind(tool.name),
          target: cursorTarget(tool.name, tool.rawArgs, composer.projectPath),
        });
        events.push({ type: 'tool-result', ref, timestamp, callId, outcome: outcome(tool.status) });
      }
    }
    return {
      ...base,
      disposition: 'processed',
      sessionId: composerId,
      info: { projectPath: composer.projectPath, agentVersion: null },
      events,
      detail: null,
    };
  }

  if (RECOGNIZED_UNUSED.includes(family)) return { ...base, disposition: 'recognized-unused', detail: null };
  return { ...base, disposition: 'unknown', detail: `unknown key family "${family}"` };
}

function openReadOnly(dbPath: string, attempts: number, waitMs: number): DatabaseSync | string {
  let last = '';
  for (let i = 0; i < attempts; i++) {
    try {
      const db = new DatabaseSync(dbPath, { readOnly: true, timeout: waitMs });
      db.prepare('SELECT 1 FROM cursorDiskKV LIMIT 1').all();
      return db;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
      if (!/locked|busy/i.test(last)) return last;
    }
  }
  return `database stayed locked: ${last}`;
}

/** Reads every row, returns records for keys that are new or whose value changed since `known`. */
export function readCursorDb(dbPath: string, known: ReadonlyMap<string, string>): CursorRead {
  const db = openReadOnly(dbPath, 3, 200);
  if (typeof db === 'string') return { status: 'unavailable', message: db };
  let raw: unknown[];
  try {
    raw = db.prepare('SELECT key, value FROM cursorDiskKV ORDER BY rowid').all();
  } catch (e) {
    return { status: 'unavailable', message: e instanceof Error ? e.message : String(e) };
  } finally {
    db.close();
  }

  const rows: Array<{ key: string; value: string }> = [];
  for (const r of raw) {
    const row = Row.parse(r);
    let value = '';
    if (typeof row.value === 'string') value = row.value;
    else if (row.value !== null) value = Buffer.from(row.value).toString('utf8');
    rows.push({ key: row.key, value });
  }

  // Composer metadata first: bubbles take their model and project from it.
  const composers = new Map<string, ComposerInfo>();
  for (const { key, value } of rows) {
    if (!key.startsWith('composerData:')) continue;
    const c = Composer.safeParse(parseJson(value));
    if (c.success) {
      composers.set(key.slice('composerData:'.length), {
        projectPath: c.data.workspaceFolder ?? null,
        model: c.data.modelConfig?.modelName ?? null,
      });
    }
  }

  const hashes = new Map<string, string>();
  const records: Array<{ record: SourceRecord; replace: boolean; hash: string }> = [];
  for (const { key, value } of rows) {
    const hash = createHash('sha256').update(value).digest('hex');
    hashes.set(key, hash);
    const previous = known.get(key);
    if (previous === hash) continue;
    records.push({ record: parseRow(key, value, composers), replace: previous !== undefined, hash });
  }
  return { status: 'ok', records, hashes, synthetic: hashes.has(SYNTHETIC_MARKER_KEY) };
}
