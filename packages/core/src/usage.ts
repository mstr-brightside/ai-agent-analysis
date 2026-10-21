import type { TokenCount } from './units.ts';

/** Cache token counts as the source reported them. */
export type CacheUsage = {
  readonly read: TokenCount;
  readonly write5m: TokenCount;
  readonly write1h: TokenCount;
};

/**
 * Token usage of one model call, normalized. `freshInput` excludes cache reads and
 * writes (Anthropic semantics); adapters for formats where cached tokens are a subset
 * of input (OpenAI) subtract them before building this.
 */
export type Usage = {
  readonly freshInput: TokenCount;
  readonly output: TokenCount;
  /** null: the format does not report cache usage at all (e.g. Claude Code CLI 1.0.83). */
  readonly cache: CacheUsage | null;
  /** Set when the adapter had to interpret inconsistent source numbers. */
  readonly estimate: UsageEstimate | null;
};

export type UsageEstimate = 'cached-exceeds-input';
