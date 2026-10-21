// Aggregates session analyses into the report. Two denominators are kept apart:
// records (unparsed / total) and turns or sessions (unclassified / total).
import type { CorrectionStreak, FailureStreak, ModelUsage, SessionAnalysis } from './analyze.ts';
import { CATEGORIES, type Category } from './classify/rules.ts';
import { DISPOSITIONS, type Disposition, type SourceKind } from './model.ts';
import { addTokenTotals } from './pricing/pricing.ts';
import { addSpend, EMPTY_SPEND, sumSpend, type Spend } from './spend.ts';
import type { NanoUsd } from './units.ts';

export type FileError = { readonly file: string; readonly message: string };

export type SourceCoverage = {
  readonly source: SourceKind;
  /** false when the source path is empty in the env (deliberately off). */
  readonly enabled: boolean;
  /** The source declared itself a generated fixture, not real logs. */
  readonly synthetic: boolean;
  readonly records: Readonly<Record<Disposition, number>>;
  /** Blank lines are not records; counted separately. */
  readonly blankLines: number;
  /** Files or databases that could not be read on the latest ingest. */
  readonly errors: readonly FileError[];
};

export type CategoryRow = {
  readonly category: Category;
  /** Sessions whose primary category this is. Sums to the session total. */
  readonly sessions: number;
  /** Sessions with at least one turn in this category. A session can count in several. */
  readonly sessionsTouching: number;
  readonly turns: number;
  readonly spend: Spend;
};

export type ModelRow = ModelUsage & { readonly source: SourceKind; readonly sessions: number };

export type RankedFailureStreak = FailureStreak & SessionRef;
export type RankedCorrectionStreak = CorrectionStreak & SessionRef;
type SessionRef = {
  readonly source: SourceKind;
  readonly sessionId: string;
  readonly project: string | null;
  readonly sessionSpend: NanoUsd;
};

export type Report = {
  readonly versions: { readonly classifier: string; readonly pricing: string };
  readonly totals: {
    readonly spend: Spend;
    readonly sessions: number;
    readonly turns: number;
    readonly records: number;
    /** malformed + unknown records. */
    readonly unparsedRecords: number;
  };
  readonly categories: readonly CategoryRow[];
  readonly categoriesBySource: Readonly<Record<SourceKind, readonly CategoryRow[]>>;
  readonly models: readonly ModelRow[];
  readonly coverage: {
    readonly sources: readonly SourceCoverage[];
    readonly turns: { readonly unclassified: number; readonly total: number };
    readonly sessions: { readonly unclassified: number; readonly total: number };
  };
  readonly waste: {
    readonly failureStreaks: readonly RankedFailureStreak[];
    readonly correctionStreaks: readonly RankedCorrectionStreak[];
  };
};

function categoryRows(sessions: readonly SessionAnalysis[]): CategoryRow[] {
  return CATEGORIES.map((category) => {
    let turns = 0;
    let spend = EMPTY_SPEND;
    let touching = 0;
    for (const s of sessions) {
      const inCategory = s.turns.filter((t) => t.category === category);
      if (inCategory.length > 0) touching++;
      turns += inCategory.length;
      spend = addSpend(spend, sumSpend(inCategory.map((t) => t.spend)));
    }
    return {
      category,
      sessions: sessions.filter((s) => s.primaryCategory === category).length,
      sessionsTouching: touching,
      turns,
      spend,
    };
  });
}

function modelRows(sessions: readonly SessionAnalysis[]): ModelRow[] {
  const rows = new Map<string, ModelRow>();
  for (const s of sessions) {
    for (const m of s.models) {
      const key = `${s.source}\u0000${m.model ?? ''}`;
      const row = rows.get(key);
      rows.set(
        key,
        row === undefined
          ? { ...m, source: s.source, sessions: 1 }
          : { ...row, spend: addSpend(row.spend, m.spend), tokens: addTokenTotals(row.tokens, m.tokens), sessions: row.sessions + 1 },
      );
    }
  }
  return [...rows.values()].sort((a, b) => b.spend.total - a.spend.total || b.spend.calls.unpriced - a.spend.calls.unpriced);
}

export function buildReport(input: {
  readonly sessions: readonly SessionAnalysis[];
  readonly coverage: readonly SourceCoverage[];
  readonly versions: { readonly classifier: string; readonly pricing: string };
}): Report {
  const { sessions } = input;
  const ref = (s: SessionAnalysis): SessionRef => ({
    source: s.source,
    sessionId: s.sessionId,
    project: s.project,
    sessionSpend: s.spend.total,
  });
  const allTurns = sessions.flatMap((s) => s.turns);
  const records = input.coverage.reduce((n, c) => n + DISPOSITIONS.reduce((m, d) => m + c.records[d], 0), 0);
  const unparsed = input.coverage.reduce((n, c) => n + c.records.malformed + c.records.unknown, 0);
  const bySource = (source: SourceKind): CategoryRow[] => categoryRows(sessions.filter((s) => s.source === source));

  return {
    versions: input.versions,
    totals: {
      spend: sumSpend(sessions.map((s) => s.spend)),
      sessions: sessions.length,
      turns: allTurns.length,
      records,
      unparsedRecords: unparsed,
    },
    categories: categoryRows(sessions),
    categoriesBySource: { claude: bySource('claude'), codex: bySource('codex'), cursor: bySource('cursor') },
    models: modelRows(sessions),
    coverage: {
      sources: input.coverage,
      turns: { unclassified: allTurns.filter((t) => t.category === 'unknown').length, total: allTurns.length },
      sessions: { unclassified: sessions.filter((s) => s.primaryCategory === 'unknown').length, total: sessions.length },
    },
    waste: {
      failureStreaks: sessions
        .flatMap((s) => s.failureStreaks.map((f) => ({ ...f, ...ref(s) })))
        .sort((a, b) => b.length - a.length || b.costDuringStreak - a.costDuringStreak),
      correctionStreaks: sessions
        .flatMap((s) => s.correctionStreaks.map((c) => ({ ...c, ...ref(s) })))
        .sort((a, b) => b.length - a.length || b.costDuringStreak - a.costDuringStreak),
    },
  };
}
