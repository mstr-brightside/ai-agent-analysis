import { contentHash } from '../hash.ts';
import type { ToolCallEvent } from '../model.ts';
import { PROMPT_KIND_RULES } from '../segment/prompt-kind.ts';
import type { Turn } from '../segment/turns.ts';
import {
  CATEGORY_PRIORITY,
  NO_MATCH_RULE,
  NO_PROMPT_RULE,
  PROMPT_RULES,
  TEST_COMMAND_PATTERN,
  TOOL_RULES,
  type Category,
} from './rules.ts';

export type Classification = {
  readonly category: Category;
  readonly ruleId: string;
  readonly matchedRuleIds: readonly string[];
};

/** Content hash of every rule that affects classification and turn segmentation. */
export const CLASSIFIER_VERSION: string = contentHash({
  promptKinds: PROMPT_KIND_RULES,
  promptRules: PROMPT_RULES,
  priority: CATEGORY_PRIORITY,
  testCommand: TEST_COMMAND_PATTERN,
  toolRules: TOOL_RULES,
});

export function classifyPrompt(text: string): Classification | null {
  const matched = PROMPT_RULES.filter((rule) => rule.pattern.test(text));
  const winner = matched[0];
  if (winner === undefined) return null;
  return { category: winner.category, ruleId: winner.id, matchedRuleIds: matched.map((r) => r.id) };
}

/** Fallback when no prompt rule matches: the shape of the agent's tool use. */
export function classifyByTools(calls: readonly ToolCallEvent[]): Classification | null {
  if (calls.length === 0) return null;
  const count = (predicate: (c: ToolCallEvent) => boolean): number => calls.filter(predicate).length;
  const readOnly = count((c) => c.toolKind === 'read' || c.toolKind === 'search');
  if (readOnly === calls.length) return { category: 'research', ruleId: TOOL_RULES.readOnly, matchedRuleIds: [] };
  const edits = count((c) => c.toolKind === 'edit' || c.toolKind === 'write');
  if (edits * 2 > calls.length) return { category: 'implement', ruleId: TOOL_RULES.mostlyEdits, matchedRuleIds: [] };
  const tests = count((c) => c.toolKind === 'shell' && c.target !== null && TEST_COMMAND_PATTERN.test(c.target));
  if (tests * 2 > calls.length) return { category: 'test', ruleId: TOOL_RULES.mostlyTests, matchedRuleIds: [] };
  return null;
}

export function classifyTurn(turn: Turn): Classification {
  if (turn.opening === null) return { category: 'unknown', ruleId: NO_PROMPT_RULE, matchedRuleIds: [] };
  const byPrompt = classifyPrompt(turn.opening.event.text);
  if (byPrompt !== null) return byPrompt;
  const calls = turn.events.filter((e): e is ToolCallEvent => e.type === 'tool-call');
  return classifyByTools(calls) ?? { category: 'unknown', ruleId: NO_MATCH_RULE, matchedRuleIds: [] };
}
