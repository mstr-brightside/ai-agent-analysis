// Per-session analysis: segment into turns, classify each turn, price each model call,
// find suspected waste. The result holds no prompt text: evidence is source refs and rule ids.
import { assertNever } from './assert.ts';
import { classifyTurn, type Classification } from './classify/classify.ts';
import { CATEGORY_PRIORITY, type Category } from './classify/rules.ts';
import { projectFolder, type ModelCallEvent, type SessionInput, type SourceKind, type SourceRef } from './model.ts';
import { addTokenTotals, ZERO_TOKEN_TOTALS, type Pricer, type TokenTotals } from './pricing/pricing.ts';
import { segmentTurns } from './segment/turns.ts';
import { addSpend, EMPTY_SPEND, REPEATED_USAGE, spendOfCall, sumSpend, type Spend } from './spend.ts';
import { sumUsd, type NanoUsd } from './units.ts';
import { findCorrectionStreaks, findFailureStreaks, type Attempt, type ClassifiedPrompt } from './waste/streaks.ts';

export type TurnAnalysis = {
  readonly index: number;
  readonly category: Category;
  readonly ruleId: string;
  readonly matchedRuleIds: readonly string[];
  readonly promptRef: SourceRef | null;
  readonly ackPrompts: number;
  readonly correctionPrompts: number;
  readonly toolCalls: number;
  readonly modelCalls: number;
  readonly spend: Spend;
};

export type ModelUsage = {
  readonly model: string | null;
  readonly priceKey: string | null;
  readonly spend: Spend;
  readonly tokens: TokenTotals;
};

export type FailureStreak = {
  readonly tool: string;
  readonly target: string;
  readonly length: number;
  readonly attempts: readonly Attempt[];
  readonly turnIndexes: readonly number[];
  /** Spend on model calls made between the first failed call and the last failed result. */
  readonly costDuringStreak: NanoUsd;
};

export type CorrectionStreak = {
  readonly length: number;
  readonly prompts: readonly SourceRef[];
  readonly turnIndexes: readonly number[];
  /** Spend on model calls from the first correction until the prompt that ended the streak. */
  readonly costDuringStreak: NanoUsd;
};

export type SessionAnalysis = {
  readonly source: SourceKind;
  readonly sessionId: string;
  /** Folder name only; full paths never leave the store. */
  readonly project: string | null;
  readonly agentVersion: string | null;
  /** First timestamp in file order (data only, never used for ordering). */
  readonly firstTimestamp: string | null;
  readonly primaryCategory: Category;
  readonly spend: Spend;
  readonly turns: readonly TurnAnalysis[];
  readonly models: readonly ModelUsage[];
  readonly failureStreaks: readonly FailureStreak[];
  readonly correctionStreaks: readonly CorrectionStreak[];
};

/**
 * Highest spend wins; ties go to more turns, then to priority order. `unknown` turns only
 * decide when every turn is unknown.
 */
export function primaryCategory(turns: readonly Pick<TurnAnalysis, 'category' | 'spend'>[]): Category {
  type Score = { spend: NanoUsd; turns: number };
  const scores = new Map<Category, Score>();
  for (const t of turns) {
    if (t.category === 'unknown') continue;
    const s = scores.get(t.category);
    scores.set(t.category, { spend: sumUsd([s?.spend ?? EMPTY_SPEND.total, t.spend.total]), turns: (s?.turns ?? 0) + 1 });
  }
  let best: { category: Category; score: Score } | null = null;
  for (const category of CATEGORY_PRIORITY) {
    const score = scores.get(category);
    if (score === undefined) continue;
    if (best === null || score.spend > best.score.spend || (score.spend === best.score.spend && score.turns > best.score.turns)) {
      best = { category, score };
    }
  }
  return best?.category ?? 'unknown';
}

export function analyzeSession(session: SessionInput, pricer: Pricer): SessionAnalysis {
  const events = session.events;
  const turns = segmentTurns(events);

  // Price every model call once, in file order. Usage under an already-charged message id is not charged again.
  const charged = new Set<string>();
  const callSpend = new Map<ModelCallEvent, Spend>();
  const models = new Map<string, { model: string | null; priceKey: string | null; spend: Spend; tokens: TokenTotals }>();
  for (const e of events) {
    if (e.type !== 'model-call') continue;
    if (e.messageId !== null && charged.has(e.messageId)) {
      callSpend.set(e, REPEATED_USAGE);
      continue;
    }
    if (e.messageId !== null) charged.add(e.messageId);
    const priced = pricer.price(e.model, e.usage);
    const spend = spendOfCall(priced);
    callSpend.set(e, spend);
    const key = e.model ?? '';
    const row = models.get(key) ?? { model: e.model, priceKey: pricer.resolve(e.model), spend: EMPTY_SPEND, tokens: ZERO_TOKEN_TOTALS };
    models.set(key, { ...row, spend: addSpend(row.spend, spend), tokens: addTokenTotals(row.tokens, priced.tokens) });
  }

  const turnOfEvent: number[] = [];
  const turnAnalyses: TurnAnalysis[] = turns.map((turn) => {
    const classification: Classification = classifyTurn(turn);
    let spend = EMPTY_SPEND;
    let toolCalls = 0;
    let modelCalls = 0;
    for (const e of turn.events) {
      turnOfEvent.push(turn.index);
      switch (e.type) {
        case 'model-call':
          modelCalls++;
          spend = addSpend(spend, callSpend.get(e) ?? EMPTY_SPEND);
          break;
        case 'tool-call':
          toolCalls++;
          break;
        case 'prompt':
        case 'tool-result':
          break;
        default:
          assertNever(e);
      }
    }
    return {
      index: turn.index,
      category: classification.category,
      ruleId: classification.ruleId,
      matchedRuleIds: classification.matchedRuleIds,
      promptRef: turn.opening?.event.ref ?? null,
      ackPrompts: turn.prompts.filter((p) => p.kind === 'ack').length,
      correctionPrompts: turn.prompts.filter((p) => p.kind === 'correction').length,
      toolCalls,
      modelCalls,
      spend,
    };
  });

  // Turns partition the events in order, so `turnOfEvent[i]` is the turn of `events[i]`.
  const costBetween = (start: number, end: number): NanoUsd =>
    sumSpend(
      events.slice(start, end + 1).flatMap((e) => (e.type === 'model-call' ? [callSpend.get(e) ?? EMPTY_SPEND] : [])),
    ).total;
  const turnsBetween = (start: number, end: number): number[] => [...new Set(turnOfEvent.slice(start, end + 1))];

  const failureStreaks: FailureStreak[] = findFailureStreaks(events).map((s) => ({
    tool: s.tool,
    target: s.target,
    length: s.length,
    attempts: s.attempts,
    turnIndexes: turnsBetween(s.start, s.end),
    costDuringStreak: costBetween(s.start, s.end),
  }));

  const prompts: ClassifiedPrompt[] = [];
  let index = 0;
  for (const turn of turns) {
    for (const e of turn.events) {
      const prompt = e.type === 'prompt' ? turn.prompts.find((p) => p.event === e) : undefined;
      if (prompt !== undefined) prompts.push({ index, ref: e.ref, kind: prompt.kind });
      index++;
    }
  }
  const correctionStreaks: CorrectionStreak[] = findCorrectionStreaks(prompts, events.length).map((s) => ({
    length: s.length,
    prompts: s.prompts,
    turnIndexes: turnsBetween(s.start, s.end),
    costDuringStreak: costBetween(s.start, s.end),
  }));

  const firstTimestamp = events.find((e) => e.timestamp !== null)?.timestamp ?? null;
  return {
    source: session.source,
    sessionId: session.sessionId,
    project: projectFolder(session.info.projectPath),
    agentVersion: session.info.agentVersion,
    firstTimestamp,
    primaryCategory: primaryCategory(turnAnalyses),
    spend: sumSpend(turnAnalyses.map((t) => t.spend)),
    turns: turnAnalyses,
    models: [...models.values()].sort((a, b) => b.spend.total - a.spend.total),
    failureStreaks,
    correctionStreaks,
  };
}
