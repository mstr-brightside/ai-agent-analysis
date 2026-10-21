import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CATEGORIES, classifyPrompt, refLabel, type Category } from '@agentspend/core';
import { ingest } from '@agentspend/server-node';
import { readCsv } from '@agentspend/sources';
import { Store } from '@agentspend/store';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const DATASET = path.join(ROOT, 'fixtures/session-logs-dataset');

// *********
// * UTILS *
// *********
function rowsOf(file: string): string[][] {
  return readCsv(readFileSync(path.join(ROOT, file), 'utf8'))
    .slice(1)
    .filter((row) => (row[0] ?? '') !== '');
}

function isCategory(value: string): value is Category {
  const CATEGORY_NAMES: readonly string[] = CATEGORIES;
  return CATEGORY_NAMES.includes(value);
}

function category(value: string, where: string): Category {
  if (!isCategory(value)) {
    throw new Error(`${where}: "${value}" is not a category`);
  }
  return value;
}

// *********
// * TYPES *
// *********
type Scored = {
  readonly id: string;
  readonly prompt: string;
  readonly label: Category;
  readonly predicted: Category;
  readonly ruleId: string;
  readonly matched: readonly string[];
};

// *******************
// * FUN STARTS HERE *
// *******************
// --- 1. Fixture turns analysis ---------------------------------------
const tempDir = mkdtempSync(path.join(tmpdir(), 'agentspend-eval-'));

const sheetRows = rowsOf('eval/sheet.csv').map((row): [string, string] => [row[0] ?? '', row[1] ?? '']);
const prompts = new Map(sheetRows);

const store = Store.open(tempDir);

const predictions = new Map<string, { category: Category; ruleId: string; matched: readonly string[] }>();

try {
  ingest(
    store,
    {
      claudeLogsDir: path.join(DATASET, 'claude-code/projects'),
      codexLogsDir: path.join(DATASET, 'codex/sessions'),
      cursorDbPath: path.join(ROOT, 'fixtures/cursor/state.vscdb'),
      otelEventsPath: null,
      evalDir: null,
    },
    'cli',
  );

  for (const session of store.loadAnalyses()) {
    for (const turn of session.turns) {
      if (turn.promptRef === null) continue;

      const id = `${session.source}:${refLabel(turn.promptRef)}`;
      predictions.set(id, {
        category: turn.category,
        ruleId: turn.ruleId,
        matched: turn.matchedRuleIds,
      });
    }
  }
} finally {
  store.close();
  rmSync(tempDir, { recursive: true, force: true });
}

const sampled: Scored[] = rowsOf('eval/labels.csv').map(([id = '', label = '']) => {
  const prediction = predictions.get(id);

  if (prediction === undefined) {
    throw new Error(`No turn opens at ${id}: the sheet and the pipeline disagree on turn boundaries.`);
  }

  return {
    id,
    prompt: prompts.get(id) ?? '',
    label: category(label, `eval/labels.csv ${id}`),
    predicted: prediction.category,
    ruleId: prediction.ruleId,
    matched: prediction.matched
  };
});

// --- 2. Held-out prompts, prompt only -------------------------------------------------------
const heldout: Scored[] = rowsOf('eval/heldout.csv').map(([id = '', prompt = '', label = '']) => {
  const c = classifyPrompt(prompt);
  return {
    id,
    prompt,
    label: category(label, `eval/heldout.csv ${id}`),
    predicted: c?.category ?? 'unknown',
    ruleId: c?.ruleId ?? 'none',
    matched: c?.matchedRuleIds ?? [],
  };
});

// --- scoring ---------------------------------------------------------------------------------

const code = (text: string): string => `\`${text}\``;
const cell = (text: string): string => text.replaceAll('|', String.raw`\|`);

/** Agreement, Cohen's kappa, confusion table and misclassifications, as Markdown lines. */
function score(scored: readonly Scored[]): string[] {
  const n = scored.length;
  const agree = scored.filter((r) => r.label === r.predicted).length;
  const po = agree / n;
  const share = (pick: (r: Scored) => Category, c: Category): number => scored.filter((r) => pick(r) === c).length / n;
  const pe = CATEGORIES.reduce((sum, c) => sum + share((r) => r.label, c) * share((r) => r.predicted, c), 0);
  const kappa = pe === 1 ? 1 : (po - pe) / (1 - pe);
  const used = CATEGORIES.filter((c) => scored.some((r) => r.label === c || r.predicted === c));
  const misses = scored.filter((r) => r.label !== r.predicted);
  const count = (l: Category, p: Category): string => String(scored.filter((r) => r.label === l && r.predicted === p).length || '·');
  return [
    `- Agreement: **${agree}/${n} = ${(po * 100).toFixed(1)}%**`,
    `- Cohen's kappa: **${kappa.toFixed(3)}** (chance agreement ${(pe * 100).toFixed(1)}%)`,
    '',
    `| label ↓ / predicted → | ${used.join(' | ')} |`,
    `|---|${used.map(() => '---:').join('|')}|`,
    ...used.map((l) => `| **${l}** | ${used.map((p) => count(l, p)).join(' | ')} |`),
    '',
    `Misclassifications (${misses.length}):`,
    '',
    ...(misses.length === 0
      ? ['None.']
      : [
          '| Id | Prompt | Label | Predicted | Rule that fired | Other matching rules |',
          '|---|---|---|---|---|---|',
          ...misses.map(
            (r) =>
              `| ${code(r.id)} | ${cell(r.prompt)} | ${r.label} | ${r.predicted} | ${code(r.ruleId)} | ${r.matched.filter((m) => m !== r.ruleId).map(code).join(', ') || '–'} |`,
          ),
        ]),
  ];
}

const bySource = ['claude', 'codex', 'cursor'].map((s) => {
  const subset = sampled.filter((r) => r.id.startsWith(`${s}:`));
  return `${s} ${subset.filter((r) => r.label === r.predicted).length}/${subset.length}`;
});

const report = [
  '# Classifier evaluation',
  '',
  'Generated by `npm run eval`. Two sets, to be read very differently:',
  '',
  '1. **Dataset sample (30 turns).** Sampled with a fixed seed from the inputs and labelled blind by a separate AI sub-agent from `eval/sheet.csv` and `eval/TAXONOMY.md` only, committed before any classifier rule existed. But the prompts are filled-in templates, and the rule author saw these labels before writing the rules (NOTES.md), so this mostly shows that the rules cover the templates.',
  '2. **Held-out prompts (40).** Written and labelled by another sub-agent in varied wording, never seen when the rules were written, committed before scoring, and not used to tune anything. Classified from the prompt alone (no tool use exists for them). This is the more honest estimate for real logs. It includes deliberately ambiguous requests and two non-English ones.',
  '',
  `## 1. Dataset sample: ${sampled.length} turns (${bySource.join(', ')})`,
  '',
  ...score(sampled),
  '',
  `## 2. Held-out prompts: ${heldout.length}`,
  '',
  ...score(heldout),
  '',
];
writeFileSync(path.join(ROOT, 'eval/results.md'), report.join('\n'));
process.stdout.write(`${report.join('\n')}\nWritten to eval/results.md\n`);
