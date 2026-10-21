import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { ErrorResponse, IngestResponse, SessionsResponse, SnapshotsResponse, SummaryResponse } from '@agentspend/contract';
import { Store } from '@agentspend/store';
import { allowedHostHeaders, createHandler } from '../src/http.ts';

const ROOT = path.resolve(import.meta.dirname, '../../..');

describe('http', () => {
  let server: Server;
  let base = '';
  let store: Store;

  before(async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'agentspend-http-'));
    const claude = path.join(dir, 'claude', 'p');
    mkdirSync(claude, { recursive: true });
    writeFileSync(
      path.join(claude, 's.jsonl'),
      `${JSON.stringify({ type: 'user', uuid: 'u1', sessionId: 's1', cwd: '/home/dev/projects/demo', message: { role: 'user', content: 'Explain how parse.py works.' } })}\n`,
    );
    store = Store.open(dir);
    // The Host allow-list needs the port, which is only known after listening on port 0.
    let handler: ReturnType<typeof createHandler> | null = null;
    server = createServer((req, res) => {
      if (handler === null) res.writeHead(503).end();
      else handler(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    const port = (address satisfies AddressInfo).port;
    handler = createHandler(
      {
        store,
        sources: { claudeLogsDir: path.join(dir, 'claude'), codexLogsDir: null, cursorDbPath: null, otelEventsPath: null, evalDir: null },
        webRoot: path.join(ROOT, 'packages/web-plain'),
        zodRoot: path.join(ROOT, 'node_modules/zod'),
      },
      allowedHostHeaders(port),
    );
    base = `http://127.0.0.1:${port}`;
  });

  after(() => {
    server.close();
    store.close();
  });

  const get = async (url: string, init?: RequestInit): Promise<{ status: number; body: unknown; headers: Headers }> => {
    const res = await fetch(`${base}${url}`, init);
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // not JSON: static file
    }
    return { status: res.status, body, headers: res.headers };
  };

  it('answers 404 no-snapshot before the first ingest', async () => {
    const r = await get('/api/summary');
    assert.equal(r.status, 404);
    assert.equal(ErrorResponse.parse(r.body).error.code, 'no-snapshot');
  });

  it('ingests on POST and then serves contract-valid responses', async () => {
    const ingested = await get('/api/ingest', { method: 'POST' });
    assert.equal(ingested.status, 200);
    assert.equal(IngestResponse.parse(ingested.body).status, 'changed');
    const again = IngestResponse.parse((await get('/api/ingest', { method: 'POST' })).body);
    assert.equal(again.status, 'no-changes');

    const summary = SummaryResponse.parse((await get('/api/summary')).body);
    assert.equal(summary.headline.sessions, 1);
    assert.equal(summary.pricingBasis, 'estimated at public API list prices');
    assert.equal(SnapshotsResponse.parse((await get('/api/snapshots')).body).snapshots.length, 1);
    const sessions = SessionsResponse.parse((await get('/api/sessions?category=research&source=claude&flagged=false')).body);
    assert.deepEqual(
      sessions.sessions.map((s) => [s.project, s.primaryCategory]),
      [['demo', 'research']],
    );
  });

  it('rejects bad query parameters with 400 and unknown routes with 404', async () => {
    assert.equal((await get('/api/sessions?flagged=maybe')).status, 400);
    assert.equal((await get('/api/summary?snapshot=0')).status, 400);
    assert.equal((await get('/api/summary?snapshot=42')).status, 404);
    assert.equal((await get('/api/nothing')).status, 404);
    assert.equal((await get('/api/summary', { method: 'DELETE' })).status, 404);
  });

  it('refuses requests addressed to another host (DNS rebinding)', async () => {
    // fetch() drops a custom Host header, so this goes through node:http.
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(`${base}/api/summary`, { headers: { Host: 'attacker.example' } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 400);
  });

  it('serves the page with a CSP that allows only its own import map', async () => {
    const r = await get('/');
    assert.equal(r.status, 200);
    const html = readFileSync(path.join(ROOT, 'packages/web-plain/index.html'), 'utf8');
    const map = /<script type="importmap">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';
    const hash = createHash('sha256').update(map).digest('base64');
    assert.match(r.headers.get('content-security-policy') ?? '', new RegExp(`script-src 'self' 'sha256-${hash.replace(/[+/]/g, '\\$&')}'`));
    assert.equal(typeof r.body, 'string');
    if (typeof r.body !== 'string') throw new Error('Expected HTML');
    const stylesheet = /<link rel="stylesheet" href="([^"]+)"/.exec(r.body)?.[1];
    if (stylesheet === undefined) throw new Error('Expected a linked stylesheet');
    const css = await get(stylesheet);
    assert.equal(css.status, 200);
    assert.equal(css.headers.get('content-type'), 'text/css; charset=utf-8');
    assert.equal(css.body, readFileSync(path.join(ROOT, 'packages/web-plain/styles/main.css'), 'utf8'));
  });

  it('does not serve files outside the static roots', async () => {
    const r = await fetch(`${base}/vendor/zod/..%2F..%2Fpackage.json`);
    assert.equal(r.status, 404);
    assert.equal((await get('/vendor/zod/package.json')).status, 404, 'only .js, .css, .html and .svg are served');
  });

  it('keeps reload support disabled outside development', async () => {
    const page = await get('/');
    assert.equal(typeof page.body, 'string');
    if (typeof page.body !== 'string') throw new Error('Expected HTML');
    assert.doesNotMatch(page.body, /dev-reload\.js/);
    assert.equal((await get('/__dev/version')).status, 404);
  });

  it('injects a reload script with the current server revision only in development', async () => {
    const devHosts = new Set<string>();
    const devServer = createServer(createHandler({
      store,
      sources: { claudeLogsDir: null, codexLogsDir: null, cursorDbPath: null, otelEventsPath: null, evalDir: null },
      webRoot: path.join(ROOT, 'packages/web-plain'),
      zodRoot: path.join(ROOT, 'node_modules/zod'),
      development: true,
    }, devHosts));
    await new Promise<void>((resolve) => devServer.listen(0, '127.0.0.1', resolve));
    try {
      const address = devServer.address();
      if (address === null || typeof address === 'string') throw new Error('no port');
      const devBase = `http://127.0.0.1:${address.port}`;
      for (const host of allowedHostHeaders(address.port)) devHosts.add(host);
      const devGet = (route: string): Promise<Response> => fetch(`${devBase}${route}`);
      const page = await devGet('/');
      assert.equal(page.status, 200);
      assert.equal(page.headers.get('cache-control'), 'no-store');
      const html = await page.text();
      const revision = /dev-reload\.js\?version=([^"]+)/.exec(html)?.[1];
      assert.ok(revision);
      const version = await devGet('/__dev/version');
      assert.equal(version.status, 200);
      assert.equal(version.headers.get('cache-control'), 'no-store');
      assert.equal(await version.text(), revision);
    } finally {
      await new Promise<void>((resolve, reject) => devServer.close((error) => { if (error) reject(error); else resolve(); }));
    }
  });
});
