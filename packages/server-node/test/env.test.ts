import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { parseEnv } from '../src/env.ts';

function sandbox(): { base: string; env: Record<string, string> } {
  const base = mkdtempSync(path.join(tmpdir(), 'agentspend-env-'));
  mkdirSync(path.join(base, 'claude'));
  mkdirSync(path.join(base, 'codex'));
  writeFileSync(path.join(base, 'state.vscdb'), '');
  writeFileSync(path.join(base, 'otel.jsonl'), '');
  return {
    base,
    env: {
      CLAUDE_LOGS_DIR: './claude',
      CODEX_LOGS_DIR: './codex',
      CURSOR_DB_PATH: './state.vscdb',
      OTEL_EVENTS_PATH: './otel.jsonl',
      DATA_DIR: './data',
      HOST: '127.0.0.1',
      PORT: '4680',
    },
  };
}

function problems(env: Record<string, string | undefined>, base: string): string[] {
  const result = parseEnv(env, base);
  if (result.ok) assert.fail('expected the env to be refused');
  return result.error;
}

describe('env checker', () => {
  it('accepts a complete environment and resolves paths', () => {
    const { base, env } = sandbox();
    const result = parseEnv(env, base);
    assert.ok(result.ok);
    assert.equal(result.value.claudeLogsDir, path.join(base, 'claude'));
    assert.equal(result.value.port, 4680);
    assert.equal(result.value.host, '127.0.0.1');
  });

  it('refuses a missing variable and names it', () => {
    const { base, env } = sandbox();
    const { CODEX_LOGS_DIR: _omitted, ...rest } = env;
    assert.deepEqual(problems(rest, base), ['CODEX_LOGS_DIR: is not declared']);
  });

  it('lists every invalid variable at once', () => {
    const { base, env } = sandbox();
    const found = problems({ ...env, HOST: undefined, PORT: '70000' }, base);
    assert.equal(found.length, 2);
    assert.ok(found.some((p) => p.startsWith('HOST: is not declared')));
    assert.ok(found.some((p) => p.startsWith('PORT: must be from 1 to 65535')));
  });

  it('lists path problems together with schema problems', () => {
    const { base, env } = sandbox();
    const found = problems({ ...env, HOST: '0.0.0.0', CLAUDE_LOGS_DIR: './nope' }, base);
    assert.equal(found.length, 2);
    assert.ok(found.some((p) => p.startsWith('HOST:')));
    assert.ok(found.some((p) => p.startsWith('CLAUDE_LOGS_DIR: path does not exist')));
  });

  it('refuses a non-loopback HOST', () => {
    const { base, env } = sandbox();
    const found = problems({ ...env, HOST: '0.0.0.0' }, base);
    assert.deepEqual(found, ['HOST: must be a loopback address (127.0.0.1, ::1, localhost); got "0.0.0.0"']);
  });

  it('refuses a non-integer PORT', () => {
    const { base, env } = sandbox();
    assert.deepEqual(problems({ ...env, PORT: '46.8' }, base), ['PORT: must be an integer from 1 to 65535']);
  });

  it('refuses a source path that does not exist', () => {
    const { base, env } = sandbox();
    const found = problems({ ...env, CLAUDE_LOGS_DIR: './nope' }, base);
    assert.deepEqual(found, [`CLAUDE_LOGS_DIR: path does not exist: ${path.join(base, 'nope')}`]);
  });

  it('refuses a file where a directory is expected, and the reverse', () => {
    const { base, env } = sandbox();
    const found = problems({ ...env, CODEX_LOGS_DIR: './state.vscdb', CURSOR_DB_PATH: './claude' }, base);
    assert.deepEqual(found, [
      `CODEX_LOGS_DIR: not a directory: ${path.join(base, 'state.vscdb')}`,
      `CURSOR_DB_PATH: not a file: ${path.join(base, 'claude')}`,
    ]);
  });

  it('treats an empty source path as deliberately off', () => {
    const { base, env } = sandbox();
    const result = parseEnv({ ...env, CODEX_LOGS_DIR: '', CURSOR_DB_PATH: '' }, base);
    assert.ok(result.ok);
    assert.equal(result.value.codexLogsDir, null);
    assert.equal(result.value.cursorDbPath, null);
  });

  it('refuses when all sources are off', () => {
    const { base, env } = sandbox();
    const found = problems({ ...env, CLAUDE_LOGS_DIR: '', CODEX_LOGS_DIR: '', CURSOR_DB_PATH: '' }, base);
    assert.equal(found.length, 1);
    assert.match(found[0] ?? '', /all sources are off/);
  });

  it('does not count the OTel file as a source', () => {
    const { base, env } = sandbox();
    const found = problems(
      { ...env, CLAUDE_LOGS_DIR: '', CODEX_LOGS_DIR: '', CURSOR_DB_PATH: '', OTEL_EVENTS_PATH: './otel.jsonl' },
      base,
    );
    assert.match(found[0] ?? '', /all sources are off/);
  });

  it('allows the OTel file to be off', () => {
    const { base, env } = sandbox();
    const result = parseEnv({ ...env, OTEL_EVENTS_PATH: '' }, base);
    assert.ok(result.ok);
    assert.equal(result.value.otelEventsPath, null);
  });
});
