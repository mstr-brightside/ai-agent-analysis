import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { SCHEMA_VERSION, Store, StoreError } from '../src/store.ts';

const dir = (): string => mkdtempSync(path.join(tmpdir(), 'agentspend-store-'));

describe('store', () => {
  it('creates and migrates a new database, and reopens it', () => {
    const d = dir();
    Store.open(d).close();
    const db = new DatabaseSync(path.join(d, 'agentspend.sqlite'));
    assert.equal(db.prepare('PRAGMA user_version').get()?.['user_version'], SCHEMA_VERSION);
    db.close();
    Store.open(d).close();
  });

  it('refuses a database written by newer code', () => {
    const d = dir();
    Store.open(d).close();
    const db = new DatabaseSync(path.join(d, 'agentspend.sqlite'));
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    db.close();
    assert.throws(() => Store.open(d), (e: unknown) => e instanceof StoreError && /written by newer code/.test(e.message));
  });

  it('reports a corrupt database instead of recreating it', () => {
    const d = dir();
    const file = path.join(d, 'agentspend.sqlite');
    writeFileSync(file, 'this is not a database, it is a grocery list');
    assert.throws(() => Store.open(d), (e: unknown) => e instanceof StoreError && /not recreated automatically/.test(e.message));
  });

  it('rolls a transaction back on error', () => {
    const store = Store.open(dir());
    assert.throws(() =>
      store.transaction(() => {
        store.setMeta('k', 'v');
        throw new Error('boom');
      }),
    );
    assert.equal(store.getMeta('k'), null);
    store.close();
  });

  it('fills session metadata gaps but never overwrites', () => {
    const store = Store.open(dir());
    store.upsertSession('cursor', 's', { projectPath: null, agentVersion: null });
    store.upsertSession('cursor', 's', { projectPath: '/w/a', agentVersion: null });
    store.upsertSession('cursor', 's', { projectPath: '/w/b', agentVersion: '1' });
    assert.deepEqual(store.loadSession('cursor', 's').info, { projectPath: '/w/a', agentVersion: '1' });
    store.close();
  });
});
