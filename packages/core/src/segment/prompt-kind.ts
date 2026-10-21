// Every user prompt gets a kind, checked in this order:
//   1. ack:        approval or thanks; joins the current turn
//   2. correction: the agent got it wrong; joins the current turn and is counted
//   3. intent:     anything else; opens a new turn
// Rules are data (id + regex) so they are hashed into the classifier version.

export type PromptKind = 'intent' | 'ack' | 'correction';

export type PromptKindRule = {
  readonly id: string;
  readonly kind: 'ack' | 'correction';
  readonly pattern: RegExp;
};

// Anchored at the start of the prompt: an approval or complaint leads the message.
// Separators after the opening word cover ",", ".", "!", "—", "-" and ":".
export const PROMPT_KIND_RULES: readonly PromptKindRule[] = [
  { id: 'ack.thanks', kind: 'ack', pattern: /^\s*(thanks|thank you|thx|cheers)\b/i },
  {
    id: 'ack.approval',
    kind: 'ack',
    pattern: /^\s*(great|perfect|looks good|lgtm|nice|awesome|excellent|well done|good job|works now)\b\s*[,.!—–:-]/i,
  },
  { id: 'correction.no', kind: 'correction', pattern: /^\s*(no|nope)\s*[,.!—–:-]/i },
  { id: 'correction.still-failing', kind: 'correction', pattern: /^\s*still (failing|broken|not working|wrong)\b/i },
  {
    id: 'correction.not-what-i-asked',
    kind: 'correction',
    pattern: /^\s*(that'?s|that is|this is) (not what i (asked|wanted|meant)|wrong)\b/i,
  },
  { id: 'correction.wrong', kind: 'correction', pattern: /^\s*wrong (file|function|place|module|approach)\b/i },
  { id: 'correction.hallucinated', kind: 'correction', pattern: /^\s*you (hallucinated|made up|invented)\b/i },
  { id: 'correction.too-much', kind: 'correction', pattern: /^\s*(too much|undo|revert)\b/i },
  {
    id: 'correction.broke',
    kind: 'correction',
    pattern: /^\s*(that|this|it|you) (broke|didn'?t work|doesn'?t work)\b/i,
  },
];

export type PromptKindResult = { readonly kind: PromptKind; readonly ruleId: string };

export function promptKind(text: string): PromptKindResult {
  for (const rule of PROMPT_KIND_RULES) {
    if (rule.pattern.test(text)) return { kind: rule.kind, ruleId: rule.id };
  }
  return { kind: 'intent', ruleId: 'intent.default' };
}
