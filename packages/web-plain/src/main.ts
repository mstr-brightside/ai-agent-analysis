import type {
  Category,
  CategoryRow,
  CorrectionStreak,
  FailureStreak,
  ReconciliationMismatch,
  Ratio,
  ReconciliationResponse,
  SnapshotsResponse,
  Source,
  SourceCoverage,
  SourceRef,
  SummaryResponse,
} from '@agentspend/contract';
import { api } from './api.ts';
import { legend, stackedBars, type Series } from './charts.ts';
import { assertNever, byId, h, type Child } from './dom.ts';
import { compact, count, dateTime, percent, share, shortId, usd } from './format.ts';

type SourceFilter = 'all' | Source;
const state: { snapshot: number | null; source: SourceFilter } = { snapshot: null, source: 'all' };
let pageController: AbortController | null = null;

const CATEGORY_LABEL: Readonly<Record<Category, string>> = {
  plan: 'Plan',
  research: 'Research',
  implement: 'Implement',
  debug: 'Debug',
  test: 'Test',
  refactor: 'Refactor',
  review: 'Review',
  ops: 'Ops',
  unknown: 'Unclassified',
};

function sourceLabel(source: Source, synthetic = false): string {
  switch (source) {
    case 'claude':
      return 'Claude Code';
    case 'codex':
      return 'Codex';
    case 'cursor':
      return synthetic ? 'Cursor (synthetic)' : 'Cursor';
    default:
      return assertNever(source);
  }
}

function ref(r: SourceRef): string {
  switch (r.kind) {
    case 'line':
      return `${r.file}:${r.line}`;
    case 'key':
      return r.key.split(':').map(shortId).join(':');
    default:
      return assertNever(r);
  }
}

type PricedStatus = keyof CategoryRow['spend']['byStatusUsd'];
const STATUS_SERIES = [
  { key: 'complete', label: 'Complete', color: 'var(--series-1)' },
  { key: 'complete-no-cache-data', label: 'Lower bound (no cache data)', color: 'var(--series-2)' },
  { key: 'estimated', label: 'Estimated (inconsistent usage)', color: 'var(--series-3)' },
] as const satisfies readonly (Series & { readonly key: PricedStatus })[];
const SPEND_SERIES: readonly Series[] = [{ key: 'spend', label: 'Estimated spend', color: 'var(--series-1)' }];

/** Content width of a section, capped so bars stay readable on wide screens. */
function chartWidth(): number {
  const main = document.getElementById('main');
  const inner = (main?.clientWidth ?? 640) - 32 - (window.innerWidth < 560 ? 34 : 42);
  return Math.min(720, inner);
}

function section(id: string, title: string, intro: Child, ...body: Child[]): HTMLElement {
  return h('section', { id, 'aria-labelledby': `${id}-title` }, h('h2', { id: `${id}-title` }, title), intro === null ? null : h('p', { class: 'intro' }, intro), ...body);
}

function table(head: readonly string[], rows: ReadonlyArray<readonly Child[]>, numeric: ReadonlySet<number> = new Set()): HTMLElement {
  return h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      {},
      h('thead', {}, h('tr', {}, ...head.map((c, i) => h('th', { class: numeric.has(i) ? 'num' : undefined, scope: 'col' }, c)))),
      h('tbody', {}, ...rows.map((r) => h('tr', {}, ...r.map((c, i) => h('td', { class: numeric.has(i) ? 'num' : undefined }, c))))),
    ),
  );
}

function tableView(label: string, content: HTMLElement): HTMLElement {
  return h('details', { class: 'table-view' }, h('summary', {}, label), content);
}

// --- 2. Headline numbers -------------------------------------------------------

function headline(s: SummaryResponse): HTMLElement {
  const tile = (label: string, value: string, note: string, hero = false): HTMLElement =>
    h('div', { class: hero ? 'tile hero' : 'tile' }, h('div', { class: 'tile-label' }, label), h('div', { class: 'tile-value' }, value), h('div', { class: 'tile-note' }, note));

  const { unparsedRecords } = s.headline;

  return h(
    'section',
    { id: 'headline', 'aria-label': 'Headline numbers' },
    h(
      'div',
      { class: 'tiles' },
      tile('Estimated spend', usd(s.headline.spendUsd), 'at public API list prices', true),
      tile('Sessions', count(s.headline.sessions), `${count(s.headline.turns)} turns`),
      tile('Spend fully priced', share(s.headline.fullyPricedShare), 'the rest is a lower bound or estimated'),
      tile('Records not parsed', percent(unparsedRecords.part, unparsedRecords.total), `${count(unparsedRecords.part)} of ${count(unparsedRecords.total)} records`),
    ),
  );
}

// --- 3. What sessions are used for -------------------------------------------------

function sourceFilter(s: SummaryResponse, onChange: () => void): HTMLElement {
  const options: ReadonlyArray<readonly [SourceFilter, string]> = [
    ['all', 'All sources'],
    ...s.coverage.sources.filter((source) => source.enabled).map(({ source, synthetic }) => [source, sourceLabel(source, synthetic)] as const),
  ];

  return h(
    'div',
    { class: 'filters', role: 'group', 'aria-label': 'Filter by source' },
    ...options.map(([value, label]) => {
      const button = h('button', { type: 'button', class: 'chip', 'aria-pressed': state.source === value ? 'true' : 'false' }, label);
      button.addEventListener('click', () => {
        state.source = value;
        onChange();
      });
      return button;
    }),
  );
}

function categoryRows(s: SummaryResponse): CategoryRow[] {
  const rows = state.source === 'all' ? s.categories : s.categoriesBySource[state.source];
  return [...rows]
    .filter((r) => r.turns > 0)
    .sort((a, b) => {
      const aUnknown = a.category === 'unknown';
      const bUnknown = b.category === 'unknown';
      if (aUnknown && !bUnknown) return 1;
      if (!aUnknown && bUnknown) return -1;
      return b.spend.totalUsd - a.spend.totalUsd;
    });
}

function classifierTrust(check: SummaryResponse['classifier']): HTMLElement[] {
  if (check === null) {
    return [h('h3', {}, 'How far to trust these categories'), h('p', { class: 'muted' }, 'Not measured for this snapshot: it was stored before this check existed.')];
  }
  const agreement = (r: Ratio | null, missing: string): Child =>
    r === null ? h('span', { class: 'muted' }, missing) : h('strong', {}, `${count(r.part)} of ${count(r.total)} agree (${percent(r.part, r.total)})`);
  const by = check.turnsClassifiedBy;
  const turns = by.promptRule + by.toolShape + by.unclassified;
  return [
    h('h3', {}, 'How far to trust these categories'),
    h(
      'ul',
      { class: 'facts' },
      h('li', {}, 'Held-out test prompts: ', agreement(check.heldout, 'not measured (eval/heldout.csv missing or invalid)'), '. Realistic wording the rules were never tuned on. This is the honest estimate, but it is not measured on your data.'),
      h('li', {}, 'Labelled sample of the fixtures: ', agreement(check.labelledSample, 'not available (the labelled turns are not in this data)'), '. Inflated: the rules were written for these prompts.'),
      h(
        'li',
        {},
        `Your ${count(turns)} turns (all sources): `,
        h('strong', {}, `${percent(by.promptRule, turns)} by a prompt rule`),
        `, ${percent(by.toolShape, turns)} guessed from the tools used, ${percent(by.unclassified, turns)} unclassified.`,
      ),
    ),
  ];
}

function usage(s: SummaryResponse): HTMLElement {
  const rows = categoryRows(s);
  const sessions = rows.reduce((n, r) => n + r.sessions, 0);
  const spend = rows.reduce((n, r) => n + r.spend.totalUsd, 0);
  const chart = stackedBars(
    rows.map((r) => ({
      label: CATEGORY_LABEL[r.category],
      values: { spend: r.spend.totalUsd },
      endLabel: `${usd(r.spend.totalUsd)} · ${r.turns} turns`,
      shortEndLabel: usd(r.spend.totalUsd),
      tooltip: [CATEGORY_LABEL[r.category], `${usd(r.spend.totalUsd)} (${percent(r.spend.totalUsd, spend)} of spend)`, `${r.turns} turns`, `${r.sessions} sessions (primary) · ${r.sessionsTouching} touching`],
    })),
    SPEND_SERIES,
    'Estimated spend per category',
    chartWidth(),
  );
  return section(
    'usage',
    'What sessions are used for',
    `Each turn (a request plus the work on it) is classified; a session counts once, under the category it spent most on. "Touching" counts a session in every category it has a turn in. Session counts add up to ${count(sessions)}.`,
    h('h3', {}, 'Estimated spend and turns per category'),
    chart,
    tableView(
      'Table view',
      table(
        ['Category', 'Sessions (primary)', 'Sessions touching', 'Turns', 'Estimated spend', 'Share of spend'],
        rows.map((r) => [CATEGORY_LABEL[r.category], count(r.sessions), count(r.sessionsTouching), count(r.turns), usd(r.spend.totalUsd), percent(r.spend.totalUsd, spend)]),
        new Set([1, 2, 3, 4, 5]),
      ),
    ),
    ...classifierTrust(s.classifier),
  );
}

// --- 4. Where the money goes -------------------------------------------------------

function money(s: SummaryResponse): HTMLElement {
  const rows = categoryRows(s);
  const chart = stackedBars(
    rows.map((r) => ({
      label: CATEGORY_LABEL[r.category],
      values: { ...r.spend.byStatusUsd },
      endLabel: r.spend.calls.unpriced > 0 ? `${usd(r.spend.totalUsd)} + ${r.spend.calls.unpriced} unpriced` : usd(r.spend.totalUsd),
      shortEndLabel: usd(r.spend.totalUsd),
      tooltip: [
        CATEGORY_LABEL[r.category],
        ...STATUS_SERIES.map((x) => `${x.label}: ${usd(r.spend.byStatusUsd[x.key])}`),
        `Unpriced: ${r.spend.calls.unpriced} calls, ${compact(r.spend.unpricedTokens)} tokens`,
      ],
    })),
    STATUS_SERIES,
    'Estimated spend per category, split by pricing status',
    chartWidth(),
  );
  const models = s.models.filter((m) => state.source === 'all' || m.source === state.source);
  return section(
    'money',
    'Where the money goes',
    'Every call is priced at public API list prices. Amounts are kept apart by how sure the price is: complete, a lower bound (the log has no cache fields), or estimated (the log’s numbers contradict each other). Calls with an unknown model or no usage stay unpriced; their tokens are counted, not guessed.',
    h('h3', {}, 'Spend per category by pricing status'),
    legend(STATUS_SERIES),
    chart,
    h('h3', {}, 'Per model'),
    table(
      ['Source', 'Model as logged', 'Priced as', 'Sessions', 'Calls priced', 'Calls unpriced', 'Estimated spend', 'Unpriced tokens'],
      models.map((m) => [
        sourceLabel(m.source),
        h('code', {}, m.model ?? '(none recorded)'),
        m.displayName ?? h('span', { class: 'muted' }, 'not on a price page'),
        count(m.sessions),
        count(m.spend.calls.complete + m.spend.calls['complete-no-cache-data'] + m.spend.calls.estimated),
        count(m.spend.calls.unpriced),
        usd(m.spend.totalUsd),
        compact(m.spend.unpricedTokens),
      ]),
      new Set([3, 4, 5, 6, 7]),
    ),
  );
}

// --- 5. Coverage -------------------------------------------------------------------
function coverage(s: SummaryResponse): HTMLElement {
  const row = (c: SourceCoverage): Child[] => [
    h('span', {}, sourceLabel(c.source, c.synthetic), c.enabled ? null : h('span', { class: 'muted' }, ' (off)')),
    count(c.records.processed),
    count(c.records['recognized-unused']),
    count(c.records.duplicate),
    count(c.records.malformed),
    count(c.records.unknown),
    count(c.blankLines),
    c.errors.length === 0 ? '–' : c.errors.map((e) => `${e.file}: ${e.message}`).join('; '),
  ];
  const t = s.coverage.unclassifiedTurns;
  const se = s.coverage.unclassifiedSessions;
  return section(
    'coverage',
    'Coverage',
    'Every record read gets a disposition; nothing is dropped silently. Records and turns are different measurements, so they have separate denominators.',
    h('h3', {}, 'Records by disposition'),
    table(['Source', 'Processed', 'Recognized, unused', 'Duplicate', 'Malformed', 'Unknown', 'Blank lines', 'Read errors'], s.coverage.sources.map(row), new Set([1, 2, 3, 4, 5, 6])),
    h(
      'ul',
      { class: 'facts' },
      h('li', {}, h('strong', {}, `${count(t.part)} of ${count(t.total)} turns`), ` unclassified (${percent(t.part, t.total)})`),
      h('li', {}, h('strong', {}, `${count(se.part)} of ${count(se.total)} sessions`), ` with no classified turn (${percent(se.part, se.total)})`),
    ),
  );
}

// --- 6. Suspected waste --------------------------------------------------------------
function outcomeChip(outcome: 'success' | 'failure' | 'unknown'): HTMLElement {
  switch (outcome) {
    case 'failure':
      return h('span', { class: 'chip-outcome fail', title: 'failed' }, '✗ failed');
    case 'unknown':
      return h('span', { class: 'chip-outcome unknown', title: 'no outcome recorded' }, '? unknown');
    case 'success':
      return h('span', { class: 'chip-outcome ok', title: 'succeeded' }, '✓ ok');
    default:
      return assertNever(outcome);
  }
}

function sessionLine(x: FailureStreak | CorrectionStreak): Child {
  return h('span', { class: 'muted' }, `${sourceLabel(x.source)} · ${x.project ?? 'unknown project'} · session ${shortId(x.sessionId)} · turn ${x.turnIndexes.join(', ')}`);
}

function waste(s: SummaryResponse): HTMLElement {
  const failures = s.waste.failureStreaks;
  const corrections = s.waste.correctionStreaks;
  return section(
    'waste',
    'Suspected waste',
    'Two separate signals, never merged into a score. Repeated failure or correction suggests an agent going in circles; it does not prove the money was wasted.',
    h('h3', {}, `Failure streaks (${failures.length})`),
    h('p', { class: 'note' }, '3 or more failures in a row of the same tool on the same target; other tool calls may happen in between. Calls with no recorded outcome neither extend nor break a streak.'),
    failures.length === 0
      ? h('p', { class: 'empty' }, 'None found.')
      : h(
          'div',
          { class: 'streaks' },
          ...failures.map((f) =>
            h(
              'details',
              {},
              h(
                'summary',
                {},
                h('strong', {}, `${f.length} failures`),
                ' of ',
                h('code', {}, f.tool),
                ' on ',
                h('code', {}, f.target),
                ' — ',
                `${usd(f.costDuringStreakUsd)} during the streak, of ${usd(f.sessionSpendUsd)} for the session`,
              ),
              h('div', { class: 'evidence' }, sessionLine(f), h('ol', { class: 'attempts' }, ...f.attempts.map((a) => h('li', {}, outcomeChip(a.outcome), ' ', h('code', {}, ref(a.callRef)))))),
            ),
          ),
        ),
    h('h3', {}, `Correction streaks (${corrections.length})`),
    h('p', { class: 'note' }, '2 or more corrections in a row from the developer ("Wrong file", "Still failing", "Undo"). An approval or a new request ends the streak.'),
    corrections.length === 0
      ? h('p', { class: 'empty' }, 'None found.')
      : h(
          'div',
          { class: 'streaks' },
          ...corrections.map((c) =>
            h(
              'details',
              {},
              h('summary', {}, h('strong', {}, `${c.length} corrections in a row`), ' — ', `${usd(c.costDuringStreakUsd)} during the streak, of ${usd(c.sessionSpendUsd)} for the session`),
              h('div', { class: 'evidence' }, sessionLine(c), h('p', { class: 'muted' }, 'Prompts (location only; prompt text never leaves the machine):'), h('ol', { class: 'attempts' }, ...c.prompts.map((p) => h('li', {}, h('code', {}, ref(p)))))),
            ),
          ),
        ),
  );
}

// --- 7. Pricing reconciliation -----------------------------------------------------------

const REASON: Readonly<Record<ReconciliationMismatch['reason'], string>> = {
  'cost-differs': 'Same model and tokens, different price',
  'tokens-differ': 'Token counts differ (pairing by position failed)',
  'model-differs': 'Model differs',
  'no-usage-in-log': 'The log has no usage for this request',
  unpriced: 'Model not on a price page',
};

function reconciliation(r: ReconciliationResponse): HTMLElement {
  if (r.status === 'off') {
    return section('reconciliation', 'Pricing reconciliation', `Off: ${r.reason}.`);
  }
  const groups = new Map<string, ReconciliationMismatch[]>();
  for (const m of r.mismatches) {
    const k = `${m.reason}\u0000${m.otel.model ?? ''}`;
    groups.set(k, [...(groups.get(k) ?? []), m]);
  }
  const sum = (ms: readonly ReconciliationMismatch[], side: 'otel' | 'log'): string => {
    const known = ms.map((m) => m[side].costUsd).filter((v) => v !== null);
    return known.length === 0 ? '–' : usd(known.reduce((a, b) => a + b, 0));
  };
  return section(
    'reconciliation',
    'Pricing reconciliation',
    'Claude Code’s OTel events carry their own cost. They describe the same requests as the logs, so they are never added to spend; they cross-check our prices. Model and tokens must agree before costs are compared.',
    h(
      'div',
      { class: 'tiles' },
      h('div', { class: 'tile' }, h('div', { class: 'tile-label' }, 'Requests matching within $0.000001'), h('div', { class: 'tile-value' }, `${count(r.matched)} of ${count(r.otelRequests)}`), h('div', { class: 'tile-note' }, `unmatched: ${r.unmatchedOtel.length} OTel, ${r.unmatchedLog.length} log`)),
      h('div', { class: 'tile' }, h('div', { class: 'tile-label' }, 'Largest difference among compared'), h('div', { class: 'tile-value' }, usd(r.maxDifferenceUsd)), h('div', { class: 'tile-note' }, `${count(r.mismatches.length)} mismatches below`)),
    ),
    r.mismatches.length === 0
      ? null
      : table(
          ['Why', 'Model', 'Requests', 'OTel cost', 'Our cost'],
          [...groups.values()].map((ms) => {
            const first = ms[0];
            return [first === undefined ? '' : REASON[first.reason], h('code', {}, first?.otel.model ?? '–'), count(ms.length), sum(ms, 'otel'), sum(ms, 'log')];
          }),
          new Set([2, 3, 4]),
        ),
    r.mismatches.length === 0
      ? null
      : tableView(
          `All ${r.mismatches.length} mismatches`,
          table(
            ['Session', '#', 'Why', 'OTel tokens (in / cache read / cache write / out)', 'Log tokens', 'OTel cost', 'Our cost'],
            r.mismatches.map((m) => {
              const t = (x: ReconciliationMismatch['otel']): string => (x.tokens === null ? '–' : `${x.tokens.freshInput} / ${x.tokens.cacheRead} / ${x.tokens.cacheWrite} / ${x.tokens.output}`);
              return [shortId(m.sessionId), m.ordinal, REASON[m.reason], t(m.otel), t(m.log), m.otel.costUsd === null ? '–' : usd(m.otel.costUsd), m.log.costUsd === null ? '–' : usd(m.log.costUsd)];
            }),
            new Set([1, 5, 6]),
          ),
        ),
  );
}

// --- page ------------------------------------------------------------------------------------

function header(snapshots: SnapshotsResponse, summary: SummaryResponse, reload: () => void): void {
  const picker = byId('snapshot', HTMLSelectElement);
  picker.replaceChildren(
    ...snapshots.snapshots.map((x, i) =>
      h('option', { value: x.id, selected: x.id === summary.snapshot.id }, `#${x.id} · ${dateTime(x.createdAt)} · ${usd(x.spendUsd)}${i === 0 ? ' (latest)' : ''}`),
    ),
  );
  picker.onchange = () => {
    const id = Number(picker.value);
    state.snapshot = snapshots.snapshots[0]?.id === id ? null : id;
    reload();
  };
  const partial = summary.snapshot.partial ? ' · partial: some sources could not be read' : '';
  byId('analysed', HTMLElement).textContent = `Analysed ${dateTime(summary.snapshot.createdAt)}${partial}`;
}

async function load(): Promise<void> {
  // Remove the previous page's listeners and disregard its pending responses.
  pageController?.abort();
  const controller = new AbortController();
  pageController = controller;

  // 'main' in index.html
  const main = byId('main', HTMLElement);

  try {
    const [snapshots, summary, recon] = await Promise.all([api.snapshots(), api.summary(state.snapshot), api.reconciliation(state.snapshot)]);
    if (controller.signal.aborted) return;

    const render = (): void => {
      main.replaceChildren(
        headline(summary),
        sourceFilter(summary, render),
        usage(summary),
        money(summary),
        coverage(summary),
        waste(summary),
        reconciliation(recon),
      );
    };

    header(snapshots, summary, () => void load());

    render();

    let lastWidth = chartWidth();

    window.addEventListener('resize', () => {
      const w = chartWidth();

      if (Math.abs(w - lastWidth) < 8) {
        return;
      }

      lastWidth = w;
      render();
    }, { signal: controller.signal });
  } catch (e) {
    if (controller.signal.aborted) return;
    main.replaceChildren(h('p', { class: 'error', role: 'alert' }, e instanceof Error ? e.message : String(e)));
  }
}

function refreshButton(): void {
  const button = byId('refresh', HTMLButtonElement);
  const status = byId('refresh-status', HTMLElement);
  button.addEventListener('click', () => {
    button.disabled = true;
    status.textContent = 'Reading new data…';
    api
      .ingest()
      .then((r) => {
        const ms = `${r.durationMs.toFixed(0)} ms`;
        if (r.status === 'changed') {
          status.textContent = `Snapshot #${r.snapshot.id}: ${count(r.snapshot.changes.newRecords)} new records (${ms})`;
        } else {
          const partial = r.partial ? ' · some sources could not be read' : '';
          status.textContent = `No changes (${ms})${partial}`;
        }
        state.snapshot = null;
        return load();
      })
      .catch((e: unknown) => {
        status.textContent = e instanceof Error ? e.message : String(e);
      })
      .finally(() => {
        button.disabled = false;
      });
  });
}

refreshButton();
await load();
