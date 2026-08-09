import * as fs from 'fs';
import * as path from 'path';
import type { ParsedTraceback } from '../parser';
import {
  collectCandidates,
  sortCandidates,
  type FileCandidate,
  type ScoringParams,
  DEFAULT_SCORING_PARAMS,
} from './scorer';
import {
  collectSourceFiles,
  computeAnchors,
  isProjectFile,
} from './projectFiles';
import { sanitizeConfigText } from './sanitize';

// ── Public types ──

export interface FileContext {
  path: string;
  source: string;         // unique label for this candidate's origin
  startLine: number;
  endLine: number;
  content: string;
}

export interface BuiltContext {
  mainFile?: FileContext;
  stackFiles: FileContext[];
  configFiles: FileContext[];
  siblingFiles: FileContext[];
  guessedFiles: FileContext[];
  workspaceRoot?: string;
  anchors: string[];
}

// ── Config file candidates (fixed list, checked at each anchor root) ──

const CONFIG_CANDIDATES = [
  'package.json', 'tsconfig.json', 'requirements.txt',
  'pyproject.toml', '.env', '.env.local', '.env.development', '.env.production',
  'Makefile', 'Pipfile', 'setup.py', 'setup.cfg', 'tox.ini',
  'config.json', 'config.yaml', 'config.yml', 'config.toml', 'config.ini',
  'settings.json', 'application.yml',
  'docker-compose.yml', 'docker-compose.yaml', '.npmrc', '.pypirc',
];

// ── Entry-point files checked by the guess stage ──

const ENTRY_FILES = [
  'main.py', 'app.py', 'agent.py', 'cli.py', 'server.py',
  'index.js', 'index.ts', 'index.jsx', 'index.tsx',
  'main.js', 'main.ts', 'main.go', 'main.rs',
];

const MAX_SCAN_FILES = 4000;
const MAX_SCAN_DEPTH = 8;
const MAX_SIBLING_CANDIDATES = 20;

// ── ContextBuilder ──

export class ContextBuilder {
  private params: ScoringParams;

  constructor(params: Partial<ScoringParams> = {}) {
    this.params = { ...DEFAULT_SCORING_PARAMS, ...params };
  }

  /**
   * Build context from a parsed traceback and workspace folders.
   *
   * Only project files (inside an anchor, outside dependency/generated dirs)
   * become candidates; system files are excluded even when they appear in the
   * call stack. When no project frame exists, likely user files are guessed.
   */
  build(
    traceback: ParsedTraceback,
    workspaceFolders: string[],
    activeFile?: string,
  ): BuiltContext {
    const anchors = computeAnchors(workspaceFolders, traceback.filePath);
    const ctx: BuiltContext = {
      stackFiles: [],
      configFiles: [],
      siblingFiles: [],
      guessedFiles: [],
      workspaceRoot: workspaceFolders[0],
      anchors,
    };

    // ── Step 1: stack-frame candidates, project-only ──
    const allFrames = collectCandidates(traceback, this.params);
    const projectFrames = allFrames.filter(c => isProjectFile(c.filePath, anchors));
    const systemFrames = allFrames.filter(c => !isProjectFile(c.filePath, anchors));
    const candidates: FileCandidate[] = [...projectFrames];

    // ── Step 2: guess likely user files when the stack has no project frame ──
    if (projectFrames.length === 0) {
      candidates.push(
        ...this.guessCandidates(traceback, systemFrames, anchors, activeFile),
      );
    }

    // ── Step 3: config candidates (fixed list + code references) ──
    const codeSources = [
      ...projectFrames,
      ...candidates.filter(c => c.source === 'guessed_file'),
    ];
    for (const anchor of anchors) {
      candidates.push(...this.findRootConfigCandidates(anchor));
    }
    candidates.push(...this.findReferencedConfigCandidates(codeSources));

    // ── Step 4: sibling candidates (project-only) ──
    candidates.push(...this.findSiblingCandidates(traceback, anchors, candidates));

    // ── Step 5: greedy selection within char budget ──
    const deduped = this.dedupeCandidates(candidates);
    const sorted = sortCandidates(deduped);
    let totalChars = 0;
    const maxChars = this.params.maxTotalChars;
    const selected: Array<{ candidate: FileCandidate; content: string }> = [];

    for (const cand of sorted) {
      if (totalChars >= maxChars) break;

      const fileContent = this.readFile(
        cand.filePath,
        cand.startLine,
        cand.endLine,
        cand.source === 'config_file',
      );
      if (!fileContent) continue;

      const contentLen = fileContent.content.length;
      if (totalChars + contentLen > maxChars) {
        // Budget exceeded — skip this file
        continue;
      }

      selected.push({ candidate: cand, content: fileContent.content });
      totalChars += contentLen;
    }

    // ── Step 6: classify into output buckets ──
    for (const s of selected) {
      const src = s.candidate.source;
      const fc: FileContext = {
        path: s.candidate.filePath,
        source: src,
        startLine: s.candidate.startLine,
        endLine: s.candidate.endLine,
        content: s.content,
      };

      if (src === 'primary_last_frame') {
        ctx.mainFile = fc;
      } else if (src === 'config_file') {
        ctx.configFiles.push(fc);
      } else if (src === 'sibling_file') {
        ctx.siblingFiles.push(fc);
      } else if (src === 'guessed_file') {
        ctx.guessedFiles.push(fc);
      } else {
        ctx.stackFiles.push(fc);
      }
    }

    return ctx;
  }

  // ── Guess stage ──

  /**
   * Guess likely-fault user files when no project frame exists in the stack.
   * Order: files importing the failing module(s) → active editor file →
   * entry-point files → most recently modified source files.
   */
  private guessCandidates(
    traceback: ParsedTraceback,
    systemFrames: FileCandidate[],
    anchors: string[],
    activeFile?: string,
  ): FileCandidate[] {
    const modules = this.guessModuleNames(traceback, systemFrames);
    const matched = new Map<string, number>();
    const recent: Array<{ file: string; mtime: number }> = [];

    for (const anchor of anchors) {
      for (const file of collectSourceFiles(anchor, MAX_SCAN_FILES, MAX_SCAN_DEPTH)) {
        try {
          recent.push({ file, mtime: fs.statSync(file).mtimeMs });
        } catch {
          // unreadable file — ignore
        }
        if (modules.length === 0) continue;
        const hits = this.fileImportsModule(file, modules);
        if (hits > 0) {
          matched.set(file, (matched.get(file) ?? 0) + hits);
        }
      }
    }

    const guessedPaths = new Set<string>();
    const out: FileCandidate[] = [];
    const push = (filePath: string): void => {
      const n = path.normalize(filePath);
      if (guessedPaths.has(n)) return;
      if (!isProjectFile(n, anchors)) return;
      if (!fs.existsSync(n)) return;
      guessedPaths.add(n);
      out.push({
        filePath: n,
        priority: this.params.guessedFilePriority,
        startLine: 1,
        endLine: this.params.guessedFileLines,
        source: 'guessed_file',
      });
    };

    // 1) files importing the failing module(s) — strongest signal
    const byMatches = [...matched.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    );
    for (const [file] of byMatches) {
      if (out.length >= this.params.guessedFileMax) break;
      push(file);
    }

    // 2) active editor file
    if (out.length < this.params.guessedFileMax && activeFile) {
      push(activeFile);
    }

    // 3) entry-point files at each anchor root
    for (const anchor of anchors) {
      for (const name of ENTRY_FILES) {
        if (out.length >= this.params.guessedFileMax) break;
        push(path.join(anchor, name));
      }
    }

    // 4) most recently modified source files
    recent.sort((a, b) => b.mtime - a.mtime);
    for (const r of recent) {
      if (out.length >= this.params.guessedFileMax) break;
      push(r.file);
    }

    return out;
  }

  /** Derive module names from system frames and the error message. */
  private guessModuleNames(
    traceback: ParsedTraceback,
    systemFrames: FileCandidate[],
  ): string[] {
    const names: string[] = [];
    const seen = new Set<string>();
    const add = (raw: string): void => {
      const top = raw.trim().split('.')[0].split(/[\\/]/).pop() || '';
      if (!top || seen.has(top)) return;
      seen.add(top);
      names.push(top);
    };

    const depRE = /(?:site-packages|dist-packages|node_modules)[\\/]+([^\\/]+)/;
    for (const frame of systemFrames) {
      const m = frame.filePath.match(depRE);
      if (m) add(m[1]);
    }

    const message = traceback.errorMessage || '';
    const patterns = [
      /No module named ['"]([^'"]+)/,
      /Cannot find module ['"]([^'"]+)/i,
      /Can't resolve ['"]([^'"]+)/i,
    ];
    for (const pattern of patterns) {
      const m = message.match(pattern);
      if (m) add(m[1]);
    }
    return names.slice(0, 5);
  }

  /** Count how many of the given modules a source file imports. */
  private fileImportsModule(filePath: string, modules: string[]): number {
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      return 0;
    }
    const head = content.slice(0, 64 * 1024);
    let hits = 0;
    for (const mod of modules) {
      const escaped = mod.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(
        `\\b(?:import\\s+['"]?${escaped}|from\\s+${escaped}\\s+import|` +
        `require\\s*\\(\\s*['"]${escaped}|import\\s*\\(\\s*['"]${escaped})`,
      );
      if (re.test(head)) hits++;
    }
    return hits;
  }

  // ── Config discovery ──

  /** Fixed config-name list at an anchor root, plus `.env.*` variants. */
  private findRootConfigCandidates(anchor: string): FileCandidate[] {
    const out: FileCandidate[] = [];
    const seen = new Set<string>();
    const add = (fullPath: string): void => {
      const n = path.normalize(fullPath);
      if (seen.has(n)) return;
      seen.add(n);
      if (!fs.existsSync(n)) return;
      out.push({
        filePath: n,
        priority: this.params.configFilePriority,
        startLine: 1,
        endLine: this.params.configFileLines,
        source: 'config_file',
      });
    };

    for (const name of CONFIG_CANDIDATES) add(path.join(anchor, name));

    try {
      for (const entry of fs.readdirSync(anchor)) {
        if (/^\.env(\.[a-zA-Z0-9_-]+)?$/.test(entry)) add(path.join(anchor, entry));
      }
    } catch {
      // anchor not readable — skip
    }

    return out;
  }

  /**
   * Config files explicitly referenced by project code, e.g.
   * `load_dotenv('.env')` or `json.load(open('config.json'))`.
   */
  private findReferencedConfigCandidates(
    sources: FileCandidate[],
  ): FileCandidate[] {
    const out: FileCandidate[] = [];
    const seen = new Set<string>();
    const add = (fullPath: string): void => {
      const n = path.normalize(fullPath);
      if (seen.has(n)) return;
      seen.add(n);
      if (!fs.existsSync(n)) return;
      out.push({
        filePath: n,
        priority: this.params.configFilePriority,
        startLine: 1,
        endLine: this.params.configFileLines,
        source: 'config_file',
      });
    };

    const literalRE = /['"]([^'"]+\.(?:env|json|ya?ml|toml|ini|cfg|conf)(?:\.[a-zA-Z0-9_-]+)?)['"]/gi;
    const callRE = /(?:open|load|read|dotenv|env_file|config)/i;

    for (const cand of sources) {
      let content: string;
      try {
        content = fs.readFileSync(cand.filePath, 'utf-8');
      } catch {
        continue;
      }
      const head = content.slice(0, 200 * 1024);
      for (const line of head.split('\n')) {
        if (!callRE.test(line)) continue;
        const matches = line.match(literalRE);
        if (!matches) continue;
        for (const lit of matches) {
          const rel = lit.slice(1, -1);
          add(path.resolve(path.dirname(cand.filePath), rel));
        }
      }
    }
    return out;
  }

  // ── Sibling candidates ──

  /** Same-directory files of the last frame, only when the frame is a project file. */
  private findSiblingCandidates(
    traceback: ParsedTraceback,
    anchors: string[],
    existing: FileCandidate[],
  ): FileCandidate[] {
    const out: FileCandidate[] = [];
    if (traceback.stackFrames.length === 0) return out;

    const lastFrame = traceback.stackFrames[traceback.stackFrames.length - 1];
    if (!isProjectFile(lastFrame.file, anchors)) return out;

    const dir = path.dirname(lastFrame.file);
    const ext = path.extname(lastFrame.file);
    const seenFiles = new Set(existing.map(c => path.normalize(c.filePath)));
    seenFiles.add(path.normalize(lastFrame.file));

    try {
      const entries = fs.readdirSync(dir);
      for (const entry of entries) {
        if (out.length >= MAX_SIBLING_CANDIDATES) break;
        const fullPath = path.join(dir, entry);
        if (seenFiles.has(path.normalize(fullPath))) continue;
        if (!entry.endsWith(ext)) continue;
        if (!isProjectFile(fullPath, anchors)) continue;
        out.push({
          filePath: fullPath,
          priority: this.params.siblingFilePriority,
          startLine: 1,
          endLine: this.params.siblingFileLines,
          source: 'sibling_file',
        });
        seenFiles.add(path.normalize(fullPath));
      }
    } catch {
      // directory not found — skip
    }
    return out;
  }

  // ── Private helpers ──

  private dedupeCandidates(candidates: FileCandidate[]): FileCandidate[] {
    const best = new Map<string, FileCandidate>();
    for (const c of candidates) {
      const n = path.normalize(c.filePath);
      const cur = best.get(n);
      if (!cur || c.priority > cur.priority) best.set(n, c);
    }
    return [...best.values()];
  }

  private readFile(
    filePath: string,
    startLine: number,
    endLine: number,
    sanitize = false,
  ): { content: string; startLine: number; endLine: number } | null {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');
      const actualStart = Math.max(0, startLine - 1);
      const actualEnd = Math.min(lines.length, endLine);
      let slice = lines.slice(actualStart, actualEnd).join('\n');
      if (sanitize) slice = sanitizeConfigText(slice, filePath);
      return {
        startLine: actualStart + 1,
        endLine: actualEnd,
        content: slice,
      };
    } catch {
      return null;
    }
  }
}
