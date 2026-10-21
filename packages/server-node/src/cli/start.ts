// npm start: ingest, then serve the API and the page on a loopback address.
import { createRequire } from 'node:module';
import path from 'node:path';
import { Store, StoreError } from '@agentspend/store';
import { loadConfigOrExit } from '../env.ts';
import { startServer } from '../http.ts';
import { ingest } from '../ingest.ts';

const root = path.resolve(import.meta.dirname, '../../../..');
const config = loadConfigOrExit(root);

let store: Store;
try {
  store = Store.open(config.dataDir);
} catch (e) {
  process.stderr.write(`${e instanceof StoreError ? e.message : String(e)}\n`);
  process.exit(1);
}

const result = ingest(store, config, 'startup');
if (result.status === 'changed') {
  const c = result.snapshot.changes;
  process.stdout.write(`Ingest: snapshot ${result.snapshot.id}, ${c.newRecords} new records, ${result.durationMs.toFixed(0)} ms${result.snapshot.partial ? ' (partial: some sources could not be read)' : ''}.\n`);
} else {
  process.stdout.write(`Ingest: no changes, ${result.durationMs.toFixed(0)} ms${result.partial ? ' (partial)' : ''}.\n`);
  for (const e of result.errors) process.stdout.write(`  error: ${e.file}: ${e.message}\n`);
}

const zodRoot = path.dirname(createRequire(import.meta.url).resolve('zod/package.json'));
const host = config.host === '::1' ? '[::1]' : config.host;
try {
  await startServer({
    store,
    sources: config,
    host: config.host,
    port: config.port,
    webRoot: path.join(root, 'packages/web-plain'),
    zodRoot,
    development: process.argv.includes('--dev'),
  });
} catch (e) {
  const inUse = e instanceof Error && 'code' in e && e.code === 'EADDRINUSE';
  process.stderr.write(inUse ? `Port ${config.port} is already in use; set PORT in .env.\n` : `Cannot start the server: ${String(e)}\n`);
  store.close();
  process.exit(1);
}
process.stdout.write(`Serving http://${host}:${config.port}/ (local only)\n`);
