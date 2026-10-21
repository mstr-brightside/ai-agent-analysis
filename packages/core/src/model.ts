// The normalized model every source adapter produces. Core never knows which source a
// session came from beyond the `source` label it carries through to the report.
import type { Usage } from './usage.ts';

export type SourceKind = 'claude' | 'codex' | 'cursor';
export const SOURCE_KINDS = ['claude', 'codex', 'cursor'] as const satisfies readonly SourceKind[];

export type Disposition = 'processed' | 'recognized-unused' | 'duplicate' | 'malformed' | 'unknown';
export const DISPOSITIONS = [
  'processed',
  'recognized-unused',
  'duplicate',
  'malformed',
  'unknown',
] as const satisfies readonly Disposition[];

/** Where a record came from. JSONL: file name (never a full path) and 1-based line. SQLite: row key. */
export type SourceRef =
  | { readonly kind: 'line'; readonly file: string; readonly line: number }
  | { readonly kind: 'key'; readonly key: string };

export type ToolKind = 'read' | 'search' | 'edit' | 'write' | 'shell' | 'other';
export type ToolOutcome = 'success' | 'failure' | 'unknown';

export type PromptEvent = {
  readonly type: 'prompt';
  readonly ref: SourceRef;
  readonly timestamp: string | null;
  /** Stays in the local store. Never returned by the API or written to a snapshot. */
  readonly text: string;
};

export type ModelCallEvent = {
  readonly type: 'model-call';
  readonly ref: SourceRef;
  readonly timestamp: string | null;
  /** Vendor message id when the format has one. Usage is charged at most once per id. */
  readonly messageId: string | null;
  readonly model: string | null;
  /** null: the record carries no usage. Missing stays missing. */
  readonly usage: Usage | null;
  /** Work done by a sub-agent inside the session (e.g. Claude sidechains). */
  readonly sidechain: boolean;
};

export type ToolCallEvent = {
  readonly type: 'tool-call';
  readonly ref: SourceRef;
  readonly timestamp: string | null;
  readonly callId: string;
  /** Tool name as the agent reports it (Bash, shell, edit_file…). */
  readonly tool: string;
  readonly toolKind: ToolKind;
  /** Normalized target used to group repeated attempts (command, file, pattern). null when unknown. */
  readonly target: string | null;
};

export type ToolResultEvent = {
  readonly type: 'tool-result';
  readonly ref: SourceRef;
  readonly timestamp: string | null;
  readonly callId: string;
  readonly outcome: ToolOutcome;
};

export type SessionEvent = PromptEvent | ModelCallEvent | ToolCallEvent | ToolResultEvent;

/** Session metadata learned from records. Later values fill gaps; they never overwrite. */
export type SessionInfo = {
  /** Full working directory. Stays in the local store; reports show the folder name only. */
  readonly projectPath: string | null;
  readonly agentVersion: string | null;
};

/** One raw record, as an adapter classified it. Duplicates are decided later, by native identity. */
export type SourceRecord = {
  readonly ref: SourceRef;
  readonly disposition: Exclude<Disposition, 'duplicate'>;
  /** Source-native identity used for duplicate detection (Claude uuid, Codex file+line, Cursor key). */
  readonly nativeId: string;
  readonly sessionId: string | null;
  readonly info: SessionInfo | null;
  readonly events: readonly SessionEvent[];
  /** Why a record is malformed or unknown (schema issue, unknown type name). */
  readonly detail: string | null;
};

/** A session as the analysis sees it: identity, metadata and events in file order. */
export type SessionInput = {
  readonly source: SourceKind;
  readonly sessionId: string;
  readonly info: SessionInfo;
  readonly events: readonly SessionEvent[];
};

/** Folder name of a working directory (POSIX or Windows), or null. Full paths never leave the store. */
export function projectFolder(projectPath: string | null): string | null {
  if (projectPath === null) return null;
  const parts = projectPath.split(/[\\/]+/).filter((p) => p !== '');
  return parts.at(-1) ?? null;
}

export function refLabel(ref: SourceRef): string {
  return ref.kind === 'line' ? `${ref.file}:${ref.line}` : ref.key;
}
