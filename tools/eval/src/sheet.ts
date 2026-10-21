// Builds eval/sheet.csv: a seeded, stratified sample of intent turns for blind labelling.
// Columns: id, prompt, tools. No predictions: this runs before any classifier rule exists.
//
// It has its own minimal reader (prompt text and tool calls only), independent of the
// source adapters, so the labelling sheet cannot inherit an adapter bug.
//
// Usage: node tools/eval/src/sheet.ts [--source claude=N] [--source codex=N] [--source cursor=N] [--append]
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { promptKind, seededRandom, shuffled } from '@agentspend/core';
import { csvLine, readCsv } from '@agentspend/sources';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const DATASET = path.join(ROOT, 'fixtures/session-logs-dataset');
const SHEET = path.join(ROOT, 'eval/sheet.csv');
const SEED = 20261011;

type Turn = { id: string; source: string; project: string; prompt: string; tools: string[] };

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return walk(full);
    return e.name.endsWith('.jsonl') ? [full] : [];
  });
}

/** Groups prompts into turns: an intent prompt opens a turn, ack/correction join it. */
class TurnBuilder {
  readonly turns: Turn[] = [];
  private current: Turn | null = null;
  private readonly source: string;
  private readonly project: () => string;
  constructor(source: string, project: () => string) {
    this.source = source;
    this.project = project;
  }
  prompt(id: string, text: string): void {
    const kind = promptKind(text).kind;
    if (kind === 'intent' || this.current === null) {
      this.current = { id, source: this.source, project: this.project(), prompt: text, tools: [] };
      this.turns.push(this.current);
    }
  }
  tool(description: string): void {
    this.current?.tools.push(description);
  }
}

const block = z.looseObject({
  type: z.string(),
  text: z.string().optional(),
  name: z.string().optional(),
  input: z.record(z.string(), z.unknown()).optional(),
});
const claudeRecord = z.looseObject({
  type: z.string(),
  uuid: z.string().optional(),
  cwd: z.string().optional(),
  message: z.looseObject({ content: z.union([z.string(), z.array(block)]) }).optional(),
});

function describeTool(name: string, input: Record<string, unknown> | undefined): string {
  const command = input?.['command'];
  if (typeof command === 'string') return `${name}(${command})`;
  return name;
}

function claudeTurns(): Turn[] {
  const turns: Turn[] = [];
  for (const file of walk(path.join(DATASET, 'claude-code/projects'))) {
    const seen = new Set<string>();
    let project = '?';
    const builder = new TurnBuilder('claude', () => project);
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        let json: unknown;
        try {
          json = JSON.parse(line);
        } catch {
          return;
        }
        const parsed = claudeRecord.safeParse(json);
        if (!parsed.success || parsed.data.message === undefined) return;
        const r = parsed.data;
        if (r.uuid !== undefined) {
          if (seen.has(r.uuid)) return;
          seen.add(r.uuid);
        }
        if (r.cwd !== undefined) project = path.posix.basename(r.cwd);
        const content = r.message?.content ?? [];
        const id = `claude:${path.basename(file)}:${index + 1}`;
        if (r.type === 'user') {
          const text = typeof content === 'string' ? content : content.flatMap((b) => (b.type === 'text' && b.text !== undefined ? [b.text] : [])).join('\n');
          if (text !== '') builder.prompt(id, text);
        } else if (r.type === 'assistant' && typeof content !== 'string') {
          for (const b of content) if (b.type === 'tool_use' && b.name !== undefined) builder.tool(describeTool(b.name, b.input));
        }
      });
    turns.push(...builder.turns);
  }
  return turns;
}

const codexRecord = z.looseObject({
  type: z.string(),
  payload: z
    .looseObject({
      type: z.string().optional(),
      role: z.string().optional(),
      cwd: z.string().optional(),
      name: z.string().optional(),
      arguments: z.string().optional(),
      content: z.array(z.looseObject({ text: z.string().optional() })).optional(),
    })
    .optional(),
});
const shellArgs = z.looseObject({ command: z.array(z.string()) });

function codexTurns(): Turn[] {
  const turns: Turn[] = [];
  for (const file of walk(path.join(DATASET, 'codex/sessions'))) {
    let project = '?';
    const builder = new TurnBuilder('codex', () => project);
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        let json: unknown;
        try {
          json = JSON.parse(line);
        } catch {
          return;
        }
        const parsed = codexRecord.safeParse(json);
        if (!parsed.success || parsed.data.payload === undefined) return;
        const p = parsed.data.payload;
        if (parsed.data.type === 'session_meta' && p.cwd !== undefined) project = path.posix.basename(p.cwd);
        if (p.type === 'message' && p.role === 'user') {
          builder.prompt(`codex:${path.basename(file)}:${index + 1}`, (p.content ?? []).map((c) => c.text ?? '').join('\n'));
        }
        if (p.type === 'function_call' && p.name !== undefined) {
          let command = '';
          try {
            const args = shellArgs.safeParse(JSON.parse(p.arguments ?? ''));
            if (args.success) command = args.data.command.filter((c, i) => !(i < 2 && (c === 'bash' || c === '-lc'))).join(' ');
          } catch {
            // arguments not JSON: tool name only
          }
          builder.tool(command === '' ? p.name : `${p.name}(${command})`);
        }
      });
    turns.push(...builder.turns);
  }
  return turns;
}

const cursorBubble = z.looseObject({
  type: z.number(),
  text: z.string().optional(),
  toolFormerData: z.looseObject({ name: z.string(), rawArgs: z.string().optional() }).optional(),
});
const cursorComposer = z.looseObject({
  fullConversationHeadersOnly: z.array(z.looseObject({ bubbleId: z.string() })).optional(),
  workspaceFolder: z.string().optional(),
});
const rowSchema = z.object({ key: z.string(), value: z.string() });

function cursorTurns(): Turn[] {
  const dbPath = path.join(ROOT, 'fixtures/cursor/state.vscdb');
  if (!existsSync(dbPath)) return [];
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const rows = new Map<string, string>();
  for (const raw of db.prepare('SELECT key, value FROM cursorDiskKV').all()) {
    const row = rowSchema.parse(raw);
    rows.set(row.key, row.value);
  }
  db.close();
  const turns: Turn[] = [];
  for (const [key, value] of rows) {
    if (!key.startsWith('composerData:')) continue;
    const composerId = key.slice('composerData:'.length);
    let composer;
    try {
      composer = cursorComposer.parse(JSON.parse(value));
    } catch {
      continue;
    }
    const project = composer.workspaceFolder === undefined ? '?' : path.posix.basename(composer.workspaceFolder);
    const builder = new TurnBuilder('cursor', () => project);
    for (const header of composer.fullConversationHeadersOnly ?? []) {
      const bubbleKey = `bubbleId:${composerId}:${header.bubbleId}`;
      const raw = rows.get(bubbleKey);
      if (raw === undefined) continue;
      let bubble;
      try {
        bubble = cursorBubble.parse(JSON.parse(raw));
      } catch {
        continue;
      }
      if (bubble.type === 1 && bubble.text !== undefined) builder.prompt(`cursor:${bubbleKey}`, bubble.text);
      if (bubble.toolFormerData !== undefined) builder.tool(bubble.toolFormerData.name);
    }
    turns.push(...builder.turns);
  }
  return turns;
}

/** Round-robin over projects (sorted), each project's turns in seeded random order. */
function sample(turns: readonly Turn[], count: number, seed: number): Turn[] {
  const random = seededRandom(seed);
  const byProject = new Map<string, Turn[]>();
  for (const t of turns) byProject.set(t.project, [...(byProject.get(t.project) ?? []), t]);
  const queues = [...byProject.keys()].sort().map((p) => shuffled(byProject.get(p) ?? [], random));
  const picked: Turn[] = [];
  while (picked.length < count && queues.some((q) => q.length > 0)) {
    for (const q of queues) {
      const next = q.shift();
      if (next !== undefined && picked.length < count) picked.push(next);
    }
  }
  return picked;
}

const quotas = new Map<string, number>([
  ['claude', 0],
  ['codex', 0],
  ['cursor', 0],
]);
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const match = args[i] === '--source' ? /^(claude|codex|cursor)=(\d+)$/.exec(args[i + 1] ?? '') : null;
  if (match?.[1] !== undefined && match[2] !== undefined) quotas.set(match[1], Number(match[2]));
}
const append = args.includes('--append');

function turnsOf(source: string): Turn[] {
  if (source === 'claude') return claudeTurns();
  if (source === 'codex') return codexTurns();
  return cursorTurns();
}

const rows: Turn[] = [];
for (const [source, count] of quotas) {
  if (count === 0) continue;
  const turns = turnsOf(source);
  if (turns.length < count) throw new Error(`${source}: only ${turns.length} intent turns, asked for ${count}`);
  rows.push(...sample(turns, count, SEED));
}

const existing = append && existsSync(SHEET) ? readCsv(readFileSync(SHEET, 'utf8')).slice(1) : [];
const existingIds = new Set(existing.map((r) => r[0]));
const fresh = rows.filter((r) => !existingIds.has(r.id));
const out = [
  csvLine(['id', 'prompt', 'tools']),
  ...existing.map(csvLine),
  ...fresh.map((t) => csvLine([t.id, t.prompt, t.tools.join('; ')])),
];
writeFileSync(SHEET, out.join('\n') + '\n');
process.stdout.write(`eval/sheet.csv: ${existing.length + fresh.length} rows (${fresh.length} new)\n`);
