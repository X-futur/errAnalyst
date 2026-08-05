export type FixHunkStatus = 'pending' | 'accepted' | 'rejected' | 'stale';

/** Full content of a file as captured when the patch was generated. */
export interface FileSnapshot {
  lines: string[];
  endsWithNewline: boolean;
}

export interface FixHunk {
  id: string;
  /** Absolute file path. */
  file: string;
  reason: string;
  oldLines: string[];
  newLines: string[];
  status: FixHunkStatus;
}

export interface FixSession {
  id: string;
  errorKey: string;
  hunks: FixHunk[];
  startedAt: number;
  endedAt?: number;
  /** Original file content per touched file, captured at validation time. */
  snapshots: Map<string, FileSnapshot>;
  /** Files whose live content no longer matches their snapshot. */
  staleFiles: Set<string>;
}

/** Raw hunk parsed from the AI response, before session assignment. */
export interface FixHunkInput {
  file: string;
  reason: string;
  oldLines: string[];
  newLines: string[];
}
