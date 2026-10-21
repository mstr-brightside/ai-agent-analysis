// OTel pricing oracle. Claude Code's OTel `api_request` events carry `cost_usd`. They
// describe the same requests as the Claude JSONL, so they are never ingested as spend;
// they only cross-check our prices.
//
// Matching: same session; the n-th `api_request` pairs with the n-th unique `message.id`
// in file order. Model and token counts must agree before cost is compared; otherwise the
// pair is a mismatch, never forced. A log without cache fields (CLI 1.0.83) agrees when
// OTel reports zero cache tokens.
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { nanoUsd, tokenCount, type ModelCallEvent, type NanoUsd, type Pricer, type TokenTotals } from '@agentspend/core';

/** Our price must be within $0.000001 of cost_usd. */
export const TOLERANCE_NANO_USD = 1_000;

const count = z.number().int().nonnegative();
const ApiRequest = z.looseObject({
  attributes: z.looseObject({
    'event.name': z.literal('api_request'),
    'session.id': z.string(),
    model: z.string(),
    input_tokens: count,
    output_tokens: count,
    cache_read_tokens: count,
    cache_creation_tokens: count,
    cost_usd: z.number().nonnegative(),
  }),
});
const AnyEvent = z.looseObject({ attributes: z.looseObject({ 'event.name': z.string() }) });

export type OtelRequest = {
  readonly sessionId: string;
  readonly model: string;
  readonly tokens: TokenTotals;
  /** cost_usd converted to nano-USD (rounded to the nearest nano). */
  readonly cost: NanoUsd;
};

export type OtelFile = { readonly requests: readonly OtelRequest[]; readonly unreadableLines: number };

export function readOtelFile(filePath: string): OtelFile {
  const requests: OtelRequest[] = [];
  let unreadableLines = 0;
  for (const line of readFileSync(filePath, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      unreadableLines++;
      continue;
    }
    const event = AnyEvent.safeParse(json);
    if (!event.success) {
      unreadableLines++;
      continue;
    }
    if (event.data.attributes['event.name'] !== 'api_request') continue;
    const r = ApiRequest.safeParse(json);
    if (!r.success) {
      unreadableLines++;
      continue;
    }
    const a = r.data.attributes;
    requests.push({
      sessionId: a['session.id'],
      model: a.model,
      tokens: {
        freshInput: tokenCount(a.input_tokens),
        cacheRead: tokenCount(a.cache_read_tokens),
        cacheWrite: tokenCount(a.cache_creation_tokens),
        output: tokenCount(a.output_tokens),
      },
      cost: nanoUsd(Math.round(a.cost_usd * 1e9)),
    });
  }
  return { requests, unreadableLines };
}

export type ReconcileSide = {
  readonly model: string | null;
  readonly tokens: TokenTotals | null;
  readonly cost: NanoUsd | null;
};

export type ReconcileMismatch = {
  readonly sessionId: string;
  readonly ordinal: number;
  readonly reason: 'tokens-differ' | 'model-differs' | 'no-usage-in-log' | 'unpriced' | 'cost-differs';
  readonly otel: ReconcileSide;
  readonly log: ReconcileSide;
};

export type Reconciliation = {
  readonly otelRequests: number;
  readonly matched: number;
  readonly maxDifference: NanoUsd;
  readonly mismatches: readonly ReconcileMismatch[];
  readonly unmatchedOtel: ReadonlyArray<{ readonly sessionId: string; readonly ordinal: number }>;
  readonly unmatchedLog: ReadonlyArray<{ readonly sessionId: string; readonly ordinal: number }>;
  readonly unreadableLines: number;
};

function logTokens(call: ModelCallEvent): TokenTotals | null {
  const u = call.usage;
  if (u === null) return null;
  return {
    freshInput: u.freshInput,
    output: u.output,
    cacheRead: u.cache?.read ?? tokenCount(0),
    cacheWrite: u.cache === null ? tokenCount(0) : tokenCount(u.cache.write5m + u.cache.write1h),
  };
}

function sameTokens(a: TokenTotals, b: TokenTotals): boolean {
  return a.freshInput === b.freshInput && a.output === b.output && a.cacheRead === b.cacheRead && a.cacheWrite === b.cacheWrite;
}

/**
 * `logCalls`: per Claude session, its model calls in file order. Only calls with a
 * message id take part (the OTel request count equals the unique message-id count).
 */
export function reconcile(otel: OtelFile, logCalls: ReadonlyMap<string, readonly ModelCallEvent[]>, pricer: Pricer): Reconciliation {
  const otelBySession = new Map<string, OtelRequest[]>();
  for (const r of otel.requests) otelBySession.set(r.sessionId, [...(otelBySession.get(r.sessionId) ?? []), r]);

  const uniqueLog = new Map<string, ModelCallEvent[]>();
  for (const [sessionId, calls] of logCalls) {
    const seen = new Set<string>();
    const unique: ModelCallEvent[] = [];
    for (const c of calls) {
      if (c.messageId === null || seen.has(c.messageId)) continue;
      seen.add(c.messageId);
      unique.push(c);
    }
    uniqueLog.set(sessionId, unique);
  }

  const mismatches: ReconcileMismatch[] = [];
  const unmatchedOtel: Array<{ sessionId: string; ordinal: number }> = [];
  const unmatchedLog: Array<{ sessionId: string; ordinal: number }> = [];
  let matched = 0;
  let maxDifference = 0;

  const sessions = [...new Set([...otelBySession.keys(), ...uniqueLog.keys()])].sort();
  for (const sessionId of sessions) {
    const o = otelBySession.get(sessionId) ?? [];
    const l = uniqueLog.get(sessionId) ?? [];
    for (let i = 0; i < Math.max(o.length, l.length); i++) {
      const ordinal = i + 1;
      const req = o[i];
      const call = l[i];
      if (req === undefined) {
        unmatchedLog.push({ sessionId, ordinal });
        continue;
      }
      if (call === undefined) {
        unmatchedOtel.push({ sessionId, ordinal });
        continue;
      }
      const otelSide: ReconcileSide = { model: req.model, tokens: req.tokens, cost: req.cost };
      const lt = logTokens(call);
      const priced = pricer.price(call.model, call.usage);
      const logSide: ReconcileSide = { model: call.model, tokens: lt, cost: priced.status === 'unpriced' ? null : priced.cost };
      const mismatch = (reason: ReconcileMismatch['reason']): void => {
        mismatches.push({ sessionId, ordinal, reason, otel: otelSide, log: logSide });
      };
      if (lt === null) mismatch('no-usage-in-log');
      else if (call.model !== req.model) mismatch('model-differs');
      else if (!sameTokens(lt, req.tokens)) mismatch('tokens-differ');
      else if (priced.status === 'unpriced') mismatch('unpriced');
      else {
        const diff = Math.abs(priced.cost - req.cost);
        maxDifference = Math.max(maxDifference, diff);
        if (diff <= TOLERANCE_NANO_USD) matched++;
        else mismatch('cost-differs');
      }
    }
  }

  return {
    otelRequests: otel.requests.length,
    matched,
    maxDifference: nanoUsd(maxDifference),
    mismatches,
    unmatchedOtel,
    unmatchedLog,
    unreadableLines: otel.unreadableLines,
  };
}
