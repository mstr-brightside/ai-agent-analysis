// zod schemas for what the store reads back from SQLite. Stored JSON is external input
// like any other: it is parsed, never cast. Transforms re-create the branded core types.
import { z } from 'zod';
import {
  CATEGORIES,
  nanoUsd,
  tokenCount,
  type SessionAnalysis,
  type SessionEvent,
  type SourceRef as CoreSourceRef,
  type Spend as CoreSpend,
} from '@agentspend/core';

const tokens = z.number().int().nonnegative().transform(tokenCount);
const money = z.number().int().transform(nanoUsd);

export const SourceKindSchema = z.enum(['claude', 'codex', 'cursor']);

export const SourceRefSchema: z.ZodType<CoreSourceRef> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('line'), file: z.string(), line: z.number().int() }),
  z.object({ kind: z.literal('key'), key: z.string() }),
]);

const UsageSchema = z.object({
  freshInput: tokens,
  output: tokens,
  cache: z.object({ read: tokens, write5m: tokens, write1h: tokens }).nullable(),
  estimate: z.literal('cached-exceeds-input').nullable(),
});

const common = { ref: SourceRefSchema, timestamp: z.string().nullable() };

export const SessionEventSchema: z.ZodType<SessionEvent> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('prompt'), ...common, text: z.string() }),
  z.object({
    type: z.literal('model-call'),
    ...common,
    messageId: z.string().nullable(),
    model: z.string().nullable(),
    usage: UsageSchema.nullable(),
    sidechain: z.boolean(),
  }),
  z.object({
    type: z.literal('tool-call'),
    ...common,
    callId: z.string(),
    tool: z.string(),
    toolKind: z.enum(['read', 'search', 'edit', 'write', 'shell', 'other']),
    target: z.string().nullable(),
  }),
  z.object({ type: z.literal('tool-result'), ...common, callId: z.string(), outcome: z.enum(['success', 'failure', 'unknown']) }),
]);

const SpendSchema: z.ZodType<CoreSpend> = z.object({
  total: money,
  byStatus: z.object({ complete: money, 'complete-no-cache-data': money, estimated: money }),
  calls: z.object({
    complete: z.number().int(),
    'complete-no-cache-data': z.number().int(),
    estimated: z.number().int(),
    unpriced: z.number().int(),
  }),
  repeatedUsageCalls: z.number().int(),
  unpricedTokens: tokens,
});

const CategorySchema = z.enum(CATEGORIES);
const TotalsSchema = z.object({ freshInput: tokens, cacheRead: tokens, cacheWrite: tokens, output: tokens });
const AttemptSchema = z.object({
  callRef: SourceRefSchema,
  resultRef: SourceRefSchema.nullable(),
  outcome: z.enum(['success', 'failure', 'unknown']),
});

export const SessionAnalysisSchema: z.ZodType<SessionAnalysis> = z.object({
  source: SourceKindSchema,
  sessionId: z.string(),
  project: z.string().nullable(),
  agentVersion: z.string().nullable(),
  firstTimestamp: z.string().nullable(),
  primaryCategory: CategorySchema,
  spend: SpendSchema,
  turns: z.array(
    z.object({
      index: z.number().int(),
      category: CategorySchema,
      ruleId: z.string(),
      matchedRuleIds: z.array(z.string()),
      promptRef: SourceRefSchema.nullable(),
      ackPrompts: z.number().int(),
      correctionPrompts: z.number().int(),
      toolCalls: z.number().int(),
      modelCalls: z.number().int(),
      spend: SpendSchema,
    }),
  ),
  models: z.array(z.object({ model: z.string().nullable(), priceKey: z.string().nullable(), spend: SpendSchema, tokens: TotalsSchema })),
  failureStreaks: z.array(
    z.object({
      tool: z.string(),
      target: z.string(),
      length: z.number().int(),
      attempts: z.array(AttemptSchema),
      turnIndexes: z.array(z.number().int()),
      costDuringStreak: money,
    }),
  ),
  correctionStreaks: z.array(
    z.object({
      length: z.number().int(),
      prompts: z.array(SourceRefSchema),
      turnIndexes: z.array(z.number().int()),
      costDuringStreak: money,
    }),
  ),
});
