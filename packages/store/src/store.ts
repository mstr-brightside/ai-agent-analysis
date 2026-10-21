// Local SQLite store (node:sqlite). Holds normalized events (prompt text included: it
// stays on this machine), per-session analyses, read cursors and snapshots.
//
// Schema changes are numbered migrations applied at startup. A database written by newer
// code is refused, and a database that cannot be opened is reported: snapshots are not
// reproducible, so the store is never wiped or recreated silently.
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import path from 'node:path';
import { z } from 'zod';
import {
  DISPOSITIONS,
  type Disposition,
  type ModelCallEvent,
  type SessionAnalysis,
  type SessionEvent,
  type SessionInfo,
  type SessionInput,
  type SourceKind,
  type SourceRecord,
} from '@agentspend/core';
import { SessionAnalysisSchema, SessionEventSchema, SourceKindSchema } from './schemas.ts';

const MIGRATIONS: readonly string[] = [
  // 1: initial schema
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE jsonl_files (
    source TEXT NOT NULL,
    path TEXT NOT NULL,
    cursor TEXT NOT NULL,
    blank_lines INTEGER NOT NULL,
    PRIMARY KEY (source, path)
  );
  CREATE TABLE cursor_keys (key TEXT PRIMARY KEY, hash TEXT NOT NULL);
  CREATE TABLE records (
    id INTEGER PRIMARY KEY,
    source TEXT NOT NULL,
    native_id TEXT NOT NULL,
    ref TEXT NOT NULL,
    disposition TEXT NOT NULL,
    session_id TEXT,
    detail TEXT
  );
  CREATE INDEX records_native ON records (source, native_id);
  CREATE TABLE events (
    record_id INTEGER NOT NULL REFERENCES records (id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    source TEXT NOT NULL,
    session_id TEXT NOT NULL,
    type TEXT NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (record_id, position)
  );
  CREATE INDEX events_session ON events (source, session_id, record_id, position);
  CREATE TABLE sessions (
    source TEXT NOT NULL,
    session_id TEXT NOT NULL,
    project_path TEXT,
    agent_version TEXT,
    PRIMARY KEY (source, session_id)
  );
  CREATE TABLE analyses (
    source TEXT NOT NULL,
    session_id TEXT NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (source, session_id)
  );
  CREATE TABLE source_status (
    source TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL,
    synthetic INTEGER NOT NULL,
    errors TEXT NOT NULL
  );
  CREATE TABLE snapshots (
    id INTEGER PRIMARY KEY,
    created_at TEXT NOT NULL,
    meta TEXT NOT NULL,
    summary TEXT NOT NULL,
    sessions TEXT NOT NULL,
    reconciliation TEXT NOT NULL
  );
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

export class StoreError extends Error {}

const Count = z.object({ n: z.number().int() });
const MetaRow = z.object({ value: z.string() });
const DataRow = z.object({ data: z.string() });
const SessionRow = z.object({ project_path: z.string().nullable(), agent_version: z.string().nullable() });
const SessionKeyRow = z.object({ source: SourceKindSchema, session_id: z.string() });
const DispositionRow = z.object({ source: SourceKindSchema, disposition: z.enum(DISPOSITIONS), n: z.number().int() });
const StatusRow = z.object({ source: SourceKindSchema, enabled: z.number().int(), synthetic: z.number().int(), errors: z.string() });
const FileErrors = z.array(z.object({ file: z.string(), message: z.string() }));
const SnapshotRow = z.object({
  id: z.number().int(),
  created_at: z.string(),
  meta: z.string(),
  summary: z.string(),
  sessions: z.string(),
  reconciliation: z.string(),
});
const RecordRow = z.object({ id: z.number().int() });

export type SourceStatus = {
  readonly source: SourceKind;
  readonly enabled: boolean;
  readonly synthetic: boolean;
  readonly blankLines: number;
  readonly errors: ReadonlyArray<{ readonly file: string; readonly message: string }>;
};

/** Snapshot payloads are opaque JSON to the store; the server validates them against the API contract. */
export type StoredSnapshot = {
  readonly id: number;
  readonly createdAt: string;
  readonly meta: unknown;
  readonly summary: unknown;
  readonly sessions: unknown;
  readonly reconciliation: unknown;
};

function json(text: string): unknown {
  return JSON.parse(text);
}

export class Store {
  private readonly db: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();

  private constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** Opens (or creates) `<dataDir>/agentspend.sqlite` and applies pending migrations. */
  static open(dataDir: string): Store {
    return Store.openFile(path.join(dataDir, 'agentspend.sqlite'));
  }

  static openFile(file: string): Store {
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(file);
      db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    } catch (e) {
      throw new StoreError(`Cannot open the local store at ${file}: ${e instanceof Error ? e.message : String(e)}. It is not recreated automatically; move it aside if you want a fresh one.`);
    }
    const store = new Store(db);
    try {
      store.migrate(file);
    } catch (e) {
      db.close();
      throw e;
    }
    return store;
  }

  private migrate(file: string): void {
    let version: number;
    try {
      version = z.object({ user_version: z.number().int() }).parse(this.db.prepare('PRAGMA user_version').get()).user_version;
    } catch (e) {
      throw new StoreError(`The local store at ${file} is not a readable SQLite database (${e instanceof Error ? e.message : String(e)}). It is not recreated automatically.`);
    }
    if (version > SCHEMA_VERSION) {
      throw new StoreError(
        `The local store at ${file} was written by newer code (schema ${version}, this code knows up to ${SCHEMA_VERSION}). Refusing to start rather than risk losing snapshots.`,
      );
    }
    for (let v = version; v < SCHEMA_VERSION; v++) {
      const sql = MIGRATIONS[v];
      if (sql === undefined) throw new StoreError(`missing migration ${v + 1}`);
      this.transaction(() => {
        this.db.exec(sql);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
  }

  close(): void {
    this.db.close();
  }

  private stmt(sql: string): StatementSync {
    let s = this.statements.get(sql);
    if (s === undefined) {
      s = this.db.prepare(sql);
      this.statements.set(sql, s);
    }
    return s;
  }

  /** Runs `fn` in one transaction; any throw rolls everything back. */
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  getMeta(key: string): string | null {
    const row = this.stmt('SELECT value FROM meta WHERE key = ?').get(key);
    return row === undefined ? null : MetaRow.parse(row).value;
  }

  setMeta(key: string, value: string): void {
    this.stmt('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  // --- read positions -------------------------------------------------------

  getJsonlCursor(source: SourceKind, file: string): { cursor: unknown; blankLines: number } | null {
    const row = this.stmt('SELECT cursor, blank_lines FROM jsonl_files WHERE source = ? AND path = ?').get(source, file);
    if (row === undefined) return null;
    const r = z.object({ cursor: z.string(), blank_lines: z.number().int() }).parse(row);
    return { cursor: json(r.cursor), blankLines: r.blank_lines };
  }

  setJsonlCursor(source: SourceKind, file: string, cursor: unknown, blankLines: number): void {
    this.stmt(
      `INSERT INTO jsonl_files (source, path, cursor, blank_lines) VALUES (?, ?, ?, ?)
       ON CONFLICT (source, path) DO UPDATE SET cursor = excluded.cursor, blank_lines = excluded.blank_lines`,
    ).run(source, file, JSON.stringify(cursor), blankLines);
  }

  getCursorKeyHashes(): Map<string, string> {
    const rows = z.array(z.object({ key: z.string(), hash: z.string() })).parse(this.stmt('SELECT key, hash FROM cursor_keys').all());
    return new Map(rows.map((r) => [r.key, r.hash]));
  }

  setCursorKeyHash(key: string, hash: string): void {
    this.stmt('INSERT INTO cursor_keys (key, hash) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET hash = excluded.hash').run(key, hash);
  }

  // --- records and events ---------------------------------------------------

  hasRecord(source: SourceKind, nativeId: string): boolean {
    return this.stmt('SELECT 1 FROM records WHERE source = ? AND native_id = ? LIMIT 1').get(source, nativeId) !== undefined;
  }

  /** Stores a record with its final disposition. Events are stored only for processed records. */
  insertRecord(source: SourceKind, record: SourceRecord, disposition: Disposition): void {
    const result = this.stmt(
      'INSERT INTO records (source, native_id, ref, disposition, session_id, detail) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(source, record.nativeId, JSON.stringify(record.ref), disposition, record.sessionId, record.detail);
    if (disposition === 'processed') this.insertEvents(Number(result.lastInsertRowid), source, record);
  }

  /** Replaces a mutable record (a Cursor key whose value changed) in place, keeping its position. */
  replaceRecord(source: SourceKind, record: SourceRecord): void {
    const existing = this.stmt('SELECT id FROM records WHERE source = ? AND native_id = ? ORDER BY id LIMIT 1').get(source, record.nativeId);
    if (existing === undefined) {
      this.insertRecord(source, record, record.disposition);
      return;
    }
    const id = RecordRow.parse(existing).id;
    this.stmt('DELETE FROM events WHERE record_id = ?').run(id);
    this.stmt('UPDATE records SET ref = ?, disposition = ?, session_id = ?, detail = ? WHERE id = ?').run(
      JSON.stringify(record.ref),
      record.disposition,
      record.sessionId,
      record.detail,
      id,
    );
    if (record.disposition === 'processed') this.insertEvents(id, source, record);
  }

  private insertEvents(recordId: number, source: SourceKind, record: SourceRecord): void {
    if (record.sessionId === null) return;
    const insert = this.stmt('INSERT INTO events (record_id, position, source, session_id, type, data) VALUES (?, ?, ?, ?, ?, ?)');
    record.events.forEach((event, position) => {
      insert.run(recordId, position, source, record.sessionId, event.type, JSON.stringify(event));
    });
  }

  /** Session metadata: later values fill gaps, they never overwrite. */
  upsertSession(source: SourceKind, sessionId: string, info: SessionInfo | null): void {
    this.stmt(
      `INSERT INTO sessions (source, session_id, project_path, agent_version) VALUES (?, ?, ?, ?)
       ON CONFLICT (source, session_id) DO UPDATE SET
         project_path = COALESCE(sessions.project_path, excluded.project_path),
         agent_version = COALESCE(sessions.agent_version, excluded.agent_version)`,
    ).run(source, sessionId, info?.projectPath ?? null, info?.agentVersion ?? null);
  }

  sessionKeys(): Array<{ source: SourceKind; sessionId: string }> {
    return z
      .array(SessionKeyRow)
      .parse(this.stmt('SELECT source, session_id FROM sessions ORDER BY source, session_id').all())
      .map((r) => ({ source: r.source, sessionId: r.session_id }));
  }

  /** Events in file (or row) order: record arrival order, then position within the record. */
  loadSession(source: SourceKind, sessionId: string): SessionInput {
    const info = this.stmt('SELECT project_path, agent_version FROM sessions WHERE source = ? AND session_id = ?').get(source, sessionId);
    const meta = info === undefined ? { project_path: null, agent_version: null } : SessionRow.parse(info);
    const rows = z
      .array(DataRow)
      .parse(this.stmt('SELECT data FROM events WHERE source = ? AND session_id = ? ORDER BY record_id, position').all(source, sessionId));
    const events: SessionEvent[] = rows.map((r) => SessionEventSchema.parse(json(r.data)));
    return { source, sessionId, info: { projectPath: meta.project_path, agentVersion: meta.agent_version }, events };
  }

  /** Model calls per session, in file order, for one source (used by the OTel cross-check). */
  modelCalls(source: SourceKind): Map<string, ModelCallEvent[]> {
    const rows = z
      .array(z.object({ session_id: z.string(), data: z.string() }))
      .parse(this.stmt("SELECT session_id, data FROM events WHERE source = ? AND type = 'model-call' ORDER BY record_id, position").all(source));
    const out = new Map<string, ModelCallEvent[]>();
    for (const r of rows) {
      const event = SessionEventSchema.parse(json(r.data));
      if (event.type !== 'model-call') continue;
      out.set(r.session_id, [...(out.get(r.session_id) ?? []), event]);
    }
    return out;
  }

  // --- analyses ---------------------------------------------------------------

  saveAnalysis(analysis: SessionAnalysis): void {
    this.stmt(
      `INSERT INTO analyses (source, session_id, data) VALUES (?, ?, ?)
       ON CONFLICT (source, session_id) DO UPDATE SET data = excluded.data`,
    ).run(analysis.source, analysis.sessionId, JSON.stringify(analysis));
  }

  loadAnalyses(): SessionAnalysis[] {
    return z
      .array(DataRow)
      .parse(this.stmt('SELECT data FROM analyses ORDER BY source, session_id').all())
      .map((r) => SessionAnalysisSchema.parse(json(r.data)));
  }

  // --- coverage ---------------------------------------------------------------

  dispositionCounts(): Map<SourceKind, Record<Disposition, number>> {
    const out = new Map<SourceKind, Record<Disposition, number>>();
    const rows = z.array(DispositionRow).parse(this.stmt('SELECT source, disposition, COUNT(*) AS n FROM records GROUP BY source, disposition').all());
    for (const r of rows) {
      const counts = out.get(r.source) ?? { processed: 0, 'recognized-unused': 0, duplicate: 0, malformed: 0, unknown: 0 };
      counts[r.disposition] = r.n;
      out.set(r.source, counts);
    }
    return out;
  }

  blankLines(source: SourceKind): number {
    return Count.parse(this.stmt('SELECT COALESCE(SUM(blank_lines), 0) AS n FROM jsonl_files WHERE source = ?').get(source)).n;
  }

  setSourceStatus(status: Omit<SourceStatus, 'blankLines'>): void {
    this.stmt(
      `INSERT INTO source_status (source, enabled, synthetic, errors) VALUES (?, ?, ?, ?)
       ON CONFLICT (source) DO UPDATE SET enabled = excluded.enabled, synthetic = excluded.synthetic, errors = excluded.errors`,
    ).run(status.source, status.enabled ? 1 : 0, status.synthetic ? 1 : 0, JSON.stringify(status.errors));
  }

  sourceStatuses(): SourceStatus[] {
    return z
      .array(StatusRow)
      .parse(this.stmt('SELECT source, enabled, synthetic, errors FROM source_status ORDER BY source').all())
      .map((r) => ({
        source: r.source,
        enabled: r.enabled === 1,
        synthetic: r.synthetic === 1,
        blankLines: this.blankLines(r.source),
        errors: FileErrors.parse(json(r.errors)),
      }));
  }

  // --- snapshots --------------------------------------------------------------

  insertSnapshot(createdAt: string, payload: { meta: unknown; summary: unknown; sessions: unknown; reconciliation: unknown }): number {
    const result = this.stmt('INSERT INTO snapshots (created_at, meta, summary, sessions, reconciliation) VALUES (?, ?, ?, ?, ?)').run(
      createdAt,
      JSON.stringify(payload.meta),
      JSON.stringify(payload.summary),
      JSON.stringify(payload.sessions),
      JSON.stringify(payload.reconciliation),
    );
    return Number(result.lastInsertRowid);
  }

  /** Writes the meta once the id is known (the meta includes the id). */
  updateSnapshotMeta(id: number, meta: unknown): void {
    this.stmt('UPDATE snapshots SET meta = ? WHERE id = ?').run(JSON.stringify(meta), id);
  }

  snapshot(id: number | null): StoredSnapshot | null {
    const row =
      id === null
        ? this.stmt('SELECT * FROM snapshots ORDER BY id DESC LIMIT 1').get()
        : this.stmt('SELECT * FROM snapshots WHERE id = ?').get(id);
    if (row === undefined) return null;
    const r = SnapshotRow.parse(row);
    return {
      id: r.id,
      createdAt: r.created_at,
      meta: json(r.meta),
      summary: json(r.summary),
      sessions: json(r.sessions),
      reconciliation: json(r.reconciliation),
    };
  }

  latestSnapshotId(): number | null {
    const row = this.stmt('SELECT id FROM snapshots ORDER BY id DESC LIMIT 1').get();
    return row === undefined ? null : RecordRow.parse(row).id;
  }

  /** Meta of every snapshot plus its headline numbers, newest first. */
  snapshotList(): Array<{ meta: unknown; summary: unknown }> {
    const rows = z
      .array(z.object({ meta: z.string(), summary: z.string() }))
      .parse(this.stmt('SELECT meta, summary FROM snapshots ORDER BY id DESC').all());
    return rows.map((r) => ({ meta: json(r.meta), summary: json(r.summary) }));
  }
}

