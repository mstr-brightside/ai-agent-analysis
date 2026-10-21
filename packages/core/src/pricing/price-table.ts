// Public API list prices, in integer nano-USD per token ($1.00 per million tokens = 1000).
// Built once by hand from the vendors' official pricing pages; nothing is fetched at runtime.
// A model name that is not on an official page is left out on purpose and stays unpriced.
//
// Retrieved 2026-10-11:
// - Anthropic: https://platform.claude.com/docs/en/about-claude/pricing
//   (the current page lists no >200K long-context tier for Sonnet 4.5; Claude 4.6+ get 1M
//   context at standard rates, so no entry here carries an Anthropic long-context tier)
// - OpenAI: https://developers.openai.com/api/docs/pricing (Standard tier, text tokens)
//   gpt-5.5-codex is not on the page, and https://developers.openai.com/api/docs/models/gpt-5.5-codex
//   returns 404, so it stays unpriced.

export type RateSource = {
  readonly cacheWrite5m: number | null;
  readonly cacheWrite1h: number | null;
  readonly cacheRead: number;
  readonly input: number;
  readonly output: number;
};

export type PriceEntrySource = {
  readonly vendor: 'anthropic' | 'openai';
  readonly displayName: string;
  /** Exact model names as they appear in logs (after the `[1m]` suffix is stripped). */
  readonly modelNames: readonly string[];
  readonly rates: RateSource;
  /** Whole request priced at `rates` when its total input exceeds `aboveInputTokens`. */
  readonly longContext: { readonly aboveInputTokens: number; readonly rates: RateSource } | null;
  readonly sourceUrl: string;
  readonly retrieved: string;
};

export type PriceTableSource = Readonly<Record<string, PriceEntrySource>>;

const ANTHROPIC = 'https://platform.claude.com/docs/en/about-claude/pricing';
const OPENAI = 'https://developers.openai.com/api/docs/pricing';
const RETRIEVED = '2026-10-11';

export const PRICE_TABLE = {
  'claude-opus-4-1': {
    vendor: 'anthropic',
    displayName: 'Claude Opus 4.1',
    modelNames: ['claude-opus-4-1-20250805', 'claude-opus-4-1'],
    rates: { input: 15_000, cacheWrite5m: 18_750, cacheWrite1h: 30_000, cacheRead: 1_500, output: 75_000 },
    longContext: null,
    sourceUrl: ANTHROPIC,
    retrieved: RETRIEVED,
  },
  'claude-sonnet-4-5': {
    vendor: 'anthropic',
    displayName: 'Claude Sonnet 4.5',
    // `claude-4.5-sonnet` is Cursor's name for the same model.
    modelNames: ['claude-sonnet-4-5-20250929', 'claude-sonnet-4-5', 'claude-4.5-sonnet'],
    rates: { input: 3_000, cacheWrite5m: 3_750, cacheWrite1h: 6_000, cacheRead: 300, output: 15_000 },
    longContext: null,
    sourceUrl: ANTHROPIC,
    retrieved: RETRIEVED,
  },
  'claude-sonnet-5': {
    vendor: 'anthropic',
    displayName: 'Claude Sonnet 5',
    modelNames: ['claude-sonnet-5'],
    rates: { input: 2_000, cacheWrite5m: 2_500, cacheWrite1h: 4_000, cacheRead: 200, output: 10_000 },
    longContext: null,
    sourceUrl: ANTHROPIC,
    retrieved: RETRIEVED,
  },
  'claude-haiku-4-5': {
    vendor: 'anthropic',
    displayName: 'Claude Haiku 4.5',
    modelNames: ['claude-haiku-4-5-20251001', 'claude-haiku-4-5'],
    rates: { input: 1_000, cacheWrite5m: 1_250, cacheWrite1h: 2_000, cacheRead: 100, output: 5_000 },
    longContext: null,
    sourceUrl: ANTHROPIC,
    retrieved: RETRIEVED,
  },
  'gpt-5.5': {
    vendor: 'openai',
    displayName: 'GPT-5.5',
    modelNames: ['gpt-5.5'],
    rates: { input: 5_000, cacheWrite5m: null, cacheWrite1h: null, cacheRead: 500, output: 30_000 },
    // "Short context: ≤272K input tokens. Long context: >272K input tokens."
    longContext: {
      aboveInputTokens: 272_000,
      rates: { input: 10_000, cacheWrite5m: null, cacheWrite1h: null, cacheRead: 1_000, output: 45_000 },
    },
    sourceUrl: OPENAI,
    retrieved: RETRIEVED,
  },
  'gpt-5': {
    vendor: 'openai',
    displayName: 'GPT-5',
    modelNames: ['gpt-5'],
    rates: { input: 1_250, cacheWrite5m: null, cacheWrite1h: null, cacheRead: 125, output: 10_000 },
    longContext: null,
    sourceUrl: OPENAI,
    retrieved: RETRIEVED,
  },
  'gpt-5-mini': {
    vendor: 'openai',
    displayName: 'GPT-5 mini',
    modelNames: ['gpt-5-mini'],
    rates: { input: 250, cacheWrite5m: null, cacheWrite1h: null, cacheRead: 25, output: 2_000 },
    longContext: null,
    sourceUrl: OPENAI,
    retrieved: RETRIEVED,
  },
} as const satisfies PriceTableSource;
