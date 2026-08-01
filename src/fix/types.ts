export type FixHunkStatus = 'pending' | 'accepted' | 'rejected' | 'stale';

/** Position info captured when a hunk is applied, used by undo-all. */
export interface FixAppliedInfo {
  /** 0-based line of the hunk start at apply time. */
  startLine: number;
  /** 0-based inclusive line of the hunk end at apply time. */
  endLine: number;
  /** First line after the hunk at apply time, or null when the hunk reached EOF. */
  afterLine: string | null;
  /** Monotonic apply order for reverse undo. */
  order: number;
}

export interface FixHunk {
  id: string;
  /** Absolute file path. */
  file: string;
  reason: string;
  oldLines: string[];
  newLines: string[];
  status: FixHunkStatus;
  applied?: FixAppliedInfo;
}

export interface FixSession {
  id: string;
  errorKey: string;
  hunks: FixHunk[];
  startedAt: number;
  endedAt?: number;
}

/** Raw hunk parsed from the AI response, before session assignment. */
export interface FixHunkInput {
  file: string;
  reason: string;
  oldLines: string[];
  newLines: string[];
}
