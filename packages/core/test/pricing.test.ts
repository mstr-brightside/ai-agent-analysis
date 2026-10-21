import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PriceTableSource } from '../src/pricing/price-table.ts';
import { createPricer, type PricedCall } from '../src/pricing/pricing.ts';
import { tokenCount, type TokenCount } from '../src/units.ts';
import type { Usage } from '../src/usage.ts';

const t = (n: number): TokenCount => tokenCount(n);

function anthropicUsage(input: number, output: number, cacheRead: number, cacheWrite5m: number): Usage {
  return {
    freshInput: t(input),
    output: t(output),
    cache: { read: t(cacheRead), write5m: t(cacheWrite5m), write1h: t(0) },
    estimate: null,
  };
}

function priced(call: PricedCall): Extract<PricedCall, { status: 'complete' | 'complete-no-cache-data' | 'estimated' }> {
  if (call.status === 'unpriced') assert.fail(`expected a priced call, got unpriced (${call.reason})`);
  return call;
}

const pricer = createPricer();

describe('pricing', () => {
  // SPEC §3 item 9: hand-checked against OTel cost_usd. Cache writes without a TTL split
  // are priced at the 5-minute rate.
  it('reproduces OTel cost_usd for an Opus 4.1 request with cache fields', () => {
    const call = priced(pricer.price('claude-opus-4-1-20250805', anthropicUsage(341, 562, 58_269, 1_988)));
    // 341 × 15,000 + 562 × 75,000 + 58,269 × 1,500 + 1,988 × 18,750 nano-USD
    assert.deepEqual(call.breakdown, {
      freshInput: 5_115_000,
      output: 42_150_000,
      cacheRead: 87_403_500,
      cacheWrite: 37_275_000,
    });
    assert.equal(call.cost, 171_943_500);
    assert.ok(Math.abs(call.cost - 0.171943 * 1e9) <= 1_000, 'within $0.000001 of cost_usd');
    assert.equal(call.status, 'complete');
  });

  it('reproduces OTel cost_usd for a Sonnet 4.5 request with cache fields', () => {
    const call = priced(pricer.price('claude-sonnet-4-5-20250929', anthropicUsage(126, 1_147, 47_689, 3_299)));
    assert.equal(call.cost, 44_260_950);
    assert.ok(Math.abs(call.cost - 0.044261 * 1e9) <= 1_000, 'within $0.000001 of cost_usd');
  });

  it('prices the [1m] variant at the base model rate', () => {
    const base = priced(pricer.price('claude-sonnet-4-5-20250929', anthropicUsage(10, 10, 10, 10)));
    const long = priced(pricer.price('claude-sonnet-4-5-20250929[1m]', anthropicUsage(10, 10, 10, 10)));
    assert.equal(long.cost, base.cost);
    assert.equal(long.priceKey, 'claude-sonnet-4-5');
  });

  it('maps Cursor model names onto the same entries', () => {
    assert.equal(pricer.resolve('claude-4.5-sonnet'), 'claude-sonnet-4-5');
    assert.equal(pricer.resolve('gpt-5'), 'gpt-5');
  });

  it('marks usage without cache fields as a lower bound', () => {
    const call = priced(
      pricer.price('claude-opus-4-1-20250805', { freshInput: t(100), output: t(10), cache: null, estimate: null }),
    );
    assert.equal(call.status, 'complete-no-cache-data');
    assert.equal(call.cost, 100 * 15_000 + 10 * 75_000);
  });

  it('marks adapter-estimated usage as estimated', () => {
    const call = priced(
      pricer.price('gpt-5-mini', {
        freshInput: t(0),
        output: t(10),
        cache: { read: t(500), write5m: t(0), write1h: t(0) },
        estimate: 'cached-exceeds-input',
      }),
    );
    assert.equal(call.status, 'estimated');
    assert.equal(call.cost, 500 * 25 + 10 * 2_000);
  });

  it('leaves unknown models, missing models and missing usage unpriced, with a reason', () => {
    const usage = anthropicUsage(1, 1, 1, 1);
    const unknown = pricer.price('gpt-5.5-codex', usage);
    const auto = pricer.price('auto', usage);
    const none = pricer.price(null, usage);
    const noUsage = pricer.price('claude-sonnet-5', null);
    assert.deepEqual(
      [unknown, auto, none, noUsage].map((c) => (c.status === 'unpriced' ? c.reason : c.status)),
      ['unknown-model', 'unknown-model', 'no-model', 'no-usage'],
    );
    assert.equal(unknown.cost, 0);
    assert.equal(unknown.tokens.cacheRead, 1, 'unpriced tokens are still counted');
  });

  it('does not guess from similar names', () => {
    assert.equal(pricer.resolve('claude-sonnet-4-5-20990101'), null);
    assert.equal(pricer.resolve('gpt-5.5-codex'), null);
  });

  it('refuses a cache write on a model with no cache-write rate', () => {
    const call = pricer.price('gpt-5', anthropicUsage(1, 1, 0, 5));
    assert.equal(call.status === 'unpriced' ? call.reason : call.status, 'no-rate');
  });

  it('switches the whole request to the long-context tier above the threshold, counting cache tokens', () => {
    const table = {
      m: {
        vendor: 'anthropic',
        displayName: 'M',
        modelNames: ['m'],
        rates: { input: 3_000, cacheWrite5m: 3_750, cacheWrite1h: 6_000, cacheRead: 300, output: 15_000 },
        longContext: {
          aboveInputTokens: 200_000,
          rates: { input: 6_000, cacheWrite5m: 7_500, cacheWrite1h: 12_000, cacheRead: 600, output: 22_500 },
        },
        sourceUrl: 'https://example.invalid',
        retrieved: '2026-10-11',
      },
    } satisfies PriceTableSource;
    const tiered = createPricer(table);
    const at = priced(tiered.price('m', anthropicUsage(100_000, 1, 100_000, 0)));
    const above = priced(tiered.price('m', anthropicUsage(100_000, 1, 100_000, 1)));
    assert.equal(at.tier, 'standard');
    assert.equal(above.tier, 'long-context');
    assert.equal(above.cost, 100_000 * 6_000 + 22_500 + 100_000 * 600 + 7_500);
  });

  it('has a version that changes with any rate', () => {
    const base = createPricer();
    assert.match(base.version, /^[0-9a-f]{16}$/);
    const table = {
      m: {
        vendor: 'openai',
        displayName: 'M',
        modelNames: ['m'],
        rates: { input: 1, cacheWrite5m: null, cacheWrite1h: null, cacheRead: 1, output: 1 },
        longContext: null,
        sourceUrl: 'u',
        retrieved: 'r',
      },
    } satisfies PriceTableSource;
    const changed = { m: { ...table.m, rates: { ...table.m.rates, output: 2 } } } satisfies PriceTableSource;
    assert.notEqual(createPricer(table).version, createPricer(changed).version);
  });

  it('rejects a fractional rate in the table', () => {
    const table = {
      m: {
        vendor: 'openai',
        displayName: 'M',
        modelNames: ['m'],
        rates: { input: 0.5, cacheWrite5m: null, cacheWrite1h: null, cacheRead: 1, output: 1 },
        longContext: null,
        sourceUrl: 'u',
        retrieved: 'r',
      },
    } satisfies PriceTableSource;
    assert.throws(() => createPricer(table), RangeError);
  });
});
