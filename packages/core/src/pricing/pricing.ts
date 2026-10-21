import { contentHash } from '../hash.ts';
import {
  addTokens,
  costOf,
  ratePerToken,
  sumUsd,
  tokenCount,
  ZERO_TOKENS,
  ZERO_USD,
  type NanoUsd,
  type NanoUsdPerToken,
  type TokenCount,
} from '../units.ts';
import type { Usage } from '../usage.ts';
import { PRICE_TABLE, type PriceTableSource, type RateSource } from './price-table.ts';

export type PricingStatus = 'complete' | 'complete-no-cache-data' | 'estimated' | 'unpriced';
export const PRICING_STATUSES = ['complete', 'complete-no-cache-data', 'estimated', 'unpriced'] as const satisfies readonly PricingStatus[];

export type UnpricedReason =
  /** No model name was recorded (or the tool hides it, e.g. Cursor `auto`, which is a name we do not price). */
  | 'no-model'
  /** The model name is not on an official price page. */
  | 'unknown-model'
  /** The call carries no usage numbers. */
  | 'no-usage'
  /** The usage has a token kind the vendor has no rate for (e.g. a cache write on an OpenAI model). */
  | 'no-rate';

export type TokenTotals = {
  readonly freshInput: TokenCount;
  readonly cacheRead: TokenCount;
  readonly cacheWrite: TokenCount;
  readonly output: TokenCount;
};

export const ZERO_TOKEN_TOTALS: TokenTotals = {
  freshInput: ZERO_TOKENS,
  cacheRead: ZERO_TOKENS,
  cacheWrite: ZERO_TOKENS,
  output: ZERO_TOKENS,
};

export function addTokenTotals(a: TokenTotals, b: TokenTotals): TokenTotals {
  return {
    freshInput: addTokens(a.freshInput, b.freshInput),
    cacheRead: addTokens(a.cacheRead, b.cacheRead),
    cacheWrite: addTokens(a.cacheWrite, b.cacheWrite),
    output: addTokens(a.output, b.output),
  };
}

export type CostBreakdown = {
  readonly freshInput: NanoUsd;
  readonly cacheRead: NanoUsd;
  readonly cacheWrite: NanoUsd;
  readonly output: NanoUsd;
};

export type PricedCall =
  | {
      readonly status: 'unpriced';
      readonly reason: UnpricedReason;
      readonly priceKey: string | null;
      readonly cost: NanoUsd;
      readonly tokens: TokenTotals;
    }
  | {
      readonly status: 'complete' | 'complete-no-cache-data' | 'estimated';
      readonly priceKey: string;
      readonly tier: 'standard' | 'long-context';
      readonly cost: NanoUsd;
      readonly breakdown: CostBreakdown;
      readonly tokens: TokenTotals;
    };

type Rates = {
  readonly input: NanoUsdPerToken;
  readonly cacheRead: NanoUsdPerToken;
  readonly cacheWrite5m: NanoUsdPerToken | null;
  readonly cacheWrite1h: NanoUsdPerToken | null;
  readonly output: NanoUsdPerToken;
};

type Entry = {
  readonly key: string;
  readonly rates: Rates;
  readonly longContext: { readonly aboveInputTokens: number; readonly rates: Rates } | null;
};

export type Pricer = {
  /** Content hash of the price table: any change to a rate or a mapping changes it. */
  readonly version: string;
  /** Price-table key for a model name as it appears in logs, or null when unpriced. */
  resolve(model: string | null): string | null;
  price(model: string | null, usage: Usage | null): PricedCall;
};

/** `claude-sonnet-4-5-20250929[1m]` is the 1M-context variant name; it bills at the base model's rates. */
export function normalizeModelName(model: string): string {
  return model.replace(/\[1m\]$/i, '');
}

function toRates(source: RateSource): Rates {
  return {
    input: ratePerToken(source.input),
    cacheRead: ratePerToken(source.cacheRead),
    cacheWrite5m: source.cacheWrite5m === null ? null : ratePerToken(source.cacheWrite5m),
    cacheWrite1h: source.cacheWrite1h === null ? null : ratePerToken(source.cacheWrite1h),
    output: ratePerToken(source.output),
  };
}

function tokenTotals(usage: Usage | null): TokenTotals {
  if (usage === null) return ZERO_TOKEN_TOTALS;
  return {
    freshInput: usage.freshInput,
    cacheRead: usage.cache?.read ?? ZERO_TOKENS,
    cacheWrite: usage.cache === null ? ZERO_TOKENS : addTokens(usage.cache.write5m, usage.cache.write1h),
    output: usage.output,
  };
}

function pricedStatus(estimated: boolean, hasCacheData: boolean): 'complete' | 'complete-no-cache-data' | 'estimated' {
  if (estimated) return 'estimated';
  if (!hasCacheData) return 'complete-no-cache-data';
  return 'complete';
}

export function createPricer(table: PriceTableSource = PRICE_TABLE): Pricer {
  const byName = new Map<string, Entry>();
  for (const [key, source] of Object.entries(table)) {
    const entry: Entry = {
      key,
      rates: toRates(source.rates),
      longContext:
        source.longContext === null
          ? null
          : { aboveInputTokens: source.longContext.aboveInputTokens, rates: toRates(source.longContext.rates) },
    };
    for (const name of source.modelNames) {
      if (byName.has(name)) throw new Error(`Price table maps model name "${name}" twice`);
      byName.set(name, entry);
    }
  }

  const lookup = (model: string | null): Entry | null =>
    model === null ? null : (byName.get(normalizeModelName(model)) ?? null);

  return {
    version: contentHash(table),
    resolve: (model) => lookup(model)?.key ?? null,
    price(model, usage) {
      const tokens = tokenTotals(usage);
      const entry = lookup(model);
      const unpriced = (reason: UnpricedReason): PricedCall => ({
        status: 'unpriced',
        reason,
        priceKey: entry?.key ?? null,
        cost: ZERO_USD,
        tokens,
      });
      if (model === null || model.trim() === '') return unpriced('no-model');
      if (entry === null) return unpriced('unknown-model');
      if (usage === null) return unpriced('no-usage');

      const cache = usage.cache;
      const totalInput = tokenCount(
        usage.freshInput + (cache === null ? 0 : cache.read + cache.write5m + cache.write1h),
      );
      const tier =
        entry.longContext !== null && totalInput > entry.longContext.aboveInputTokens ? entry.longContext : null;
      const rates = tier?.rates ?? entry.rates;

      let cacheWrite = ZERO_USD;
      if (cache !== null) {
        const parts: NanoUsd[] = [];
        for (const [count, rate] of [
          [cache.write5m, rates.cacheWrite5m],
          [cache.write1h, rates.cacheWrite1h],
        ] as const) {
          if (count <= ZERO_TOKENS) continue;
          if (rate === null) return unpriced('no-rate');
          parts.push(costOf(count, rate));
        }
        cacheWrite = sumUsd(parts);
      }

      const breakdown: CostBreakdown = {
        freshInput: costOf(usage.freshInput, rates.input),
        cacheRead: cache === null ? ZERO_USD : costOf(cache.read, rates.cacheRead),
        cacheWrite,
        output: costOf(usage.output, rates.output),
      };
      const status = pricedStatus(usage.estimate !== null, cache !== null);
      return {
        status,
        priceKey: entry.key,
        tier: tier === null ? 'standard' : 'long-context',
        cost: sumUsd([breakdown.freshInput, breakdown.cacheRead, breakdown.cacheWrite, breakdown.output]),
        breakdown,
        tokens,
      };
    },
  };
}
