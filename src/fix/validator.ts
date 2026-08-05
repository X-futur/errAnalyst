/** 0-based inclusive line range. */
export interface LineRange {
  startLine: number;
  endLine: number;
}

export function normalizeLine(line: string): string {
  return line.replace(/\r$/, '');
}

/**
 * Find the first exact match of target lines inside the document lines.
 * Matches are normalized for trailing \r so terminals/Windows files work.
 */
export function findLineRange(lines: string[], target: string[]): LineRange | null {
  if (target.length === 0 || target.length > lines.length) return null;
  outer:
  for (let i = 0; i <= lines.length - target.length; i++) {
    for (let j = 0; j < target.length; j++) {
      if (normalizeLine(lines[i + j]) !== normalizeLine(target[j])) continue outer;
    }
    return { startLine: i, endLine: i + target.length - 1 };
  }
  return null;
}

export interface LineDiff {
  /** Indices into oldLines that are removed. */
  removed: number[];
  /** Indices into newLines that are added. */
  added: number[];
}

/** Longest common subsequence diff over lines, for green/red rendering. */
export function diffLines(oldLines: string[], newLines: string[]): LineDiff {
  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));

  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = normalizeLine(oldLines[i]) === normalizeLine(newLines[j])
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const removed: number[] = [];
  const added: number[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (normalizeLine(oldLines[i]) === normalizeLine(newLines[j])) {
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      removed.push(i++);
    } else {
      added.push(j++);
    }
  }
  while (i < m) removed.push(i++);
  while (j < n) added.push(j++);

  return { removed, added };
}
