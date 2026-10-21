import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { addUsd, costOf, nanoUsd, ratePerToken, sumUsd, tokenCount } from '../src/units.ts';

describe('units', () => {
  it('prices tokens exactly in integer nano-USD', () => {
    // $18.75 per million tokens = 18,750 nano-USD per token.
    assert.equal(costOf(tokenCount(1988), ratePerToken(18_750)), 37_275_000);
  });

  it('sums without float drift', () => {
    const tenth = nanoUsd(100_000_000); // $0.10
    assert.equal(sumUsd([tenth, tenth, tenth]), 300_000_000);
    assert.equal(addUsd(tenth, tenth), 200_000_000);
  });

  it('rejects non-integers and negative counts', () => {
    assert.throws(() => nanoUsd(0.5), RangeError);
    assert.throws(() => tokenCount(-1), RangeError);
    assert.throws(() => ratePerToken(0.3), RangeError);
  });
});
