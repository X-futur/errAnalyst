import * as fs from 'fs';
import * as path from 'path';

/**
 * Directory names that mark a subtree as dependency/generated code
 * rather than project code. Matched against each path segment inside an anchor.
 */
export const NON_PROJECT_DIRS = new Set([
  'node_modules',
  'site-packages',
  'dist-packages',
  'venv',
  '.venv',
  '__pycache__',
  'out',
  'dist',
  'build',
  '.next',
  'coverage',
  '.cache',
  'target',
  '.git',
  '.vscode',
  '.vscode-test',
  'obj',
]);

/** Source file extensions considered when scanning anchors for guessed candidates. */
export const SOURCE_EXTENSIONS = new Set([
  '.py', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
  '.sh', '.go', '.rs', '.java', '.rb', '.php', '.cs', '.cpp', '.c', '.h',
]);

export function normalizePath(p: string): string {
  return path.normalize(p);
}

export function isInside(filePath: string, anchor: string): boolean {
  const f = normalizePath(filePath);
  const a = normalizePath(anchor);
  if (f === a) return true;
  return f.startsWith(a.endsWith(path.sep) ? a : a + path.sep);
}

/** True when any path segment is a known dependency/generated directory. */
export function isDependencyPath(filePath: string): boolean {
  return normalizePath(filePath)
    .split(path.sep)
    .some(seg => NON_PROJECT_DIRS.has(seg));
}

/**
 * A file is a project file when it lives inside an anchor and does not pass
 * through any dependency/generated directory.
 */
export function isProjectFile(filePath: string, anchors: string[]): boolean {
  const f = normalizePath(filePath);
  for (const anchor of anchors) {
    if (!isInside(f, anchor)) continue;
    const rel = path.relative(anchor, f);
    return !rel.split(path.sep).some(seg => NON_PROJECT_DIRS.has(seg));
  }
  return false;
}

/**
 * Compute the anchor directories for a traceback:
 * all workspace folders, plus the error file's directory when it lives outside
 * the workspace but is not itself inside a dependency directory.
 */
export function computeAnchors(
  workspaceFolders: string[],
  primaryFile?: string,
): string[] {
  const anchors: string[] = [];
  const seen = new Set<string>();
  const add = (p: string): void => {
    if (!p) return;
    const n = normalizePath(p);
    if (n === '.' || seen.has(n)) return;
    seen.add(n);
    anchors.push(n);
  };

  for (const w of workspaceFolders) add(w);

  if (primaryFile) {
    const f = normalizePath(primaryFile);
    const inWorkspace = workspaceFolders.some(w => isInside(f, w));
    if (!inWorkspace && !isDependencyPath(f)) add(path.dirname(f));
  }
  return anchors;
}

/**
 * Bounded recursive scan of an anchor for source files, skipping hidden
 * entries and dependency/generated directories.
 */
export function collectSourceFiles(
  anchor: string,
  maxFiles = 4000,
  maxDepth = 8,
): string[] {
  const results: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth || results.length >= maxFiles) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= maxFiles) return;
      const name = entry.name;
      if (name.startsWith('.') || NON_PROJECT_DIRS.has(name)) continue;
      const full = path.join(dir, name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (
        entry.isFile() &&
        SOURCE_EXTENSIONS.has(path.extname(name).toLowerCase())
      ) {
        results.push(full);
      }
    }
  };
  walk(anchor, 0);
  return results;
}
