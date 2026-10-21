// Seeded, deterministic generator for a synthetic Cursor `state.vscdb`.
//
// Layout mirrors Cursor's real database: a `cursorDiskKV` key-value table holding JSON
// values under `composerData:<composerId>` (one per chat) and
// `bubbleId:<composerId>:<bubbleId>` (one per message), plus an `ItemTable`.
// Rows are inserted the way Cursor writes them: bubbles as they are created, and the
// composer last (Cursor rewrites it in place with INSERT OR REPLACE, which moves it to a new rowid).
//
// Realistic gaps on purpose: three schema versions; `tokenCount` present, zero or missing;
// `auto` hides the real model; the project folder exists only in the newest version.
// Seeded cases: one failure streak, one correction streak, one malformed JSON value,
// recognized-but-unused key families, one unknown key family.
import { rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { assertNever, seededRandom, shuffled, type Random } from '@agentspend/core';

export const FIXTURE_SEED = 20261011;
export const SYNTHETIC_MARKER_KEY = 'agentspend:fixture';

type SchemaVersion = 1 | 2 | 3;
type Model = 'claude-4.5-sonnet' | 'gpt-5' | 'auto';
type TokenMode = 'present' | 'zero' | 'missing';

type ToolName = 'run_terminal_cmd' | 'edit_file' | 'read_file' | 'grep_search';
type ToolStep = { tool: ToolName; args: Record<string, string>; status: 'completed' | 'error' };
type TurnScript = { prompt: string; tools: ToolStep[] };
type ComposerScript = {
  version: SchemaVersion;
  model: Model;
  project: string;
  tokens: TokenMode;
  turns: TurnScript[];
};

const PROJECTS = ['recipe-web', 'inventory-service', 'ledger-cli'];
const FILES = ['src/api/client.ts', 'src/hooks/useRecipes.ts', 'internal/api/handlers.go', 'ledger/parse.py', 'cmd/server/main.go'];
const TEST_COMMANDS = ['npm test', 'go test ./...', 'pytest -q'];
const TOPICS = ['cursor-based pagination', 'rate limiting per API key', 'CSV export with currency formatting', 'idempotent stock adjustments'];

// Same template style as the vendor dataset's prompts.
const TEMPLATES: ReadonlyArray<(r: Random) => string> = [
  (r) => `Implement ${pick(r, TOPICS)} in ${pick(r, FILES)}. Follow the existing patterns.`,
  (r) => `Write table-driven tests for ${pick(r, FILES)} covering decimal rounding.`,
  (r) => `Explain how ${pick(r, FILES)} currently works and where context cancellation is handled.`,
  (r) => `Refactor ${pick(r, FILES)} to remove the duplication between the two handlers. No behaviour change.`,
  (r) => `Before writing code, give me a plan for adding ${pick(r, TOPICS)}. List the files you'd touch and the risks.`,
  (r) => `Is the error handling in ${pick(r, FILES)} good enough to ship? Be specific.`,
  () => 'Set up a Makefile target for lint + test + build.',
  (r) => `Why does ${pick(r, FILES)} return the wrong total when there are duplicate SKUs?`,
];

function pick<T>(r: Random, items: readonly T[]): T {
  const item = items[Math.floor(r() * items.length)];
  if (item === undefined) throw new Error('pick from empty list');
  return item;
}

function randomTool(r: Random): ToolStep {
  const tool = pick(r, ['run_terminal_cmd', 'edit_file', 'read_file', 'grep_search'] as const);
  const status = r() < 0.2 ? 'error' : 'completed';
  switch (tool) {
    case 'run_terminal_cmd':
      return { tool, args: { command: pick(r, TEST_COMMANDS) }, status };
    case 'edit_file':
      return { tool, args: { target_file: pick(r, FILES), instructions: 'Apply the change.' }, status };
    case 'read_file':
      return { tool, args: { target_file: pick(r, FILES) }, status: 'completed' };
    case 'grep_search':
      return { tool, args: { query: pick(r, ['TODO', 'func Parse', 'useRecipes']) }, status: 'completed' };
    default:
      return assertNever(tool);
  }
}

function scripts(r: Random): ComposerScript[] {
  const npmTest = (status: ToolStep['status']): ToolStep => ({ tool: 'run_terminal_cmd', args: { command: 'npm test' }, status });
  const edit = (file: string): ToolStep => ({ tool: 'edit_file', args: { target_file: file, instructions: 'Fix it.' }, status: 'completed' });
  const seeded: ComposerScript[] = [
    {
      // Failure streak: `npm test` fails 3 times in a row, with edits in between.
      version: 3,
      model: 'claude-4.5-sonnet',
      project: 'recipe-web',
      tokens: 'present',
      turns: [
        {
          prompt: "Tests in src/api/client.ts fail with 'TypeError: cannot read properties of undefined'. Find the cause.",
          tools: [
            { tool: 'read_file', args: { target_file: 'src/api/client.ts' }, status: 'completed' },
            npmTest('error'),
            edit('src/api/client.ts'),
            npmTest('error'),
            edit('src/api/client.ts'),
            npmTest('error'),
            edit('src/hooks/useRecipes.ts'),
            npmTest('completed'),
          ],
        },
      ],
    },
    {
      // Correction streak: two corrections in a row, then an ack.
      version: 3,
      model: 'gpt-5',
      project: 'inventory-service',
      tokens: 'present',
      turns: [
        { prompt: 'Add idempotent stock adjustments. Keep the public API unchanged.', tools: [edit('internal/api/handlers.go')] },
        { prompt: 'Wrong file. The logic lives in internal/stock/reconcile.go, not where you edited.', tools: [edit('internal/stock/reconcile.go')] },
        { prompt: 'Still failing. Run the tests yourself before telling me it works.', tools: [{ tool: 'run_terminal_cmd', args: { command: 'go test ./...' }, status: 'completed' }] },
        { prompt: 'Thanks — ship it.', tools: [] },
      ],
    },
    {
      // `auto`: the real model is hidden, so this stays unpriced.
      version: 3,
      model: 'auto',
      project: 'ledger-cli',
      tokens: 'present',
      turns: [{ prompt: 'How does click handle schema validation? Point me at the relevant source in node_modules/vendor.', tools: [{ tool: 'grep_search', args: { query: 'class Option' }, status: 'completed' }] }],
    },
    {
      // tokenCount recorded as zero: Cursor did not record usage, so this stays unpriced.
      version: 2,
      model: 'claude-4.5-sonnet',
      project: 'recipe-web',
      tokens: 'zero',
      turns: [{ prompt: 'Rename reducer across the repo and update imports.', tools: [edit('src/hooks/useRecipes.ts')] }],
    },
  ];
  const versions: SchemaVersion[] = [1, 1, 1, 2, 2, 3];
  const random = shuffled(versions, r).map((version): ComposerScript => {
    const turns = Array.from({ length: 1 + Math.floor(r() * 3) }, (): TurnScript => ({
      prompt: pick(r, TEMPLATES)(r),
      tools: Array.from({ length: Math.floor(r() * 4) }, () => randomTool(r)),
    }));
    return {
      version,
      model: pick(r, ['claude-4.5-sonnet', 'gpt-5', 'auto'] as const),
      project: pick(r, PROJECTS),
      tokens: pick(r, ['present', 'present', 'zero', 'missing'] as const),
      turns,
    };
  });
  return [...seeded, ...random];
}

function uuid(r: Random): string {
  const hex = Array.from({ length: 32 }, () => Math.floor(r() * 16).toString(16)).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

type Row = { key: string; value: string };

// `followUps` is a separate random stream for the replies after failed tool calls, so adding
// them does not shift the ids of every later bubble (the evaluation sheet refers to those ids).
function composerRows(script: ComposerScript, r: Random, followUps: Random, clock: { ms: number }): { composerId: string; rows: Row[] } {
  const composerId = uuid(r);
  const rows: Row[] = [];
  const headers: Array<{ bubbleId: string; type: 1 | 2 }> = [];
  const createdAt = clock.ms;

  const bubble = (type: 1 | 2, fields: Record<string, unknown>, rng: Random = r): void => {
    const bubbleId = uuid(rng);
    clock.ms += 1000 + Math.floor(rng() * 20_000);
    const base: Record<string, unknown> = { _v: script.version, type, bubbleId };
    if (script.version >= 2) base['createdAt'] = new Date(clock.ms).toISOString();
    rows.push({ key: `bubbleId:${composerId}:${bubbleId}`, value: JSON.stringify({ ...base, ...fields }) });
    headers.push({ bubbleId, type });
  };

  const tokenCount = (): Record<string, unknown> => {
    switch (script.tokens) {
      case 'present':
        return { tokenCount: { inputTokens: 2_000 + Math.floor(r() * 30_000), outputTokens: 100 + Math.floor(r() * 2_000) } };
      case 'zero':
        return { tokenCount: { inputTokens: 0, outputTokens: 0 } };
      case 'missing':
        return {};
      default:
        return assertNever(script.tokens);
    }
  };

  for (const turn of script.turns) {
    bubble(1, { text: turn.prompt, ...(script.version >= 2 ? { richText: '' } : {}) });
    bubble(2, {
      text: pick(r, ["I'll take a look.", 'Here is the change.', 'Running the tests now.']),
      ...(script.version >= 3 ? { modelInfo: { modelName: script.model } } : {}),
      ...(script.version >= 2 ? tokenCount() : {}),
    });
    for (const step of turn.tools) {
      bubble(2, {
        text: '',
        toolFormerData: {
          tool: ['run_terminal_cmd', 'edit_file', 'read_file', 'grep_search'].indexOf(step.tool) + 1,
          toolCallId: `toolu_${uuid(r).replaceAll('-', '').slice(0, 24)}`,
          name: step.tool,
          status: step.status,
          rawArgs: JSON.stringify(step.args),
          result: JSON.stringify(step.status === 'error' ? { error: 'Command failed with exit code 1' } : { output: 'ok' }),
        },
      });
      // Cursor answers a failed tool call before the next attempt; that reply is paid for.
      if (step.status === 'error' && script.tokens === 'present' && script.version >= 2) {
        bubble(
          2,
          {
            text: 'That failed. Trying another fix.',
            ...(script.version >= 3 ? { modelInfo: { modelName: script.model } } : {}),
            tokenCount: { inputTokens: 2_000 + Math.floor(followUps() * 30_000), outputTokens: 100 + Math.floor(followUps() * 2_000) },
          },
          followUps,
        );
      }
    }
  }

  const composer: Record<string, unknown> = {
    _v: script.version,
    composerId,
    createdAt,
    lastUpdatedAt: clock.ms,
    fullConversationHeadersOnly: headers,
  };
  if (script.version >= 2) composer['modelConfig'] = { modelName: script.model };
  if (script.version >= 3) composer['workspaceFolder'] = `/home/dev/projects/${script.project}`;
  rows.push({ key: `composerData:${composerId}`, value: JSON.stringify(composer) });
  return { composerId, rows };
}

/** Writes the fixture to `dbPath`, replacing any existing file. Same seed → same bytes. */
export function generateCursorFixture(dbPath: string, seed: number = FIXTURE_SEED): { composers: number; rows: number } {
  rmSync(dbPath, { force: true });
  const r = seededRandom(seed);
  const clock = { ms: Date.UTC(2026, 8, 1, 9, 0, 0) };
  const rows: Row[] = [{ key: SYNTHETIC_MARKER_KEY, value: JSON.stringify({ synthetic: true, generator: 'tools/gen-cursor-fixture', seed }) }];

  const followUps = seededRandom(seed ^ 0x5eed);
  const composers = scripts(r).map((s) => composerRows(s, r, followUps, clock));

  // Malformed: truncate one assistant bubble's JSON in the last composer.
  const victim = composers.at(-1)?.rows.find((row) => row.key.startsWith('bubbleId:') && row.value.includes('"type":2'));
  if (victim === undefined) throw new Error('no bubble to make malformed');
  victim.value = victim.value.slice(0, Math.floor(victim.value.length / 2));

  for (const c of composers) rows.push(...c.rows);

  // Recognized key families the analysis does not use, and one family it does not know.
  const first = composers[0];
  if (first === undefined) throw new Error('no composers');
  rows.push(
    { key: `checkpointId:${first.composerId}:${uuid(r)}`, value: JSON.stringify({ files: [], nonExistentFiles: [] }) },
    { key: `messageRequestContext:${first.composerId}:${uuid(r)}`, value: JSON.stringify({ terminalFiles: [], cursorRules: [] }) },
    { key: `codeBlockDiff:${first.composerId}:${uuid(r)}`, value: JSON.stringify({ newModelDiffWrtV0: [] }) },
    { key: `featureFlagCache:${uuid(r)}`, value: JSON.stringify({ flags: {} }) },
  );

  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
      CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
    `);
    const item = db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)');
    item.run('workbench.panel.composerChatViewPane', JSON.stringify({ synthetic: true }));
    const insert = db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)');
    db.exec('BEGIN');
    for (const row of rows) insert.run(row.key, row.value);
    db.exec('COMMIT');
  } finally {
    db.close();
  }
  return { composers: composers.length, rows: rows.length };
}
