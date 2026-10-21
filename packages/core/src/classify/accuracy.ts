// How far the categories can be trusted. Two measurements compare the classifier with
// hand labels (the caller reads the label files); the third needs no labels: how each turn
// of the analysed data got its category.
import type { SessionAnalysis } from '../analyze.ts';
import { refLabel } from '../model.ts';
import { classifyPrompt } from './classify.ts';
import { TOOL_RULES, type Category } from './rules.ts';

export type Agreement = { readonly agreed: number; readonly total: number };

export type LabelledPrompt = { readonly prompt: string; readonly label: Category };

/** A labelled turn, identified as `source:file:line` (or `source:key`) of its opening prompt. */
export type LabelledTurn = { readonly id: string; readonly label: Category };

export type ClassifiedBy = {
  /** A prompt rule decided the category. */
  readonly promptRule: number;
  /** No prompt rule matched; the shape of the agent's tool use decided. */
  readonly toolShape: number;
  /** Category `unknown`. */
  readonly unclassified: number;
};

const TOOL_RULE_IDS: ReadonlySet<string> = new Set(Object.values(TOOL_RULES));

/** Prompt-only agreement: no tool use exists for these prompts. */
export function promptAgreement(prompts: readonly LabelledPrompt[]): Agreement {
  const agreed = prompts.filter((p) => (classifyPrompt(p.prompt)?.category ?? 'unknown') === p.label).length;
  return { agreed, total: prompts.length };
}

/** Agreement on labelled turns of the analysed data; null when any labelled turn is not in it. */
export function turnAgreement(sessions: readonly SessionAnalysis[], labels: readonly LabelledTurn[]): Agreement | null {
  const predicted = new Map<string, Category>();
  for (const session of sessions) {
    for (const turn of session.turns) {
      if (turn.promptRef !== null) predicted.set(`${session.source}:${refLabel(turn.promptRef)}`, turn.category);
    }
  }
  let agreed = 0;
  for (const { id, label } of labels) {
    const category = predicted.get(id);
    if (category === undefined) return null;
    if (category === label) agreed++;
  }
  return { agreed, total: labels.length };
}

export function classifiedBy(sessions: readonly SessionAnalysis[]): ClassifiedBy {
  let promptRule = 0;
  let toolShape = 0;
  let unclassified = 0;
  for (const turn of sessions.flatMap((s) => s.turns)) {
    if (turn.category === 'unknown') unclassified++;
    else if (TOOL_RULE_IDS.has(turn.ruleId)) toolShape++;
    else promptRule++;
  }
  return { promptRule, toolShape, unclassified };
}
