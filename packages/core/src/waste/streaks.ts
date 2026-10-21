// Suspected waste: two separate signals, never merged into one score.
//
// Failure streak: 3+ consecutive failures among calls of the same tool with the same
// normalized target. Other tool calls may happen in between. A call with no result, or a
// result without an outcome, is `unknown`: it neither extends nor breaks a streak.
//
// Correction streak: 2+ consecutive correction prompts. An ack or intent prompt ends it.
//
// Both report positions (indices into the session's events) so the caller can price
// the model calls made while the streak ran.
import { assertNever } from '../assert.ts';
import type { SessionEvent, SourceRef, ToolOutcome } from '../model.ts';
import type { PromptKind } from '../segment/prompt-kind.ts';

export const MIN_FAILURE_STREAK = 3;
export const MIN_CORRECTION_STREAK = 2;

export type Attempt = {
  readonly callRef: SourceRef;
  readonly resultRef: SourceRef | null;
  readonly outcome: ToolOutcome;
};

export type FailureStreakSpan = {
  readonly tool: string;
  readonly target: string;
  /** Number of failures; unknown outcomes inside the streak are listed but not counted. */
  readonly length: number;
  readonly attempts: readonly Attempt[];
  /** Event index of the first failed call. */
  readonly start: number;
  /** Event index of the last failed call's result. */
  readonly end: number;
};

export function findFailureStreaks(events: readonly SessionEvent[]): FailureStreakSpan[] {
  const results = new Map<string, { index: number; ref: SourceRef; outcome: ToolOutcome }>();
  events.forEach((e, index) => {
    if (e.type === 'tool-result' && !results.has(e.callId)) results.set(e.callId, { index, ref: e.ref, outcome: e.outcome });
  });

  type Pending = { attempt: Attempt; callIndex: number; resultIndex: number };
  type Run = { tool: string; target: string; items: Pending[] };
  const open = new Map<string, Run>();
  const streaks: FailureStreakSpan[] = [];

  const close = (run: Run): void => {
    // Trim unknowns after the last failure: they belong to no streak yet.
    let last = run.items.length - 1;
    while (last >= 0 && run.items[last]?.attempt.outcome !== 'failure') last--;
    const items = run.items.slice(0, last + 1);
    const failures = items.filter((i) => i.attempt.outcome === 'failure');
    const first = failures[0];
    const final = failures.at(-1);
    if (failures.length >= MIN_FAILURE_STREAK && first !== undefined && final !== undefined) {
      streaks.push({
        tool: run.tool,
        target: run.target,
        length: failures.length,
        attempts: items.map((i) => i.attempt),
        start: first.callIndex,
        end: final.resultIndex,
      });
    }
  };

  events.forEach((e, index) => {
    if (e.type !== 'tool-call' || e.target === null) return;
    const result = results.get(e.callId);
    const outcome: ToolOutcome = result?.outcome ?? 'unknown';
    const key = `${e.tool}\u0000${e.target}`;
    const attempt: Pending = {
      attempt: { callRef: e.ref, resultRef: result?.ref ?? null, outcome },
      callIndex: index,
      resultIndex: result?.index ?? index,
    };
    const run = open.get(key);
    switch (outcome) {
      case 'failure':
        if (run === undefined) open.set(key, { tool: e.tool, target: e.target, items: [attempt] });
        else run.items.push(attempt);
        return;
      case 'unknown':
        // Neither extends nor breaks: kept as evidence only inside an open run.
        run?.items.push(attempt);
        return;
      case 'success':
        if (run !== undefined) {
          close(run);
          open.delete(key);
        }
        return;
      default:
        assertNever(outcome);
    }
  });
  for (const run of open.values()) close(run);
  return streaks.sort((a, b) => b.length - a.length || a.start - b.start);
}

export type ClassifiedPrompt = { readonly index: number; readonly ref: SourceRef; readonly kind: PromptKind };

export type CorrectionStreakSpan = {
  readonly length: number;
  readonly prompts: readonly SourceRef[];
  /** Event index of the first correction. */
  readonly start: number;
  /** Event index just before the prompt that ended the streak, or the last event of the session. */
  readonly end: number;
};

export function findCorrectionStreaks(prompts: readonly ClassifiedPrompt[], eventCount: number): CorrectionStreakSpan[] {
  const streaks: CorrectionStreakSpan[] = [];
  let run: ClassifiedPrompt[] = [];
  const close = (endExclusive: number): void => {
    const first = run[0];
    if (run.length >= MIN_CORRECTION_STREAK && first !== undefined) {
      streaks.push({ length: run.length, prompts: run.map((p) => p.ref), start: first.index, end: endExclusive - 1 });
    }
    run = [];
  };
  for (const prompt of prompts) {
    switch (prompt.kind) {
      case 'correction':
        run.push(prompt);
        break;
      case 'ack':
      case 'intent':
        close(prompt.index);
        break;
      default:
        assertNever(prompt.kind);
    }
  }
  close(eventCount);
  return streaks.sort((a, b) => b.length - a.length || a.start - b.start);
}
