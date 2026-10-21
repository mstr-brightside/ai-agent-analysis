// Incremental JSONL reading. Per file we keep the byte offset of the last consumed line,
// the size, and a hash of the file's head. Next time:
//   - same head, file grown            → read from the offset;
//   - same head, same size             → nothing to read;
//   - shorter file or a different head → truncated or replaced: full re-read (duplicates
//     are then caught by record identity), reported as a re-read;
//   - a last line without a trailing newline is not consumed (it may still be being written).
import { createHash } from 'node:crypto';
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { z } from 'zod';

export const HEAD_BYTES = 4096;
const CHUNK_BYTES = 1 << 20;

export const JsonlCursor = z.object({
  offset: z.number().int().nonnegative(),
  size: z.number().int().nonnegative(),
  headLength: z.number().int().nonnegative(),
  headHash: z.string(),
  /** Complete lines consumed so far (blank ones included), so line numbers continue. */
  lineCount: z.number().int().nonnegative(),
  /** Adapter state carried between reads (e.g. the Codex session id from `session_meta`). */
  state: z.unknown(),
});
export type JsonlCursor = z.infer<typeof JsonlCursor>;

export type JsonlLine = { readonly line: number; readonly text: string };

export type JsonlRead = {
  readonly mode: 'full' | 'append' | 'unchanged';
  /** A previous cursor was invalid (file truncated or replaced) and the file was re-read in full. */
  readonly reread: boolean;
  readonly lines: readonly JsonlLine[];
  readonly blankLines: number;
  readonly position: Omit<JsonlCursor, 'state'>;
};

function hashHead(fd: number, length: number): string {
  const buffer = Buffer.alloc(length);
  const read = length === 0 ? 0 : readSync(fd, buffer, 0, length, 0);
  return createHash('sha256').update(buffer.subarray(0, read)).digest('hex');
}

export function readJsonl(filePath: string, cursor: JsonlCursor | null): JsonlRead {
  const size = statSync(filePath).size;
  const fd = openSync(filePath, 'r');
  try {
    let start = 0;
    let lineCount = 0;
    let mode: JsonlRead['mode'] = 'full';
    let reread = false;
    if (cursor !== null) {
      const sameHead = size >= cursor.headLength && hashHead(fd, cursor.headLength) === cursor.headHash;
      if (sameHead && size >= cursor.size && size >= cursor.offset) {
        if (size === cursor.size) {
          return { mode: 'unchanged', reread: false, lines: [], blankLines: 0, position: { ...cursor } };
        }
        start = cursor.offset;
        lineCount = cursor.lineCount;
        mode = 'append';
      } else {
        reread = true;
      }
    }

    const headLength = Math.min(HEAD_BYTES, size);
    const headHash = hashHead(fd, headLength);
    const lines: JsonlLine[] = [];
    let blankLines = 0;
    let offset = start;
    let carry = Buffer.alloc(0);
    let position = start;
    const chunk = Buffer.alloc(CHUNK_BYTES);
    while (position < size) {
      const read = readSync(fd, chunk, 0, Math.min(CHUNK_BYTES, size - position), position);
      if (read === 0) break;
      position += read;
      let data = Buffer.concat([carry, chunk.subarray(0, read)]);
      let newline = data.indexOf(0x0a);
      while (newline !== -1) {
        const text = data.subarray(0, newline).toString('utf8').replace(/\r$/, '');
        lineCount++;
        offset += newline + 1;
        if (text.trim() === '') blankLines++;
        else lines.push({ line: lineCount, text });
        data = data.subarray(newline + 1);
        newline = data.indexOf(0x0a);
      }
      carry = Buffer.from(data);
    }
    return {
      mode,
      reread,
      lines,
      blankLines,
      position: { offset, size, headLength, headHash, lineCount },
    };
  } finally {
    closeSync(fd);
  }
}
