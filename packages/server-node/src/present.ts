// Core → API contract. The only place where nano-USD becomes dollars, and where the
// report is shaped for the wire. Prompt text never reaches this layer: analyses hold refs.
import type {
  CategoryRow as ApiCategoryRow,
  ClassifierCheck,
  CorrectionStreak as ApiCorrectionStreak,
  FailureStreak as ApiFailureStreak,
  ReconciliationResponse,
  Session as ApiSession,
  SourceCoverage as ApiSourceCoverage,
  Spend as ApiSpend,
  SummaryResponse,
  Tokens as ApiTokens,
} from '@agentspend/contract';
import { PRICING_BASIS } from '@agentspend/contract';
import {
  nanoUsdToDollars,
  PRICE_TABLE,
  type CategoryRow,
  type ModelUsage,
  type NanoUsd,
  type Report,
  type SessionAnalysis,
  type SourceCoverage,
  type Spend,
  type TokenTotals,
} from '@agentspend/core';
import type { Reconciliation } from '@agentspend/sources';
import { TOLERANCE_NANO_USD } from '@agentspend/sources';

const usd = (n: NanoUsd): number => nanoUsdToDollars(n);

const DISPLAY_NAMES = new Map<string, string>(Object.entries(PRICE_TABLE).map(([key, entry]) => [key, entry.displayName]));

export function spend(s: Spend): ApiSpend {
  return {
    totalUsd: usd(s.total),
    byStatusUsd: {
      complete: usd(s.byStatus.complete),
      'complete-no-cache-data': usd(s.byStatus['complete-no-cache-data']),
      estimated: usd(s.byStatus.estimated),
    },
    calls: { ...s.calls },
    repeatedUsageCalls: s.repeatedUsageCalls,
    unpricedTokens: s.unpricedTokens,
  };
}

function tokens(t: TokenTotals): ApiTokens {
  return { freshInput: t.freshInput, cacheRead: t.cacheRead, cacheWrite: t.cacheWrite, output: t.output };
}

function categoryRow(r: CategoryRow): ApiCategoryRow {
  return { category: r.category, sessions: r.sessions, sessionsTouching: r.sessionsTouching, turns: r.turns, spend: spend(r.spend) };
}

function model(m: ModelUsage): { model: string | null; priceKey: string | null; displayName: string | null; spend: ApiSpend; tokens: ApiTokens } {
  return {
    model: m.model,
    priceKey: m.priceKey,
    displayName: m.priceKey === null ? null : (DISPLAY_NAMES.get(m.priceKey) ?? null),
    spend: spend(m.spend),
    tokens: tokens(m.tokens),
  };
}

function coverage(c: SourceCoverage): ApiSourceCoverage {
  return { source: c.source, enabled: c.enabled, synthetic: c.synthetic, records: { ...c.records }, blankLines: c.blankLines, errors: [...c.errors] };
}

type SessionKey = { source: ApiSession['source']; sessionId: string; project: string | null; sessionSpend: NanoUsd };
function key(s: SessionKey): Pick<ApiFailureStreak, 'source' | 'sessionId' | 'project' | 'sessionSpendUsd'> {
  return { source: s.source, sessionId: s.sessionId, project: s.project, sessionSpendUsd: usd(s.sessionSpend) };
}

function failureStreaks(a: SessionAnalysis): ApiFailureStreak[] {
  return a.failureStreaks.map((f) => ({
    ...key({ ...a, sessionSpend: a.spend.total }),
    tool: f.tool,
    target: f.target,
    length: f.length,
    attempts: f.attempts.map((x) => ({ ...x })),
    turnIndexes: [...f.turnIndexes],
    costDuringStreakUsd: usd(f.costDuringStreak),
  }));
}

function correctionStreaks(a: SessionAnalysis): ApiCorrectionStreak[] {
  return a.correctionStreaks.map((c) => ({
    ...key({ ...a, sessionSpend: a.spend.total }),
    length: c.length,
    prompts: [...c.prompts],
    turnIndexes: [...c.turnIndexes],
    costDuringStreakUsd: usd(c.costDuringStreak),
  }));
}

export type SummaryBody = Omit<SummaryResponse, 'snapshot'>;

export function summaryBody(report: Report, classifier: ClassifierCheck): SummaryBody {
  const total = report.totals.spend.total;
  return {
    pricingBasis: PRICING_BASIS,
    headline: {
      spendUsd: usd(total),
      sessions: report.totals.sessions,
      turns: report.totals.turns,
      fullyPricedShare: total === 0 ? null : report.totals.spend.byStatus.complete / total,
      unparsedRecords: { part: report.totals.unparsedRecords, total: report.totals.records },
    },
    spend: spend(report.totals.spend),
    categories: report.categories.map(categoryRow),
    categoriesBySource: {
      claude: report.categoriesBySource.claude.map(categoryRow),
      codex: report.categoriesBySource.codex.map(categoryRow),
      cursor: report.categoriesBySource.cursor.map(categoryRow),
    },
    models: report.models.map((m) => ({ ...model(m), source: m.source, sessions: m.sessions })),
    coverage: {
      sources: report.coverage.sources.map(coverage),
      unclassifiedTurns: { part: report.coverage.turns.unclassified, total: report.coverage.turns.total },
      unclassifiedSessions: { part: report.coverage.sessions.unclassified, total: report.coverage.sessions.total },
    },
    waste: {
      failureStreaks: report.waste.failureStreaks.map((f) => ({
        ...key(f),
        tool: f.tool,
        target: f.target,
        length: f.length,
        attempts: f.attempts.map((x) => ({ ...x })),
        turnIndexes: [...f.turnIndexes],
        costDuringStreakUsd: usd(f.costDuringStreak),
      })),
      correctionStreaks: report.waste.correctionStreaks.map((c) => ({
        ...key(c),
        length: c.length,
        prompts: [...c.prompts],
        turnIndexes: [...c.turnIndexes],
        costDuringStreakUsd: usd(c.costDuringStreak),
      })),
    },
    classifier,
  };
}

export function session(a: SessionAnalysis): ApiSession {
  return {
    source: a.source,
    sessionId: a.sessionId,
    project: a.project,
    agentVersion: a.agentVersion,
    firstTimestamp: a.firstTimestamp,
    primaryCategory: a.primaryCategory,
    flagged: a.failureStreaks.length > 0 || a.correctionStreaks.length > 0,
    spend: spend(a.spend),
    turns: a.turns.map((t) => ({
      index: t.index,
      category: t.category,
      ruleId: t.ruleId,
      matchedRuleIds: [...t.matchedRuleIds],
      promptRef: t.promptRef,
      ackPrompts: t.ackPrompts,
      correctionPrompts: t.correctionPrompts,
      toolCalls: t.toolCalls,
      modelCalls: t.modelCalls,
      spend: spend(t.spend),
    })),
    models: a.models.map(model),
    failureStreaks: failureStreaks(a),
    correctionStreaks: correctionStreaks(a),
  };
}

/** Stored with the snapshot; the snapshot id is added when served. */
export type ReconciliationBody =
  | Extract<ReconciliationResponse, { status: 'off' }>
  | Omit<Extract<ReconciliationResponse, { status: 'on' }>, 'snapshotId'>;

export function reconciliationBody(r: Reconciliation): ReconciliationBody {
  const side = (s: Reconciliation['mismatches'][number]['otel']): { model: string | null; tokens: ApiTokens | null; costUsd: number | null } => ({
    model: s.model,
    tokens: s.tokens === null ? null : tokens(s.tokens),
    costUsd: s.cost === null ? null : usd(s.cost),
  });
  return {
    status: 'on',
    toleranceUsd: TOLERANCE_NANO_USD / 1e9,
    matched: r.matched,
    otelRequests: r.otelRequests,
    maxDifferenceUsd: usd(r.maxDifference),
    mismatches: r.mismatches.map((m) => ({ sessionId: m.sessionId, ordinal: m.ordinal, reason: m.reason, otel: side(m.otel), log: side(m.log) })),
    unmatchedOtel: r.unmatchedOtel.map((u) => ({ ...u })),
    unmatchedLog: r.unmatchedLog.map((u) => ({ ...u })),
    unreadableLines: r.unreadableLines,
  };
}
