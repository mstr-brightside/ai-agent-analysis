// Spend split by pricing status. Complete, lower-bound and estimated amounts are kept
// apart and never blended silently; unpriced calls carry no amount but their tokens count.
import type { PricedCall, PricingStatus } from './pricing/pricing.ts';
import { addTokens, addUsd, ZERO_TOKENS, ZERO_USD, type NanoUsd, type TokenCount } from './units.ts';

export type PricedStatus = Exclude<PricingStatus, 'unpriced'>;

export type Spend = {
  /** Sum of every priced amount (complete + lower bound + estimated). */
  readonly total: NanoUsd;
  readonly byStatus: Readonly<Record<PricedStatus, NanoUsd>>;
  readonly calls: Readonly<Record<PricingStatus, number>>;
  /** Calls whose usage was already charged under the same message id. */
  readonly repeatedUsageCalls: number;
  /** All tokens (input, cache, output) of unpriced calls. */
  readonly unpricedTokens: TokenCount;
};

export const EMPTY_SPEND: Spend = {
  total: ZERO_USD,
  byStatus: { complete: ZERO_USD, 'complete-no-cache-data': ZERO_USD, estimated: ZERO_USD },
  calls: { complete: 0, 'complete-no-cache-data': 0, estimated: 0, unpriced: 0 },
  repeatedUsageCalls: 0,
  unpricedTokens: ZERO_TOKENS,
};

export function spendOfCall(call: PricedCall): Spend {
  if (call.status === 'unpriced') {
    const t = call.tokens;
    return {
      ...EMPTY_SPEND,
      calls: { ...EMPTY_SPEND.calls, unpriced: 1 },
      unpricedTokens: addTokens(addTokens(t.freshInput, t.cacheRead), addTokens(t.cacheWrite, t.output)),
    };
  }
  return {
    ...EMPTY_SPEND,
    total: call.cost,
    byStatus: { ...EMPTY_SPEND.byStatus, [call.status]: call.cost },
    calls: { ...EMPTY_SPEND.calls, [call.status]: 1 },
  };
}

export const REPEATED_USAGE: Spend = { ...EMPTY_SPEND, repeatedUsageCalls: 1 };

export function addSpend(a: Spend, b: Spend): Spend {
  return {
    total: addUsd(a.total, b.total),
    byStatus: {
      complete: addUsd(a.byStatus.complete, b.byStatus.complete),
      'complete-no-cache-data': addUsd(a.byStatus['complete-no-cache-data'], b.byStatus['complete-no-cache-data']),
      estimated: addUsd(a.byStatus.estimated, b.byStatus.estimated),
    },
    calls: {
      complete: a.calls.complete + b.calls.complete,
      'complete-no-cache-data': a.calls['complete-no-cache-data'] + b.calls['complete-no-cache-data'],
      estimated: a.calls.estimated + b.calls.estimated,
      unpriced: a.calls.unpriced + b.calls.unpriced,
    },
    repeatedUsageCalls: a.repeatedUsageCalls + b.repeatedUsageCalls,
    unpricedTokens: addTokens(a.unpricedTokens, b.unpricedTokens),
  };
}

export function sumSpend(items: Iterable<Spend>): Spend {
  let total = EMPTY_SPEND;
  for (const s of items) total = addSpend(total, s);
  return total;
}
