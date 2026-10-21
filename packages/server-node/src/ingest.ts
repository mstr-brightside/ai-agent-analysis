// One ingest: read new data from every enabled source, store it in one transaction,
// recompute the sessions that received new events (all of them when the classifier or
// price table changed), and store a snapshot only when something changed.
import path from 'node:path';
import type { SnapshotMeta } from '@agentspend/contract';
import {
  analyzeSession,
  assertNever,
  buildReport,
  CLASSIFIER_VERSION,
  createPricer,
  SOURCE_KINDS,
  type Disposition,
  type Pricer,
  type SourceCoverage,
  type SourceKind,
  type SourceRecord,
} from '@agentspend/core';
import {
  CodexState,
  INITIAL_CODEX_STATE,
  JsonlCursor,
  listJsonlFiles,
  parseClaudeLine,
  parseCodexLine,
  readCursorDb,
  readJsonl,
  readOtelFile,
  reconcile,
  type JsonlRead,
} from '@agentspend/sources';
import type { Store } from '@agentspend/store';
import { classifierCheck } from './classifier-check.ts';
import { reconciliationBody, session, summaryBody, type ReconciliationBody } from './present.ts';

export type IngestSources = {
  readonly claudeLogsDir: string | null;
  readonly codexLogsDir: string | null;
  readonly cursorDbPath: string | null;
  readonly otelEventsPath: string | null;
  readonly evalDir: string | null;
};

export type Trigger = SnapshotMeta['trigger'];
type FileError = { file: string; message: string };

export type IngestResult =
  | { readonly status: 'changed'; readonly snapshot: SnapshotMeta; readonly durationMs: number }
  | {
      readonly status: 'no-changes';
      readonly latestSnapshotId: number | null;
      readonly partial: boolean;
      readonly errors: readonly FileError[];
      readonly durationMs: number;
    };

const META_CLASSIFIER = 'classifierVersion';
const META_PRICING = 'pricingVersion';

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

class Run {
  newRecords = 0;
  readonly touched = new Map<string, { source: SourceKind; sessionId: string }>();
  readonly rereadFiles: string[] = [];
  readonly errors = new Map<SourceKind, FileError[]>(SOURCE_KINDS.map((s) => [s, []]));
  readonly synthetic = new Map<SourceKind, boolean>();
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  error(source: SourceKind, file: string, e: unknown): void {
    this.errors.get(source)?.push({ file, message: message(e) });
  }

  /** Stores a record with its final disposition: an identity seen before makes it a duplicate. */
  apply(source: SourceKind, record: SourceRecord, replace = false): void {
    // Events that cannot be attributed to a session would be lost: say so instead.
    const unattributable = record.disposition === 'processed' && record.sessionId === null && record.events.length > 0;
    const effective: SourceRecord = unattributable
      ? { ...record, disposition: 'malformed', detail: 'no session id (session header missing or unreadable)' }
      : record;
    let disposition: Disposition = effective.disposition;
    if (replace) {
      this.store.replaceRecord(source, effective);
    } else {
      if (this.store.hasRecord(source, effective.nativeId)) disposition = 'duplicate';
      this.store.insertRecord(source, effective, disposition);
    }
    this.newRecords++;
    if (disposition === 'processed' && effective.sessionId !== null) {
      this.store.upsertSession(source, effective.sessionId, effective.info);
      this.touched.set(`${source}\u0000${effective.sessionId}`, { source, sessionId: effective.sessionId });
    }
  }
}

function ingestJsonl(store: Store, run: Run, source: 'claude' | 'codex', root: string): void {
  let files: string[];
  try {
    files = listJsonlFiles(root);
  } catch (e) {
    run.error(source, path.basename(root), e);
    return;
  }
  for (const rel of files) {
    const fileName = path.posix.basename(rel);
    const stored = store.getJsonlCursor(source, rel);
    const parsedCursor = stored === null ? null : JsonlCursor.safeParse(stored.cursor);
    const cursor = parsedCursor?.success === true ? parsedCursor.data : null;
    let read: JsonlRead;
    try {
      read = readJsonl(path.join(root, rel), cursor);
    } catch (e) {
      run.error(source, fileName, e);
      continue;
    }
    if (read.mode === 'unchanged') continue;
    if (read.reread || (stored !== null && cursor === null)) run.rereadFiles.push(fileName);

    let state: CodexState = INITIAL_CODEX_STATE;
    if (source === 'codex' && read.mode === 'append' && cursor !== null) {
      const carried = CodexState.safeParse(cursor.state);
      if (carried.success) state = carried.data;
    }
    for (const line of read.lines) {
      if (source === 'claude') {
        run.apply(source, parseClaudeLine(line.text, fileName, line.line, rel));
      } else {
        const out = parseCodexLine(line.text, fileName, line.line, rel, state);
        state = out.state;
        run.apply(source, out.record);
      }
    }
    const blankLines = read.mode === 'append' ? (stored?.blankLines ?? 0) + read.blankLines : read.blankLines;
    store.setJsonlCursor(source, rel, { ...read.position, state: source === 'codex' ? state : null }, blankLines);
  }
}

function ingestCursor(store: Store, run: Run, dbPath: string): void {
  const read = readCursorDb(dbPath, store.getCursorKeyHashes());
  if (read.status === 'unavailable') {
    run.error('cursor', path.basename(dbPath), read.message);
    run.synthetic.set('cursor', store.sourceStatuses().find((s) => s.source === 'cursor')?.synthetic ?? false);
    return;
  }
  run.synthetic.set('cursor', read.synthetic);
  for (const { record, replace, hash } of read.records) {
    if (record.ref.kind !== 'key') continue;
    run.apply('cursor', record, replace);
    store.setCursorKeyHash(record.ref.key, hash);
  }
}

function enabled(sources: IngestSources, source: SourceKind): boolean {
  switch (source) {
    case 'claude':
      return sources.claudeLogsDir !== null;
    case 'codex':
      return sources.codexLogsDir !== null;
    case 'cursor':
      return sources.cursorDbPath !== null;
    default:
      return assertNever(source);
  }
}

function reconciliation(store: Store, sources: IngestSources, pricer: Pricer, run: Run): ReconciliationBody {
  if (sources.otelEventsPath === null) return { status: 'off', reason: 'OTEL_EVENTS_PATH is empty' };
  try {
    return reconciliationBody(reconcile(readOtelFile(sources.otelEventsPath), store.modelCalls('claude'), pricer));
  } catch (e) {
    run.error('claude', path.basename(sources.otelEventsPath), e);
    return { status: 'off', reason: `OTel file could not be read: ${message(e)}` };
  }
}

export function ingest(store: Store, sources: IngestSources, trigger: Trigger, now: () => Date = () => new Date()): IngestResult {
  const started = performance.now();
  const pricer = createPricer();
  const versions = { classifier: CLASSIFIER_VERSION, pricing: pricer.version };

  return store.transaction(() => {
    const run = new Run(store);
    if (sources.claudeLogsDir !== null) ingestJsonl(store, run, 'claude', sources.claudeLogsDir);
    if (sources.codexLogsDir !== null) ingestJsonl(store, run, 'codex', sources.codexLogsDir);
    if (sources.cursorDbPath !== null) ingestCursor(store, run, sources.cursorDbPath);

    for (const source of SOURCE_KINDS) {
      store.setSourceStatus({ source, enabled: enabled(sources, source), synthetic: run.synthetic.get(source) ?? false, errors: run.errors.get(source) ?? [] });
    }

    const storedClassifier = store.getMeta(META_CLASSIFIER);
    const storedPricing = store.getMeta(META_PRICING);
    const versionChanged =
      storedClassifier !== null && storedPricing !== null && (storedClassifier !== versions.classifier || storedPricing !== versions.pricing);
    const recompute = versionChanged ? store.sessionKeys() : [...run.touched.values()];
    for (const key of recompute) store.saveAnalysis(analyzeSession(store.loadSession(key.source, key.sessionId), pricer));
    store.setMeta(META_CLASSIFIER, versions.classifier);
    store.setMeta(META_PRICING, versions.pricing);

    const errors = [...run.errors.values()].flat();
    const partial = errors.length > 0;
    const latest = store.latestSnapshotId();
    if (run.newRecords === 0 && !versionChanged && latest !== null) {
      return { status: 'no-changes', latestSnapshotId: latest, partial, errors, durationMs: performance.now() - started };
    }

    const counts = store.dispositionCounts();
    const statuses = store.sourceStatuses();
    const coverage: SourceCoverage[] = SOURCE_KINDS.map((source) => {
      const status = statuses.find((s) => s.source === source);
      return {
        source,
        enabled: enabled(sources, source),
        synthetic: status?.synthetic ?? false,
        records: counts.get(source) ?? { processed: 0, 'recognized-unused': 0, duplicate: 0, malformed: 0, unknown: 0 },
        blankLines: status?.blankLines ?? 0,
        errors: status?.errors ?? [],
      };
    });
    const analyses = store.loadAnalyses();
    const report = buildReport({ sessions: analyses, coverage, versions });
    const createdAt = now().toISOString();
    const recon = reconciliation(store, sources, pricer, run);
    const id = store.insertSnapshot(createdAt, {
      meta: null,
      summary: summaryBody(report, classifierCheck(sources.evalDir, analyses)),
      sessions: analyses.map(session),
      reconciliation: recon,
    });
    const meta: SnapshotMeta = {
      id,
      createdAt,
      trigger,
      classifierVersion: versions.classifier,
      pricingVersion: versions.pricing,
      partial: [...run.errors.values()].flat().length > 0,
      changes: { newRecords: run.newRecords, touchedSessions: recompute.length, versionChanged, rereadFiles: run.rereadFiles },
    };
    store.updateSnapshotMeta(id, meta);
    return { status: 'changed', snapshot: meta, durationMs: performance.now() - started };
  });
}
