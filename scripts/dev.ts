import { spawn, type ChildProcess } from 'node:child_process';
import { watch } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const tsc = path.join(root, 'node_modules/typescript/bin/tsc');
let server: ChildProcess | undefined;
let compiler: ChildProcess | undefined;
let timer: NodeJS.Timeout | undefined;
const state = { building: false, pending: false, stopping: false };

// These flags can change in watcher and signal callbacks across an await.
const isStopping = (): boolean => state.stopping;
const hasPending = (): boolean => state.pending;

function exited(child: ChildProcess): Promise<number> {
  return new Promise((resolve) => {
    child.once('error', (error) => {
      process.stderr.write(`${error.message}\n`);
      resolve(1);
    });
    child.once('exit', (code) => { resolve(code ?? 1); });
  });
}

async function rebuild(): Promise<void> {
  if (isStopping()) return;
  if (state.building) {
    state.pending = true;
    return;
  }
  state.building = true;
  do {
    state.pending = false;
    process.stdout.write('Dev: building page…\n');
    compiler = spawn(process.execPath, [tsc, '-p', 'packages/web-plain/tsconfig.build.json', '--noEmitOnError'], { cwd: root, stdio: 'inherit' });
    const code = await exited(compiler);
    compiler = undefined;
    if (isStopping()) break;
    if (code !== 0) {
      process.stderr.write('Dev: build failed; fix the errors and save to retry.\n');
      continue;
    }
    if (hasPending()) continue;
    if (server !== undefined && server.exitCode === null && server.signalCode === null) {
      const closed = exited(server);
      server.kill();
      await closed;
    }
    if (isStopping()) break;
    process.stdout.write('Dev: starting server; browser will reload.\n');
    server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'packages/server-node/src/cli/start.ts', '--dev'], { cwd: root, stdio: 'inherit' });
    server.on('error', (error) => { process.stderr.write(`${error.message}\n`); });
  } while (hasPending() && !isStopping());
  state.building = false;
}

function schedule(): void {
  if (state.stopping) return;
  // Mark an in-flight build stale immediately, before the debounce expires.
  if (state.building) state.pending = true;
  clearTimeout(timer);
  timer = setTimeout(() => { void rebuild(); }, 150);
}

const packagesWatcher = watch(path.join(root, 'packages'), { recursive: true }, (_event, filename) => {
  if (filename === null) return;
  const parts = filename.split(/[\\/]/);
  if (parts.some((part) => ['dist', 'node_modules', 'test'].includes(part))) return;
  if (/\.(ts|css|html|json)$/.test(filename)) schedule();
});
const rootWatcher = watch(root, (_event, filename) => {
  if (filename !== null && ['.env', 'tsconfig.base.json', 'package.json'].includes(filename)) schedule();
});

function stop(): void {
  state.stopping = true;
  clearTimeout(timer);
  packagesWatcher.close();
  rootWatcher.close();
  compiler?.kill();
  server?.kill();
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);
process.on('exit', stop);
process.stdout.write('Dev: watching packages, .env, and build settings. Press Ctrl+C to stop.\n');
await rebuild();
