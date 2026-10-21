// Branded integer units. Money is nano-USD (1e-9 USD) so every list rate is a whole
// number per token and sums are exact. Token counts are a separate brand so the two
// can never be added together by accident.

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type NanoUsd = Brand<number, 'NanoUsd'>;
export type NanoUsdPerToken = Brand<number, 'NanoUsdPerToken'>;
export type TokenCount = Brand<number, 'TokenCount'>;

function isNanoUsd(n: number): n is NanoUsd {
  return Number.isSafeInteger(n);
}
function isRate(n: number): n is NanoUsdPerToken {
  return Number.isSafeInteger(n) && n >= 0;
}
function isTokenCount(n: number): n is TokenCount {
  return Number.isSafeInteger(n) && n >= 0;
}

export function nanoUsd(n: number): NanoUsd {
  if (!isNanoUsd(n)) throw new RangeError(`Not a safe integer nano-USD amount: ${n}`);
  return n;
}

/** A list rate in nano-USD per token. $3.00 per million tokens is 3000. */
export function ratePerToken(n: number): NanoUsdPerToken {
  if (!isRate(n)) throw new RangeError(`Not a whole non-negative nano-USD rate: ${n}`);
  return n;
}

export function tokenCount(n: number): TokenCount {
  if (!isTokenCount(n)) throw new RangeError(`Not a non-negative integer token count: ${n}`);
  return n;
}

export const ZERO_USD: NanoUsd = nanoUsd(0);
export const ZERO_TOKENS: TokenCount = tokenCount(0);

export function addUsd(a: NanoUsd, b: NanoUsd): NanoUsd {
  return nanoUsd(a + b);
}

export function subUsd(a: NanoUsd, b: NanoUsd): NanoUsd {
  return nanoUsd(a - b);
}

export function sumUsd(values: Iterable<NanoUsd>): NanoUsd {
  let total = ZERO_USD;
  for (const v of values) total = addUsd(total, v);
  return total;
}

export function addTokens(a: TokenCount, b: TokenCount): TokenCount {
  return tokenCount(a + b);
}

export function sumTokens(values: Iterable<TokenCount>): TokenCount {
  let total = ZERO_TOKENS;
  for (const v of values) total = addTokens(total, v);
  return total;
}

/** Tokens × rate. Both are integers, so the product is exact while it stays a safe integer. */
export function costOf(tokens: TokenCount, rate: NanoUsdPerToken): NanoUsd {
  return nanoUsd(tokens * rate);
}

/** For the API and display edges only. Never feed the result back into a sum. */
export function nanoUsdToDollars(amount: NanoUsd): number {
  return amount / 1e9;
}
