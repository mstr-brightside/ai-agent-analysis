// Turn segmentation. A turn is an intent prompt plus all work up to the next intent
// prompt. Acks and corrections join the current turn. Edge cases keep turn spend summing
// exactly to session spend:
//   - a session that opens with an ack or correction: that prompt opens an intent turn;
//   - events before the first prompt (or in a session with no prompt): their own turn,
//     opened by nothing (`no-prompt`);
//   - sidechain events stay in the turn they occur in, by file order.
import type { PromptEvent, SessionEvent } from '../model.ts';
import { promptKind, type PromptKind } from './prompt-kind.ts';

export type SegmentedPrompt = {
  readonly event: PromptEvent;
  /** Kind after edge-case handling: an opening ack/correction is reported as `intent`. */
  readonly kind: PromptKind;
  readonly ruleId: string;
};

export type Turn = {
  readonly index: number;
  /** The intent prompt that opened the turn, or null for a `no-prompt` turn. */
  readonly opening: SegmentedPrompt | null;
  /** Every prompt in the turn, opening included, in order. */
  readonly prompts: readonly SegmentedPrompt[];
  /** Every event in the turn, prompts included, in file order. */
  readonly events: readonly SessionEvent[];
};

export const OPENING_PROMPT_RULE = 'intent.session-opening';

export function segmentTurns(events: readonly SessionEvent[]): Turn[] {
  type Building = { index: number; opening: SegmentedPrompt | null; prompts: SegmentedPrompt[]; events: SessionEvent[] };
  const turns: Building[] = [];
  let current: Building | null = null;

  for (const event of events) {
    if (event.type === 'prompt') {
      const detected = promptKind(event.text);
      if (detected.kind !== 'intent' && current !== null && current.opening !== null) {
        const follow: SegmentedPrompt = { event, kind: detected.kind, ruleId: detected.ruleId };
        current.prompts.push(follow);
        current.events.push(event);
        continue;
      }
      const opening: SegmentedPrompt =
        detected.kind === 'intent'
          ? { event, kind: 'intent', ruleId: detected.ruleId }
          : { event, kind: 'intent', ruleId: OPENING_PROMPT_RULE };
      current = { index: turns.length, opening, prompts: [opening], events: [event] };
      turns.push(current);
      continue;
    }
    if (current === null) {
      current = { index: turns.length, opening: null, prompts: [], events: [] };
      turns.push(current);
    }
    current.events.push(event);
  }
  return turns;
}
