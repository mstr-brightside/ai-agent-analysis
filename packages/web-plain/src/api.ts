import {
  ErrorResponse,
  IngestResponse,
  ReconciliationResponse,
  SnapshotsResponse,
  SummaryResponse,
} from '@agentspend/contract';
import type { z } from 'zod';

async function call<T>(method: 'GET' | 'POST', url: string, schema: z.ZodType<T>): Promise<T> {
  const response = await fetch(url, { method, headers: { Accept: 'application/json' } });
  const body: unknown = await response.json();

  if (!response.ok) {
    const error = ErrorResponse.safeParse(body);
    throw new Error(error.success ? error.data.error.message : `HTTP ${response.status}`);
  }

  const parsed = schema.safeParse(body);
  
  if (!parsed.success) {
    throw new Error(`The server's ${url} response does not match the contract: ${parsed.error.message}`);
  }

  return parsed.data;
}

const withSnapshot = (path: string, id: number | null): string => (id === null ? path : `${path}?snapshot=${id}`);

export const api = {
  summary: (snapshot: number | null) => call('GET', withSnapshot('/api/summary', snapshot), SummaryResponse),
  reconciliation: (snapshot: number | null) => call('GET', withSnapshot('/api/reconciliation', snapshot), ReconciliationResponse),
  snapshots: () => call('GET', '/api/snapshots', SnapshotsResponse),
  ingest: () => call('POST', '/api/ingest', IngestResponse),
};
