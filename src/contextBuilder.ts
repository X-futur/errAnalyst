import * as fs from 'fs';
import * as path from 'path';
import { ErrorAnalysisResult } from './config';

export interface FileContext {
  path: string;
  startLine: number;
  endLine: number;
  content: string;
}

export interface BuiltContext {
  category: string;
  mainFile?: FileContext;
  configFiles: FileContext[];
  relatedFiles: FileContext[];
  workspaceRoot?: string;
}

export class ErrorContextBuilder {
  // Directories to skip when scanning all project files
  private static excludeDirs = new Set([
    'node_modules', '.git', 'out', '.vscode', '.vscode-test',
    '__pycache__', 'dist', 'build', '.next', 'coverage',
    '.cache', 'target', 'bin', 'obj', 'venv', '.env',
  ]);

  // Source file extensions to include in full scan
  private static includeExts = new Set([
    '.ts', '.js', '.tsx', '.jsx', '.mjs', '.cjs', '.mts', '.cts',
    '.py', '.go', '.java', '.rs', '.c', '.cpp', '.h', '.hpp',
    '.json', '.yaml', '.yml', '.toml', '.cfg', '.ini',
    '.env', '.md', '.txt', '.sh', '.bash', '.zsh',
    '.html', '.css', '.scss', '.less', '.vue', '.svelte',
    '.rb', '.php', '.swift', '.kt', '.gradle',
  ]);

  /**
   * Scan ALL project source files in the workspace and build a comprehensive context.
   * Prioritizes error-related files, then reads other source files up to a char limit.
   * This gives the LLM full visibility into the project for accurate analysis.
   */
  /**
   * Build precise file context focused on the error location.
   * P0: Error source file — reads 100 lines centered on the error line
   * P1: Other stack frame files — up to 3 files, 40 lines each
   * P2: Config files — package.json, tsconfig.json, etc.
   * P3: Sibling files in same directory — up to 2 files, 30 lines each
   * Total ~7000 chars to keep within LLM context window.
   */
  static buildPreciseContext(
    result: ErrorAnalysisResult,
    workspaceFolders: string[],
  ): BuiltContext {
    const ctx: BuiltContext = {
      category: result.category || 'UNKNOWN',
      configFiles: [],
      relatedFiles: [],
      workspaceRoot: workspaceFolders[0],
    };

    let totalChars = 0;
    const maxChars = 7000;

    // ── P0: Error source file ──
    // Read 100 lines centered on the error line from traceback or firstErrorLine
    let errorFilePath = result.filePath || '';
    let errorLine = result.lineNumber || 0;

    // If no file from parse(), try extracting from firstErrorLine
    if (!errorFilePath && result.firstErrorLine) {
      const match = result.firstErrorLine.match(/^([^:]+):(\d+)/);
      if (match) {
        errorFilePath = this.resolvePath(match[1], workspaceFolders);
        errorLine = parseInt(match[2], 10);
      }
    }

    if (errorFilePath) {
      const startLine = Math.max(1, errorLine - 60);
      const endLine = errorLine + 40;
      const mainCtx = this.readFile(errorFilePath, startLine, endLine);
      if (mainCtx) {
        ctx.mainFile = mainCtx;
        totalChars += mainCtx.content.length;
      }
    }

    // Track which paths we've already included
    const seenPaths = new Set<string>();
    if (ctx.mainFile) seenPaths.add(ctx.mainFile.path);

    // ── P1: Other stack frame files (up to 3) ──
    for (const frame of result.stackFrames) {
      if (totalChars >= maxChars) break;
      if (!frame.file || seenPaths.has(frame.file)) continue;
      // Skip if same as mainFile
      const resolved = this.resolvePath(frame.file, workspaceFolders);
      if (seenPaths.has(resolved)) continue;

      const startLine = Math.max(1, frame.line - 20);
      const endLine = frame.line + 20;
      const fileCtx = this.readFile(frame.file, startLine, endLine);
      if (fileCtx) {
        ctx.relatedFiles.push(fileCtx);
        seenPaths.add(fileCtx.path);
        totalChars += fileCtx.content.length;
      }
    }
    // Also try to extract file paths from fullTraceback for non-Python errors
    if (result.stackFrames.length === 0 && result.fullTraceback) {
      const genericMatches = result.fullTraceback.matchAll(/at\s+(.+?):(\d+):\d+/g);
      for (const m of genericMatches) {
        if (totalChars >= maxChars) break;
        const fp = this.resolvePath(m[1], workspaceFolders);
        if (seenPaths.has(fp)) continue;
        const fileCtx = this.readFile(fp, Math.max(1, parseInt(m[2],10)-15), parseInt(m[2],10)+15);
        if (fileCtx) {
          ctx.relatedFiles.push(fileCtx);
          seenPaths.add(fp);
          totalChars += fileCtx.content.length;
        }
      }
    }

    // ── P2: Config files ──
    const root = workspaceFolders[0];
    if (root) {
      const configCandidates = [
        'package.json', 'tsconfig.json', 'requirements.txt',
        'pyproject.toml', '.env', 'Makefile',
      ];
      for (const cf of configCandidates) {
        if (totalChars >= maxChars) break;
        this.tryAddConfig(ctx, path.join(root, cf), 30);
        if (ctx.configFiles.length > 0) {
          totalChars += ctx.configFiles[ctx.configFiles.length - 1].content.length;
        }
      }
    }

    // ── P3: Sibling files in same directory as error file ──
    if (ctx.mainFile && root) {
      const dir = path.dirname(ctx.mainFile.path);
      const ext = path.extname(ctx.mainFile.path);
      try {
        const entries = fs.readdirSync(dir);
        let added = 0;
        for (const entry of entries) {
          if (added >= 2) break;
          if (totalChars >= maxChars) break;
          const fullPath = path.join(dir, entry);
          if (seenPaths.has(fullPath)) continue;
          if (entry.endsWith(ext) && entry !== path.basename(ctx.mainFile.path)) {
            const fileCtx = this.readFile(fullPath, 1, 30);
            if (fileCtx) {
              ctx.relatedFiles.push(fileCtx);
              seenPaths.add(fullPath);
              totalChars += fileCtx.content.length;
              added++;
            }
          }
        }
      } catch { /* skip */ }
    }

    return ctx;
  }
  static build(
    category: string,
    result: ErrorAnalysisResult,
    workspaceFolders: string[],
  ): BuiltContext {
    const ctx: BuiltContext = {
      category,
      configFiles: [],
      relatedFiles: [],
      workspaceRoot: workspaceFolders[0],
    };

    switch (category) {
      case 'COMPILATION_ERROR':
        this.buildCompilationContext(ctx, result, workspaceFolders);
        break;
      case 'DEPENDENCY_ERROR':
        this.buildDependencyContext(ctx, workspaceFolders);
        break;
      case 'SYSTEM_ERROR':
        this.buildSystemContext(ctx, workspaceFolders);
        break;
      case 'RUNTIME_ERROR':
        this.buildRuntimeContext(ctx, result, workspaceFolders);
        break;
      default:
        this.buildUnknownContext(ctx, workspaceFolders);
    }
    return ctx;
  }

  /**
   * COMPILATION_ERROR: Read the compiler-reported source file + tsconfig.json + related imports.
   */
  private static buildCompilationContext(
    ctx: BuiltContext, result: ErrorAnalysisResult, workspaceFolders: string[]
  ): void {
    const fEl = result.firstErrorLine || '';
    const fileLineMatch = fEl.match(/^([^:]+):(\d+)/);
    if (!fileLineMatch) return;

    const targetFile = this.resolvePath(fileLineMatch[1], workspaceFolders);
    const targetLine = parseInt(fileLineMatch[2], 10);

    // Read main file with context
    const mainCtx = this.readFile(targetFile, Math.max(0, targetLine - 20), targetLine + 20);
    if (mainCtx) ctx.mainFile = mainCtx;

    // Read project config
    for (const folder of workspaceFolders) {
      this.tryAddConfig(ctx, path.join(folder, 'tsconfig.json'));
    }

    // Read related imports
    if (mainCtx) {
      const baseDir = path.dirname(targetFile);
      const importPaths = this.extractImports(mainCtx.content, baseDir);
      for (const imp of importPaths.slice(0, 3)) {
        const resolvedPath = this.resolvePath(imp, workspaceFolders);
        const relatedCtx = this.readFile(resolvedPath, 1, 30);
        if (relatedCtx) ctx.relatedFiles.push(relatedCtx);
      }
    }
  }

  /**
   * DEPENDENCY_ERROR: Read package.json, requirements.txt, lockfiles, etc.
   */
  private static buildDependencyContext(ctx: BuiltContext, workspaceFolders: string[]): void {
    for (const folder of workspaceFolders) {
      const candidates = [
        'package.json', 'requirements.txt', 'pyproject.toml',
        '.npmrc', 'yarn.lock',
      ];
      for (const cf of candidates) {
        this.tryAddConfig(ctx, path.join(folder, cf), cf.endsWith('.lock') ? 50 : undefined);
      }
    }
  }

  /**
   * SYSTEM_ERROR: Read .env, docker-compose, launch config, package.json scripts.
   */
  private static buildSystemContext(ctx: BuiltContext, workspaceFolders: string[]): void {
    for (const folder of workspaceFolders) {
      const candidates = [
        '.env', 'docker-compose.yml', '.vscode/launch.json',
        'Makefile', 'Procfile', '.env.example', 'package.json',
      ];
      for (const cf of candidates) {
        this.tryAddConfig(ctx, path.join(folder, cf));
      }
    }
  }

  /**
   * RUNTIME_ERROR: Read source files from stack frames (supports multiple languages).
   */
  private static buildRuntimeContext(
    ctx: BuiltContext, result: ErrorAnalysisResult, workspaceFolders: string[]
  ): void {
    const seen = new Set<string>();
    const maxFrames = Math.min(result.stackFrames.length, 5);
    for (let i = 0; i < maxFrames; i++) {
      const frame = result.stackFrames[i];
      if (!frame.file || seen.has(frame.file)) continue;
      seen.add(frame.file);
      const fileCtx = this.readFile(frame.file, Math.max(0, frame.line - 20), frame.line + 20);
      if (fileCtx) ctx.relatedFiles.push(fileCtx);
    }
    // If no stack frames, try parsing generic format: at file:line:col
    if (ctx.relatedFiles.length === 0 && result.errorMessage) {
      const genericMatch = result.errorMessage.match(/at\s+(.+?):(\d+):\d+/);
      if (genericMatch) {
        const fileCtx = this.readFile(genericMatch[1], Math.max(0, parseInt(genericMatch[2], 10) - 20), parseInt(genericMatch[2], 10) + 20);
        if (fileCtx) ctx.relatedFiles.push(fileCtx);
      }
    }
  }

  /**
   * UNKNOWN: Probe workspace root for common config files and entry points.
   */
  private static buildUnknownContext(ctx: BuiltContext, workspaceFolders: string[]): void {
    const root = workspaceFolders[0];
    if (!root) return;
    const candidates = [
      'package.json', 'requirements.txt', 'pyproject.toml',
      'tsconfig.json', 'main.py', 'index.ts', 'index.js',
      'app.ts', 'app.py', 'main.go', 'Cargo.toml',
    ];
    for (const cf of candidates) {
      this.tryAddConfig(ctx, path.join(root, cf));
    }
  }

  // ── helpers ──────────────────────────────────────────────

  private static readFile(filePath: string, startLine: number, endLine: number): FileContext | null {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');
      const actualStart = Math.max(0, startLine - 1);
      const actualEnd = Math.min(lines.length, endLine);
      return {
        path: filePath,
        startLine: actualStart + 1,
        endLine: actualEnd,
        content: lines.slice(actualStart, actualEnd).join('\n'),
      };
    } catch {
      return null;
    }
  }

  private static tryAddConfig(ctx: BuiltContext, filePath: string, maxLines?: number): void {
    try {
      const fullContent = fs.readFileSync(filePath, 'utf-8');
      const lines = fullContent.split('\n');
      const limited = maxLines !== undefined ? lines.slice(0, maxLines).join('\n') : fullContent;
      ctx.configFiles.push({
        path: filePath,
        startLine: 1,
        endLine: maxLines !== undefined ? maxLines : lines.length,
        content: limited,
      });
    } catch { /* file not found — skip */ }
  }

  private static resolvePath(file: string, workspaceFolders: string[]): string {
    if (file.startsWith('/')) return file;
    if (file.startsWith('~')) {
      const homedir = require('os').homedir();
      return file.replace('~', homedir);
    }
    for (const folder of workspaceFolders) {
      const potential = path.join(folder, file);
      if (fs.existsSync(potential)) return potential;
    }
    return file;
  }

  private static extractImports(content: string, baseDir: string): string[] {
    const imports: string[] = [];
    for (const line of content.split('\n')) {
      const ts = line.match(/from\s+['"]([^'"]+)['"]/);
      if (ts && !ts[1].startsWith('.') && !ts[1].startsWith('@')) {
        imports.push(ts[1]);
        continue;
      }
      const rel = line.match(/from\s+['"](\.[^'"]+)['"]/);
      if (rel) {
        imports.push(path.resolve(baseDir, rel[1] + (rel[1].endsWith('.ts') || rel[1].endsWith('.js') ? '' : '.ts')));
      }
    }
    return imports;
  }
}
