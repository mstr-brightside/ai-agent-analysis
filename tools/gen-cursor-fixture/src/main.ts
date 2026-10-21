// npm run gen:cursor: rebuilds fixtures/cursor/state.vscdb (synthetic, deterministic).
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { generateCursorFixture } from './generate.ts';

const target = path.resolve(import.meta.dirname, '../../../fixtures/cursor/state.vscdb');
mkdirSync(path.dirname(target), { recursive: true });
const { composers, rows } = generateCursorFixture(target);
process.stdout.write(`Wrote ${path.relative(process.cwd(), target)}: ${composers} composers, ${rows} rows (synthetic).\n`);
