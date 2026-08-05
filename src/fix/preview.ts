import type { FixHunk, FixHunkStatus } from './types';
import { diffLines, findLineRange } from './validator';

/**
 * Pure helpers that turn the original file content plus hunks into the
 * virtual document shown in the fix preview tab, and into the final file
 * content written when the user finishes the fix.
 */

export type PreviewLineKind = 'context' | 'removed' | 'added';

export interface PreviewLine {
  kind: PreviewLineKind;
  text: string;
  /** 1-based line number inside the virtual document (recomputed on every state change). */
  lineNo: number;
  hunkId?: string;
}

export interface PreviewBlock {
  hunkId?: string;
  reason?: string;
  status?: FixHunkStatus;
  lines: PreviewLine[];
}

export interface FilePreview {
  file: string;
  /** The real file no longer matches the snapshot taken at patch generation. */
  stale: boolean;
  blocks: PreviewBlock[];
  addedCount: number;
  removedCount: number;
}

export interface HunkEdit {
  hunk: FixHunk;
  /** 0-based inclusive range of oldLines inside the original file. */
  startLine: number;
  endLine: number;
  /** Indices into hunk.oldLines that are actually removed (LCS). */
  removedIdx: number[];
  /** Indices into hunk.newLines that are actually added (LCS). */
  addedIdx: number[];
}

/** Locate a hunk inside the original snapshot and compute its LCS diff. */
export function computeHunkEdit(hunk: FixHunk, originalLines: string[]): HunkEdit | null {
  const range = findLineRange(originalLines, hunk.oldLines);
  if (!range) return null;
  const diff = diffLines(hunk.oldLines, hunk.newLines);
  return {
    hunk,
    startLine: range.startLine,
    endLine: range.endLine,
    removedIdx: diff.removed,
    addedIdx: diff.added,
  };
}

/**
 * Build the virtual document for one file:
 * - pending: removed lines shown red above the green added lines;
 * - accepted: removed lines disappear, added lines stay green;
 * - rejected: added lines disappear, original lines stay plain.
 * Line numbers count every rendered line (pending proposals count both rows).
 * Overlapping hunks (defensive) are skipped.
 */
export function buildFilePreview(originalLines: string[], hunks: FixHunk[], file: string): FilePreview {
  const edits = hunks
    .filter(h => h.status !== 'stale')
    .map(h => computeHunkEdit(h, originalLines))
    .filter((e): e is HunkEdit => e !== null)
    .sort((a, b) => a.startLine - b.startLine);

  const blocks: PreviewBlock[] = [];
  let addedCount = 0;
  let removedCount = 0;
  let lineNo = 0;
  let cursor = 0;

  const push = (block: PreviewBlock | null, kind: PreviewLineKind, text: string, hunkId?: string): void => {
    lineNo++;
    const line: PreviewLine = { kind, text, lineNo, hunkId };
    if (kind === 'added') addedCount++;
    if (kind === 'removed') removedCount++;
    if (block) block.lines.push(line);
    else blocks.push({ lines: [line] });
  };

  for (const edit of edits) {
    if (edit.startLine < cursor) continue; // overlapping hunk: skip defensively

    for (let i = cursor; i < edit.startLine; i++) {
      push(null, 'context', originalLines[i]);
    }

    const block: PreviewBlock = {
      hunkId: edit.hunk.id,
      reason: edit.hunk.reason,
      status: edit.hunk.status,
      lines: [],
    };

    // Original lines of the hunk region.
    for (let i = 0; i < edit.hunk.oldLines.length; i++) {
      const isRemoved = edit.removedIdx.includes(i);
      if (edit.hunk.status === 'accepted' && isRemoved) continue; // accepted: old removed lines vanish
      const kind = edit.hunk.status === 'rejected' || !isRemoved ? 'context' : 'removed';
      push(block, kind, edit.hunk.oldLines[i], edit.hunk.id);
    }
    // New lines of the hunk region.
    for (let j = 0; j < edit.hunk.newLines.length; j++) {
      const isAdded = edit.addedIdx.includes(j);
      if (!isAdded) continue; // matched lines already emitted from oldLines
      if (edit.hunk.status === 'rejected') continue; // rejected: new lines vanish
      push(block, 'added', edit.hunk.newLines[j], edit.hunk.id);
    }

    if (block.lines.length > 0) blocks.push(block);
    cursor = Math.max(cursor, edit.endLine + 1);
  }

  for (let i = cursor; i < originalLines.length; i++) {
    push(null, 'context', originalLines[i]);
  }

  return { file, stale: false, blocks, addedCount, removedCount };
}

/**
 * Compute the final file content with only accepted hunks applied.
 * An accepted hunk replaces its whole old region with hunk.newLines.
 */
export function buildFinalLines(originalLines: string[], hunks: FixHunk[]): string[] {
  const edits = hunks
    .filter(h => h.status === 'accepted')
    .map(h => computeHunkEdit(h, originalLines))
    .filter((e): e is HunkEdit => e !== null)
    .sort((a, b) => a.startLine - b.startLine);

  const out: string[] = [];
  let cursor = 0;
  for (const edit of edits) {
    if (edit.startLine < cursor) continue; // overlapping hunk: skip defensively
    for (let i = cursor; i < edit.startLine; i++) out.push(originalLines[i]);
    for (const line of edit.hunk.newLines) out.push(line);
    cursor = edit.endLine + 1;
  }
  for (let i = cursor; i < originalLines.length; i++) out.push(originalLines[i]);
  return out;
}
