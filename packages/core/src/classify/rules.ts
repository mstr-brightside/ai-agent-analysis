// Classifier rules. Data only (ids + patterns), so the classifier version is a content
// hash of this file's values: change a rule and every session is recomputed.

export type Category = 'plan' | 'research' | 'implement' | 'debug' | 'test' | 'refactor' | 'review' | 'ops' | 'unknown';

/** Priority order: the most specific category wins; `implement` is the catch-all for build requests. */
export const CATEGORY_PRIORITY = [
  'plan',
  'review',
  'debug',
  'test',
  'refactor',
  'ops',
  'research',
  'implement',
] as const satisfies readonly Exclude<Category, 'unknown'>[];

export const CATEGORIES = [...CATEGORY_PRIORITY, 'unknown'] as const satisfies readonly Category[];

export type PromptRule = {
  readonly id: string;
  readonly category: Exclude<Category, 'unknown'>;
  readonly pattern: RegExp;
};

// Kept in priority order. Every pattern is case-insensitive and matched against the
// opening intent prompt of a turn only (acks and corrections never classify a turn).
export const PROMPT_RULES: readonly PromptRule[] = [
  {
    id: 'plan.ask-for-plan',
    category: 'plan',
    pattern: /\b(give me|make|draft|write( up)?) an? (short |rough |step-by-step )?(plan|spec|design( doc)?|proposal|rfc)\b/i,
  },
  { id: 'plan.spec-for', category: 'plan', pattern: /\b(plan|spec|design) for\b/i },
  {
    id: 'plan.no-code-yet',
    category: 'plan',
    pattern: /\b(before (writing|you write|we write) (any )?code|don'?t (write )?code yet|do not (write )?code yet|no code yet)\b/i,
  },
  {
    id: 'plan.scope',
    category: 'plan',
    pattern: /\b(let'?s scope|scope (out|this|it)|smallest steps|break (this|it) (down|into steps)|acceptance criteria|non-goals)\b/i,
  },

  {
    id: 'review.ready-to-ship',
    category: 'review',
    pattern: /\b(good enough to (ship|merge)|ready to (ship|merge)|safe to (ship|merge|deploy))\b/i,
  },
  { id: 'review.review', category: 'review', pattern: /\b(review|audit|what would you block)\b/i },
  {
    id: 'review.look-for-risks',
    category: 'review',
    pattern: /\b(look (at|over|through)|check|go through)\b.{0,80}\bfor (anything|issues|problems|bugs|risks|race conditions)\b/i,
  },

  {
    id: 'debug.investigate',
    category: 'debug',
    pattern: /\b(investigate|find the (cause|bug|problem)|root cause|track down|diagnose)\b/i,
  },
  {
    id: 'debug.wrong-behaviour',
    category: 'debug',
    pattern: /\bwhy (does|is|do|did)\b.{0,80}\b(wrong|fail|fails|failing|crash|crashes|break|breaks|error|slow|hang)/i,
  },
  {
    id: 'debug.error-report',
    category: 'debug',
    pattern: /(\b\w*(error|exception)\b:|\bpanic:|\btraceback\b|\b(fails?|failing|crash(es|ing)?) with\b)/i,
  },
  { id: 'debug.fix-bug', category: 'debug', pattern: /\bfix (the|this|a|that) (bug|crash|error|failure|issue|regression)\b/i },

  {
    id: 'test.write-tests',
    category: 'test',
    pattern: /\b(write|add|create)\s+(\S+\s+){0,3}?(unit |integration |regression |e2e |end-to-end |table-driven |property )?tests?\b/i,
  },
  { id: 'test.coverage', category: 'test', pattern: /\b(test )?coverage\b/i },

  {
    id: 'refactor.explicit',
    category: 'refactor',
    pattern: /\b(refactor|restructure|clean ?up|deduplicate|remove (the )?duplication|no behaviou?r change)\b/i,
  },
  {
    id: 'refactor.move-code',
    category: 'refactor',
    pattern: /\b(extract|rename|split|inline)\b.{0,80}\b(into|across|out of)\b/i,
  },

  {
    id: 'ops.infrastructure',
    category: 'ops',
    pattern: /\b(dockerfile|docker|docker-compose|github actions|gitlab ci|ci pipeline|ci job|workflow|deploy(ment)?|kubernetes|k8s|helm|terraform|makefile|pre-commit hook)\b/i,
  },
  { id: 'ops.ci', category: 'ops', pattern: /\bci\b/i },

  {
    id: 'research.how-it-works',
    category: 'research',
    pattern: /\b(how (does|do|is)|explain|walk me through|where (is|are|does)|what does|point me (at|to))\b/i,
  },
  {
    id: 'research.compare',
    category: 'research',
    pattern: /\b(trade-?offs?|pros and cons|compare|comparison|difference between)\b/i,
  },

  {
    id: 'implement.build',
    category: 'implement',
    pattern: /\b(implement|add|create|build|introduce|support|write|make)\b/i,
  },
];

/** Shell commands that run a test suite, for the tool-shape fallback. */
export const TEST_COMMAND_PATTERN =
  /(^|[\s;&|(])(pytest|jest|vitest|mocha|go test|cargo test|npm (run )?test|pnpm (run )?test|yarn test|bun test|make test|rspec|phpunit|dotnet test|node --test)\b/i;

/** Tool-shape fallback rule ids, used only when no prompt rule matches. */
export const TOOL_RULES = {
  readOnly: 'tools.read-only',
  mostlyEdits: 'tools.mostly-edits',
  mostlyTests: 'tools.mostly-tests',
} as const;

export const NO_MATCH_RULE = 'none';
export const NO_PROMPT_RULE = 'no-prompt';
