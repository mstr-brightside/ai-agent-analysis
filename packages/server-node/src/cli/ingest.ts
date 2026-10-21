// npm run ingest: read new data, then print the latest summary as JSON (stdout).
// Progress and errors go to stderr so stdout stays machine-readable.
import path from 'node:path';
import { Store, StoreError } from '@agentspend/store';
import { loadConfigOrExit } from '../env.ts';
import { ingest } from '../ingest.ts';
import { summaryResponse } from '../read.ts';

const root = path.resolve(import.meta.dirname, '../../../..');
const config = loadConfigOrExit(root);

let store: Store;
try {
  store = Store.open(config.dataDir);
} catch (e) {
  process.stderr.write(`${e instanceof StoreError ? e.message : String(e)}\n`);
  process.exit(1);
}

try {
  const result = ingest(store, config, 'cli');
  const took = `${result.durationMs.toFixed(1)} ms`;
  if (result.status === 'changed') {
    const c = result.snapshot.changes;
    process.stderr.write(
      `Ingest: snapshot ${result.snapshot.id}, ${c.newRecords} new records, ${c.touchedSessions} sessions recomputed${c.versionChanged ? ' (classifier or pricing changed)' : ''}, ${took}${result.snapshot.partial ? ', PARTIAL' : ''}.\n`,
    );
  } else {
    process.stderr.write(`Ingest: no changes (latest snapshot ${String(result.latestSnapshotId)}), ${took}${result.partial ? ', PARTIAL' : ''}.\n`);
  }
  for (const e of result.status === 'no-changes' ? result.errors : []) process.stderr.write(`  error: ${e.file}: ${e.message}\n`);
  const latest = store.snapshot(null);
  if (latest !== null) process.stdout.write(`${JSON.stringify(summaryResponse(latest), null, 2)}\n`);
} finally {
  store.close();
}
