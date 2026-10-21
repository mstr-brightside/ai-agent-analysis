// Measures the classifier against the hand labels in eval/ during ingest. A missing or
// invalid label file means "not measured" for that number, never a failed ingest.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { ClassifierCheck, Ratio } from '@agentspend/contract';
import { CATEGORIES, classifiedBy, promptAgreement, turnAgreement, type Agreement, type SessionAnalysis } from '@agentspend/core';
import { readCsv } from '@agentspend/sources';

const Label = z.enum(CATEGORIES);
// Columns: id, prompt, label, note.
const HeldoutRow = z.tuple([z.string(), z.string(), Label], z.string()).transform(([, prompt, label]) => ({ prompt, label }));
// Columns: id, label, note.
const LabelRow = z.tuple([z.string(), Label], z.string()).transform(([id, label]) => ({ id, label }));

/** Data rows of a CSV file (header and rows without an id dropped), or null when unreadable or any row is invalid. */
function readRows<T>(file: string, schema: z.ZodType<T>): T[] | null {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const rows = readCsv(text)
    .slice(1)
    .filter((r) => (r[0] ?? '') !== '');
  const parsed = z.array(schema).safeParse(rows);
  return parsed.success ? parsed.data : null;
}

const ratio = (a: Agreement | null): Ratio | null => (a === null ? null : { part: a.agreed, total: a.total });

export function classifierCheck(evalDir: string | null, sessions: readonly SessionAnalysis[]): ClassifierCheck {
  const heldout = evalDir === null ? null : readRows(path.join(evalDir, 'heldout.csv'), HeldoutRow);
  const labels = evalDir === null ? null : readRows(path.join(evalDir, 'labels.csv'), LabelRow);
  return {
    heldout: ratio(heldout === null ? null : promptAgreement(heldout)),
    labelledSample: ratio(labels === null ? null : turnAgreement(sessions, labels)),
    turnsClassifiedBy: classifiedBy(sessions),
  };
}
