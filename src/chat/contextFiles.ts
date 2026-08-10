import * as fs from 'fs';
import * as path from 'path';
import type { ChatAutoFileInput, ChatContextFileView } from './types';
import { isConfigLikePath, sanitizeConfigText } from '../context/sanitize';

export const MAX_FILE_CHARS = 7000;
export const MAX_TOTAL_CHARS = 16000;

const BINARY_SNIFF_BYTES = 8192;

interface ChatContextFileEntry {
  id: string;
  path: string;
  source: 'auto' | 'user';
  startLine: number;
  endLine: number;
  fullContent?: boolean;
  snapshotContent?: string;
}

export interface AddFileResult {
  path: string;
  ok: boolean;
  error?: string;
}

export interface ContextPayload {
  payload: string;
  views: ChatContextFileView[];
}

interface FileState {
  entry: ChatContextFileEntry;
  content: string;
  truncated: boolean;
  skipped: boolean;
  changed: boolean;
  unavailable: boolean;
}

/**
 * Owns the chat context file set: auto-loaded files from the analysis prompt,
 * plus user-added files. Current file content is re-read when building payloads.
 */
export class ChatContextManager {
  private autoFiles: ChatContextFileEntry[] = [];
  private userFiles: ChatContextFileEntry[] = [];
  private removedAutoIds = new Set<string>();
  private idCounter = 0;

  setAutoFiles(inputs: ChatAutoFileInput[]): void {
    this.autoFiles = inputs
      .filter(f => !this.removedAutoIds.has(this.autoId(f.path)))
      .map(f => ({
        id: this.autoId(f.path),
        path: f.path,
        source: 'auto' as const,
        startLine: f.startLine,
        endLine: f.endLine,
        fullContent: f.fullContent,
        snapshotContent: f.content,
      }));
  }

  restoreDefaults(): void {
    this.removedAutoIds.clear();
    this.userFiles = [];
  }

  removeFile(id: string): void {
    this.autoFiles = this.autoFiles.filter(f => f.id !== id);
    this.userFiles = this.userFiles.filter(f => f.id !== id);
    this.removedAutoIds.add(id);
  }

  async addUserFiles(paths: string[]): Promise<AddFileResult[]> {
    const results: AddFileResult[] = [];
    for (const rawPath of paths) {
      const resolved = path.resolve(rawPath);
      if (this.allEntries().some(f => path.normalize(f.path) === path.normalize(resolved))) {
        results.push({ path: rawPath, ok: false, error: '文件已在对话上下文中' });
        continue;
      }
      const info = this.inspectUserFile(resolved);
      if (!info.ok) {
        results.push({ path: rawPath, ok: false, error: info.error });
        continue;
      }
      this.userFiles.push({
        id: `user-${Date.now()}-${this.idCounter++}`,
        path: resolved,
        source: 'user',
        startLine: 1,
        endLine: info.lineCount,
      });
      results.push({ path: rawPath, ok: true });
    }
    return results;
  }

  getViews(): ChatContextFileView[] {
    return this.computeState().map(s => this.toView(s));
  }

  buildPayload(): ContextPayload {
    const states = this.computeState();
    const parts: string[] = [];
    for (const s of states) {
      if (s.skipped || s.unavailable) continue;
      const f = s.entry;
      const flags = [
        f.source === 'auto' ? 'auto' : 'user',
        f.fullContent ? '完整' : '',
        s.changed ? '已变化' : '',
        s.truncated ? '已截断，仅前 ' + MAX_FILE_CHARS + ' 字符' : '',
      ].filter(Boolean).join('，');
      parts.push(`### ${f.path}:${f.startLine}-${f.endLine} (${flags})`);
      parts.push('```');
      parts.push(s.content);
      parts.push('```');
      parts.push('');
    }
    return { payload: parts.join('\n'), views: states.map(s => this.toView(s)) };
  }

  getAllowedFilePaths(): string[] {
    return this.computeState()
      .filter(s => !s.skipped && !s.unavailable)
      .map(s => s.entry.path);
  }

  private computeState(): FileState[] {
    const states: FileState[] = [];
    let total = 0;
    for (const entry of this.allEntries()) {
      const guaranteed = entry.source === 'auto' && entry.fullContent === true;
      const state: FileState = {
        entry,
        content: '',
        truncated: false,
        skipped: false,
        changed: false,
        unavailable: false,
      };
      let content: string | null = null;
      try {
        content = guaranteed
          ? fs.readFileSync(entry.path, 'utf-8')
          : entry.source === 'auto'
            ? this.readRange(entry.path, entry.startLine, entry.endLine)
            : fs.readFileSync(entry.path, 'utf-8');
      } catch {
        state.unavailable = true;
        states.push(state);
        continue;
      }
      // Config files are sent to the LLM with sensitive values redacted.
      content = isConfigLikePath(entry.path) ? sanitizeConfigText(content, entry.path) : content;
      if (entry.source === 'auto' && entry.snapshotContent !== undefined && content !== entry.snapshotContent) {
        state.changed = true;
      }
      if (!guaranteed && content.length > MAX_FILE_CHARS) {
        content = content.slice(0, MAX_FILE_CHARS);
        state.truncated = true;
      }
      if (!guaranteed && total + content.length > MAX_TOTAL_CHARS) {
        state.skipped = true;
        content = '';
      } else {
        total += content.length;
      }
      state.content = content;
      states.push(state);
    }
    return states;
  }

  private inspectUserFile(filePath: string): { ok: true; lineCount: number } | { ok: false; error: string } {
    try {
      const fd = fs.openSync(filePath, 'r');
      try {
        const head = Buffer.alloc(BINARY_SNIFF_BYTES);
        const bytes = fs.readSync(fd, head, 0, head.length, 0);
        if (head.subarray(0, bytes).includes(0)) {
          return { ok: false, error: '二进制文件不支持' };
        }
      } finally {
        fs.closeSync(fd);
      }
      const content = fs.readFileSync(filePath, 'utf-8');
      return { ok: true, lineCount: content.split('\n').length };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  private readRange(filePath: string, startLine: number, endLine: number): string {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    const start = Math.max(0, startLine - 1);
    const end = Math.min(lines.length, endLine);
    return lines.slice(start, end).join('\n');
  }

  private allEntries(): ChatContextFileEntry[] {
    return [...this.autoFiles, ...this.userFiles];
  }

  private autoId(filePath: string): string {
    return 'auto:' + path.normalize(filePath);
  }

  private toView(s: FileState): ChatContextFileView {
    return {
      id: s.entry.id,
      path: s.entry.path,
      source: s.entry.source,
      startLine: s.entry.startLine,
      endLine: s.entry.endLine,
      fullContent: s.entry.fullContent,
      truncated: s.truncated,
      skipped: s.skipped,
      changed: s.changed,
      unavailable: s.unavailable,
    };
  }
}
