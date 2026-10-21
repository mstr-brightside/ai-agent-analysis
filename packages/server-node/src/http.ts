import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';
import { z } from 'zod';
import { Category, Source, type ErrorResponse, type IngestResponse } from '@agentspend/contract';
import type { Store, StoredSnapshot } from '@agentspend/store';
import { ingest, type IngestSources, type Trigger } from './ingest.ts';
import { reconciliationResponse, sessionsResponse, snapshotsResponse, summaryResponse } from './read.ts';

export type ServerOptions = {
  readonly store: Store;
  readonly sources: IngestSources;
  readonly host: string;
  readonly port: number;
  readonly webRoot: string;
  readonly zodRoot: string;
  readonly development?: boolean;
};

class HttpError extends Error {
  readonly status: number;
  readonly code: ErrorResponse['error']['code'];
  constructor(status: number, code: ErrorResponse['error']['code'], message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
} as const;

/**
 * CSP for the page: scripts from this server only, plus the page's inline import map,
 * allowed by its hash (an import map cannot be loaded from a file).
 */
function pageCsp(webRoot: string): string {
  let hash = '';
  try {
    const html = readFileSync(path.join(webRoot, 'index.html'), 'utf8');
    const map = /<script type="importmap">([\s\S]*?)<\/script>/.exec(html)?.[1];

    if (map !== undefined) {
      hash = ` 'sha256-${createHash('sha256').update(map).digest('base64')}'`;
    }
  } catch {
    // No page to serve: the API still works.
  }
  return `default-src 'self'; script-src 'self'${hash}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
  res.end(text);
}

const SnapshotQuery = z.object({ snapshot: z.coerce.number().int().positive().optional() });
const SessionsQuery = SnapshotQuery.extend({
  category: Category.optional(),
  source: Source.optional(),
  flagged: z.enum(['true', 'false']).optional(),
});

function query<T>(schema: z.ZodType<T>, url: URL): T {
  const parsed = schema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) {
    throw new HttpError(400, 'bad-request', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  }
  return parsed.data;
}

function snapshotOr404(store: Store, id: number | undefined): StoredSnapshot {
  const snapshot = store.snapshot(id ?? null);
  if (snapshot === null) {
    throw id === undefined ? new HttpError(404, 'no-snapshot', 'No snapshot yet: run an ingest first.') : new HttpError(404, 'not-found', `No snapshot ${id}.`);
  }
  return snapshot;
}

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

/** Serves a file only if it resolves inside `root` (no path traversal). */
function sendFile(res: ServerResponse, root: string, relative: string, csp: string): boolean {
  const file = path.resolve(root, `.${path.posix.normalize(`/${relative}`)}`);
  if (!file.startsWith(path.resolve(root) + path.sep)) return false;
  const type = MIME[path.extname(file)];
  if (type === undefined) return false;
  try {
    if (!statSync(file).isFile()) return false;
  } catch {
    return false;
  }
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache', 'Content-Security-Policy': csp, ...SECURITY_HEADERS });
  createReadStream(file).pipe(res);
  return true;
}

/**
 * Builds the request handler. Ingest is synchronous (node:sqlite, a few hundred ms), so
 * requests queue behind it; the guard still answers 409 if an ingest is re-entered.
 */
export function createHandler(options: Omit<ServerOptions, 'host' | 'port'>, allowedHosts: ReadonlySet<string>): (req: IncomingMessage, res: ServerResponse) => void {
  const { store } = options;
  const csp = pageCsp(options.webRoot);
  const revision = randomUUID();
  let ingesting = false;

  const runIngest = (trigger: Trigger): IngestResponse => {
    if (ingesting) throw new HttpError(409, 'ingest-in-progress', 'An ingest is already running.');
    ingesting = true;
    try {
      const result = ingest(store, options.sources, trigger);
      return result.status === 'changed'
        ? { status: 'changed', snapshot: result.snapshot, durationMs: result.durationMs }
        : { status: 'no-changes', latestSnapshotId: result.latestSnapshotId, partial: result.partial, errors: [...result.errors], durationMs: result.durationMs };
    } finally {
      ingesting = false;
    }
  };

  /** The JSON body for an API route, or undefined when the route does not exist. */
  const api = (route: string, url: URL): unknown => {
    switch (route) {
      case 'GET /api/summary':
        return summaryResponse(snapshotOr404(store, query(SnapshotQuery, url).snapshot));
      case 'GET /api/sessions': {
        const q = query(SessionsQuery, url);
        return sessionsResponse(snapshotOr404(store, q.snapshot), {
          category: q.category ?? null,
          source: q.source ?? null,
          flagged: q.flagged === undefined ? null : q.flagged === 'true',
        });
      }
      case 'GET /api/snapshots':
        return snapshotsResponse(store);
      case 'GET /api/reconciliation':
        return reconciliationResponse(snapshotOr404(store, query(SnapshotQuery, url).snapshot));
      case 'POST /api/ingest':
        return runIngest('refresh');
      default:
        return undefined;
    }
  };

  return (req, res) => {
    try {
      // DNS-rebinding guard: a loopback server only answers requests addressed to loopback.
      if (!allowedHosts.has((req.headers.host ?? '').toLowerCase())) throw new HttpError(400, 'bad-request', 'Unexpected Host header.');
      const url = new URL(req.url ?? '/', 'http://localhost');
      const route = `${req.method ?? 'GET'} ${url.pathname}`;
      if (url.pathname.startsWith('/api/')) {
        const body = api(route, url);
        if (body === undefined) throw new HttpError(404, 'not-found', `No route ${route}.`);
        sendJson(res, 200, body);
        return;
      }
      if (req.method === 'GET') {
        if (options.development === true && url.pathname === '/__dev/version') {
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
          res.end(revision);
          return;
        }
        if (options.development === true && url.pathname === '/') {
          const html = readFileSync(path.join(options.webRoot, 'index.html'), 'utf8');
          const script = `<script type="module" src="/app/web-plain/src/dev-reload.js?version=${revision}"></script>`;
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': csp, ...SECURITY_HEADERS });
          res.end(html.replace('</body>', `${script}</body>`));
          return;
        }
        if (url.pathname === '/' && sendFile(res, options.webRoot, 'index.html', csp)) return;
        if (url.pathname.startsWith('/styles/') && sendFile(res, path.join(options.webRoot, 'styles'), url.pathname.slice(8), csp)) return;
        if (url.pathname.startsWith('/app/') && sendFile(res, path.join(options.webRoot, 'dist'), url.pathname.slice(5), csp)) return;
        if (url.pathname.startsWith('/vendor/zod/') && sendFile(res, options.zodRoot, url.pathname.slice(12), csp)) return;
      }
      throw new HttpError(404, 'not-found', 'Not found.');
    } catch (e) {
      if (e instanceof HttpError) {
        sendJson(res, e.status, { error: { code: e.code, message: e.message } } satisfies ErrorResponse);
        return;
      }
      process.stderr.write(`Request failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
      sendJson(res, 500, { error: { code: 'internal', message: 'Internal error; see the server log.' } } satisfies ErrorResponse);
    }
  };
}

export function allowedHostHeaders(port: number): Set<string> {
  return new Set(['localhost', '127.0.0.1', '[::1]'].flatMap((h) => [h, `${h}:${port}`]));
}

export function startServer(options: ServerOptions): Promise<Server> {
  const server = createServer(createHandler(options, allowedHostHeaders(options.port)));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}
