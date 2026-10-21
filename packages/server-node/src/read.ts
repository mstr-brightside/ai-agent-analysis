import type { Category, SessionsResponse, SnapshotsResponse, Source } from '@agentspend/contract';
import { PRICING_BASIS, ReconciliationResponse, Session, SnapshotMeta, SummaryResponse } from '@agentspend/contract';
import type { Store, StoredSnapshot } from '@agentspend/store';
import { z } from 'zod';

const SummaryBody = SummaryResponse.omit({ snapshot: true });
const StoredReconciliation = z.discriminatedUnion('status', [
  z.object({ status: z.literal('off'), reason: z.string() }),
  ReconciliationResponse.options[1].omit({ snapshotId: true }),
]);

export function summaryResponse(snapshot: StoredSnapshot): SummaryResponse {
  return { snapshot: SnapshotMeta.parse(snapshot.meta), ...SummaryBody.parse(snapshot.summary) };
}

export type SessionFilters = { category: Category | null; source: Source | null; flagged: boolean | null };

export function sessionsResponse(snapshot: StoredSnapshot, filters: SessionFilters): SessionsResponse {
  const sessions = z
    .array(Session)
    .parse(snapshot.sessions)
    .filter(
      (s) =>
        (filters.category === null || s.primaryCategory === filters.category) &&
        (filters.source === null || s.source === filters.source) &&
        (filters.flagged === null || s.flagged === filters.flagged),
    )
    .sort((a, b) => b.spend.totalUsd - a.spend.totalUsd);
  return { snapshot: SnapshotMeta.parse(snapshot.meta), pricingBasis: PRICING_BASIS, filters, sessions };
}

export function reconciliationResponse(snapshot: StoredSnapshot): ReconciliationResponse {
  const stored = StoredReconciliation.parse(snapshot.reconciliation);
  return stored.status === 'off' ? stored : { ...stored, snapshotId: snapshot.id };
}

export function snapshotsResponse(store: Store): SnapshotsResponse {
  return {
    snapshots: store.snapshotList().map((s) => {
      const body = SummaryBody.parse(s.summary);
      return { ...SnapshotMeta.parse(s.meta), spendUsd: body.headline.spendUsd, sessions: body.headline.sessions };
    }),
  };
}
