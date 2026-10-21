// API response shapes, shared by the server and the page. No logic.
// Money is in US dollars here (the API edge); internally it is integer nano-USD.
// Every amount is an estimate at public API list prices, not an actual bill.
import { z } from 'zod';

export const SOURCES = ['claude', 'codex', 'cursor'] as const;
export const Source = z.enum(SOURCES);
export type Source = z.infer<typeof Source>;

export const CATEGORIES = ['plan', 'review', 'debug', 'test', 'refactor', 'ops', 'research', 'implement', 'unknown'] as const;
export const Category = z.enum(CATEGORIES);
export type Category = z.infer<typeof Category>;

export const DISPOSITIONS = ['processed', 'recognized-unused', 'duplicate', 'malformed', 'unknown'] as const;
export const Disposition = z.enum(DISPOSITIONS);
export type Disposition = z.infer<typeof Disposition>;

export const PRICED_STATUSES = ['complete', 'complete-no-cache-data', 'estimated'] as const;
export const PRICING_STATUSES = [...PRICED_STATUSES, 'unpriced'] as const;
export const PricingStatus = z.enum(PRICING_STATUSES);
export type PricingStatus = z.infer<typeof PricingStatus>;

export const PRICING_BASIS = 'estimated at public API list prices' as const;

const count = z.number().int().nonnegative();
const usd = z.number().nonnegative();

export const SourceRef = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('line'), file: z.string(), line: z.number().int().positive() }),
  z.object({ kind: z.literal('key'), key: z.string() }),
]);
export type SourceRef = z.infer<typeof SourceRef>;

export const Spend = z.object({
  totalUsd: usd,
  byStatusUsd: z.object({ complete: usd, 'complete-no-cache-data': usd, estimated: usd }),
  calls: z.object({ complete: count, 'complete-no-cache-data': count, estimated: count, unpriced: count }),
  /** Calls whose usage was already charged under the same message id. */
  repeatedUsageCalls: count,
  /** All tokens of unpriced calls. */
  unpricedTokens: count,
});
export type Spend = z.infer<typeof Spend>;

export const Tokens = z.object({ freshInput: count, cacheRead: count, cacheWrite: count, output: count });
export type Tokens = z.infer<typeof Tokens>;

export const SnapshotMeta = z.object({
  id: z.number().int().positive(),
  createdAt: z.string(),
  trigger: z.enum(['startup', 'refresh', 'cli']),
  classifierVersion: z.string(),
  pricingVersion: z.string(),
  /** Some source file or database could not be read on this ingest. */
  partial: z.boolean(),
  changes: z.object({
    newRecords: count,
    touchedSessions: count,
    versionChanged: z.boolean(),
    /** Files that were truncated or replaced and re-read in full (file names only). */
    rereadFiles: z.array(z.string()),
  }),
});
export type SnapshotMeta = z.infer<typeof SnapshotMeta>;

export const CategoryRow = z.object({
  category: Category,
  /** Sessions whose primary category this is. Sums to the session total. */
  sessions: count,
  /** Sessions with at least one turn in this category; a session can count in several. */
  sessionsTouching: count,
  turns: count,
  spend: Spend,
});
export type CategoryRow = z.infer<typeof CategoryRow>;

export const ModelRow = z.object({
  source: Source,
  model: z.string().nullable(),
  /** Price-table entry, or null when the model is unpriced. */
  priceKey: z.string().nullable(),
  displayName: z.string().nullable(),
  sessions: count,
  spend: Spend,
  tokens: Tokens,
});
export type ModelRow = z.infer<typeof ModelRow>;

export const SourceCoverage = z.object({
  source: Source,
  enabled: z.boolean(),
  /** The data is a generated fixture, not real logs. */
  synthetic: z.boolean(),
  records: z.object({
    processed: count,
    'recognized-unused': count,
    duplicate: count,
    malformed: count,
    unknown: count,
  }),
  blankLines: count,
  errors: z.array(z.object({ file: z.string(), message: z.string() })),
});
export type SourceCoverage = z.infer<typeof SourceCoverage>;

export const Attempt = z.object({
  callRef: SourceRef,
  resultRef: SourceRef.nullable(),
  outcome: z.enum(['success', 'failure', 'unknown']),
});

const SessionKey = {
  source: Source,
  sessionId: z.string(),
  project: z.string().nullable(),
  sessionSpendUsd: usd,
};

export const FailureStreak = z.object({
  ...SessionKey,
  tool: z.string(),
  /** Normalized target: command, file (project-relative) or search pattern. */
  target: z.string(),
  length: count,
  attempts: z.array(Attempt),
  turnIndexes: z.array(count),
  costDuringStreakUsd: usd,
});
export type FailureStreak = z.infer<typeof FailureStreak>;

export const CorrectionStreak = z.object({
  ...SessionKey,
  length: count,
  prompts: z.array(SourceRef),
  turnIndexes: z.array(count),
  costDuringStreakUsd: usd,
});
export type CorrectionStreak = z.infer<typeof CorrectionStreak>;

export const Ratio = z.object({ part: count, total: count });
export type Ratio = z.infer<typeof Ratio>;

/** How far the categories can be trusted. */
export const ClassifierCheck = z.object({
  /** Agreement with eval/heldout.csv: prompts in varied wording, never used to write the rules. Null when the file could not be read. */
  heldout: Ratio.nullable(),
  /** Agreement with eval/labels.csv: turns sampled from the fixtures, which the rules were written against. Null when those turns are not in the data. */
  labelledSample: Ratio.nullable(),
  /** How the turns of this data got their category. */
  turnsClassifiedBy: z.object({ promptRule: count, toolShape: count, unclassified: count }),
});
export type ClassifierCheck = z.infer<typeof ClassifierCheck>;

export const SummaryResponse = z.object({
  snapshot: SnapshotMeta,
  pricingBasis: z.literal(PRICING_BASIS),
  headline: z.object({
    spendUsd: usd,
    sessions: count,
    turns: count,
    /** Share of spend with pricing status `complete`; null when there is no spend. */
    fullyPricedShare: z.number().min(0).max(1).nullable(),
    /** malformed + unknown records over all records. */
    unparsedRecords: Ratio,
  }),
  spend: Spend,
  categories: z.array(CategoryRow),
  categoriesBySource: z.object({ claude: z.array(CategoryRow), codex: z.array(CategoryRow), cursor: z.array(CategoryRow) }),
  models: z.array(ModelRow),
  coverage: z.object({
    sources: z.array(SourceCoverage),
    unclassifiedTurns: Ratio,
    unclassifiedSessions: Ratio,
  }),
  waste: z.object({ failureStreaks: z.array(FailureStreak), correctionStreaks: z.array(CorrectionStreak) }),
  /** Null for snapshots stored before this was measured. */
  classifier: ClassifierCheck.nullable().default(null),
});
export type SummaryResponse = z.infer<typeof SummaryResponse>;

export const Turn = z.object({
  index: count,
  category: Category,
  ruleId: z.string(),
  matchedRuleIds: z.array(z.string()),
  /** Where the opening prompt is. The prompt text itself is never returned. */
  promptRef: SourceRef.nullable(),
  ackPrompts: count,
  correctionPrompts: count,
  toolCalls: count,
  modelCalls: count,
  spend: Spend,
});
export type Turn = z.infer<typeof Turn>;

export const Session = z.object({
  source: Source,
  sessionId: z.string(),
  project: z.string().nullable(),
  agentVersion: z.string().nullable(),
  firstTimestamp: z.string().nullable(),
  primaryCategory: Category,
  flagged: z.boolean(),
  spend: Spend,
  turns: z.array(Turn),
  models: z.array(ModelRow.omit({ source: true, sessions: true })),
  failureStreaks: z.array(FailureStreak),
  correctionStreaks: z.array(CorrectionStreak),
});
export type Session = z.infer<typeof Session>;

export const SessionsResponse = z.object({
  snapshot: SnapshotMeta,
  pricingBasis: z.literal(PRICING_BASIS),
  filters: z.object({ category: Category.nullable(), source: Source.nullable(), flagged: z.boolean().nullable() }),
  sessions: z.array(Session),
});
export type SessionsResponse = z.infer<typeof SessionsResponse>;

export const SnapshotsResponse = z.object({
  snapshots: z.array(SnapshotMeta.extend({ spendUsd: usd, sessions: count })),
});
export type SnapshotsResponse = z.infer<typeof SnapshotsResponse>;

export const IngestResponse = z.discriminatedUnion('status', [
  z.object({ status: z.literal('changed'), snapshot: SnapshotMeta, durationMs: z.number().nonnegative() }),
  z.object({
    status: z.literal('no-changes'),
    latestSnapshotId: z.number().int().positive().nullable(),
    partial: z.boolean(),
    errors: z.array(z.object({ file: z.string(), message: z.string() })),
    durationMs: z.number().nonnegative(),
  }),
]);
export type IngestResponse = z.infer<typeof IngestResponse>;

const OtelSide = z.object({
  model: z.string().nullable(),
  tokens: Tokens.nullable(),
  costUsd: usd.nullable(),
});

export const ReconciliationMismatch = z.object({
  sessionId: z.string(),
  /** 1-based position among the session's API requests, in file order. */
  ordinal: count,
  reason: z.enum(['tokens-differ', 'model-differs', 'no-usage-in-log', 'unpriced', 'cost-differs']),
  otel: OtelSide,
  log: OtelSide,
});
export type ReconciliationMismatch = z.infer<typeof ReconciliationMismatch>;

export const ReconciliationResponse = z.discriminatedUnion('status', [
  z.object({ status: z.literal('off'), reason: z.string() }),
  z.object({
    status: z.literal('on'),
    snapshotId: z.number().int().positive(),
    toleranceUsd: usd,
    /** Requests whose tokens agree and whose cost is within tolerance. */
    matched: count,
    /** OTel api_request events considered. */
    otelRequests: count,
    maxDifferenceUsd: usd,
    mismatches: z.array(ReconciliationMismatch),
    unmatchedOtel: z.array(z.object({ sessionId: z.string(), ordinal: count })),
    unmatchedLog: z.array(z.object({ sessionId: z.string(), ordinal: count })),
    /** OTel lines that could not be parsed. */
    unreadableLines: count,
  }),
]);
export type ReconciliationResponse = z.infer<typeof ReconciliationResponse>;

export const ErrorResponse = z.object({
  error: z.object({
    code: z.enum(['ingest-in-progress', 'not-found', 'bad-request', 'no-snapshot', 'internal']),
    message: z.string(),
  }),
});
export type ErrorResponse = z.infer<typeof ErrorResponse>;
