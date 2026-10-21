// Environment checker. Every variable must be declared; an empty source path turns
// that source off on purpose; anything invalid stops startup with every problem listed.
// The application never runs with a half-resolved configuration.
import { accessSync, constants, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { err, ok, type Result } from '@agentspend/core';

export const LOOPBACK_HOSTS = ['127.0.0.1', '::1', 'localhost'] as const;
export type LoopbackHost = (typeof LOOPBACK_HOSTS)[number];

export type Config = {
  readonly claudeLogsDir: string | null;
  readonly codexLogsDir: string | null;
  readonly cursorDbPath: string | null;
  readonly otelEventsPath: string | null;
  /** Hand labels for the classifier check. Not an env variable: always `eval/` in the repo. */
  readonly evalDir: string;
  readonly dataDir: string;
  readonly host: LoopbackHost;
  readonly port: number;
};

const declared = z.string({
  error: (issue) => (issue.input === undefined ? 'is not declared' : 'must be a string'),
});

const envSchema = z.object({
  CLAUDE_LOGS_DIR: declared,
  CODEX_LOGS_DIR: declared,
  CURSOR_DB_PATH: declared,
  OTEL_EVENTS_PATH: declared,
  DATA_DIR: declared.min(1, 'must not be empty'),
  HOST: declared.pipe(
    z.enum(LOOPBACK_HOSTS, {
      error: (issue) =>
        `must be a loopback address (${LOOPBACK_HOSTS.join(', ')}); got "${String(issue.input)}"`,
    }),
  ),
  PORT: declared
    .regex(/^\d+$/, 'must be an integer from 1 to 65535')
    .transform(Number)
    .pipe(z.number().int().min(1, 'must be from 1 to 65535').max(65535, 'must be from 1 to 65535')),
});

type PathKind = 'directory' | 'file';

/** Returns a problem description, or null when the path is usable. */
function checkPath(absolute: string, kind: PathKind): string | null {
  let stat;
  try {
    stat = statSync(absolute);
  } catch {
    return `path does not exist: ${absolute}`;
  }
  if (kind === 'directory' && !stat.isDirectory()) return `not a directory: ${absolute}`;
  if (kind === 'file' && !stat.isFile()) return `not a file: ${absolute}`;
  try {
    accessSync(absolute, constants.R_OK);
  } catch {
    return `not readable: ${absolute}`;
  }
  return null;
}

/**
 * Validates the environment. Paths resolve against `baseDir`. Has no side effects;
 * `prepareDataDir` creates DATA_DIR afterwards.
 */
export function parseEnv(raw: Readonly<Record<string, string | undefined>>, baseDir: string): Result<Config, string[]> {
  // Schema problems and path problems are collected together, so one run lists everything.
  const parsed = envSchema.safeParse(raw);
  const problems: string[] = parsed.success ? [] : parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);

  /** Absolute path, null when deliberately off (empty) or not declared (already reported). */
  const optionalPath = (name: string, kind: PathKind): string | null => {
    const value = raw[name];
    if (value === undefined || value.trim() === '') return null;
    const absolute = path.resolve(baseDir, value);
    const problem = checkPath(absolute, kind);
    if (problem !== null) problems.push(`${name}: ${problem}`);
    return absolute;
  };

  const claudeLogsDir = optionalPath('CLAUDE_LOGS_DIR', 'directory');
  const codexLogsDir = optionalPath('CODEX_LOGS_DIR', 'directory');
  const cursorDbPath = optionalPath('CURSOR_DB_PATH', 'file');
  const otelEventsPath = optionalPath('OTEL_EVENTS_PATH', 'file');

  const sourceVars = ['CLAUDE_LOGS_DIR', 'CODEX_LOGS_DIR', 'CURSOR_DB_PATH'];
  if (sourceVars.every((name) => raw[name]?.trim() === '')) {
    problems.push(`${sourceVars.join(', ')}: all sources are off (empty); at least one must be set`);
  }

  const dataDirRaw = raw['DATA_DIR'];
  const dataDir = path.resolve(baseDir, dataDirRaw ?? '');
  if (dataDirRaw !== undefined && dataDirRaw !== '') {
    try {
      if (!statSync(dataDir).isDirectory()) problems.push(`DATA_DIR: not a directory: ${dataDir}`);
    } catch {
      // Missing is fine: it is created at startup.
    }
  }

  if (!parsed.success || problems.length > 0) return err(problems);
  const env = parsed.data;
  const evalDir = path.join(baseDir, 'eval');
  return ok({ claudeLogsDir, codexLogsDir, cursorDbPath, otelEventsPath, evalDir, dataDir, host: env.HOST, port: env.PORT });
}

export function prepareDataDir(config: Config): Result<string, string> {
  try {
    mkdirSync(config.dataDir, { recursive: true });
    accessSync(config.dataDir, constants.R_OK | constants.W_OK);
    return ok(config.dataDir);
  } catch (e) {
    return err(`DATA_DIR: cannot create or write ${config.dataDir}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Loads `.env` from `baseDir` into process.env (when present), validates, and prepares
 * DATA_DIR. On any problem prints every message and exits: the app never starts half-configured.
 */
export function loadConfigOrExit(baseDir: string): Config {
  const envFile = path.join(baseDir, '.env');
  try {
    process.loadEnvFile(envFile);
  } catch (e) {
    const missing = e instanceof Error && 'code' in e && e.code === 'ENOENT';
    if (!missing) {
      fail([`.env: cannot read ${envFile}: ${e instanceof Error ? e.message : String(e)}`]);
    }
    // No .env file: the variables may come from the real environment. Missing ones are reported below.
  }
  const result = parseEnv(process.env, baseDir);
  if (!result.ok) {
    const hint = result.error.some((p) => p.endsWith('is not declared'))
      ? ['Copy .env.example to .env and adjust it. Every variable must be declared; leave a source path empty to turn that source off.']
      : [];
    fail([...result.error, ...hint]);
  }
  const dataDir = prepareDataDir(result.value);
  if (!dataDir.ok) fail([dataDir.error]);
  return result.value;
}

function fail(problems: readonly string[]): never {
  process.stderr.write(`Configuration is invalid; refusing to start.\n${problems.map((p) => `  - ${p}`).join('\n')}\n`);
  process.exit(1);
}
