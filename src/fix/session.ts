import * as vscode from 'vscode';
import type { ErrorAnalysisResult } from '../config';
import type { FixDecorationManager } from './decoration';
import type { FileSnapshot, FixHunk, FixHunkStatus, FixSession } from './types';
import { findLineRange, normalizeLine } from './validator';
import { buildFilePreview, buildFinalLines, type FilePreview } from './preview';

export interface FixHunkView {
  id: string;
  file: string;
  reason: string;
  status: FixHunkStatus;
  line: number;
  oldLines: string[];
  newLines: string[];
}

export interface FixViewSnapshot {
  total: number;
  pending: number;
  accepted: number;
  rejected: number;
  stale: number;
  canUndoAll: boolean;
  hunks: FixHunkView[];
  /** Per-file virtual documents rendered in the fix preview tab. */
  files: FilePreview[];
}

export interface FinishResult {
  written: string[];
  skipped: string[];
  failed: string[];
  cancelled: boolean;
}

export interface FixSessionManagerDeps {
  decorations: FixDecorationManager;
  onStateChanged: (snapshot: FixViewSnapshot | null) => void;
}

/**
 * Owns the single active fix session. Nothing is written to disk while the
 * session is active: accept/reject only mutate in-memory hunk state, the
 * preview tab renders a virtual document, and finish() writes all accepted
 * changes to the real files (after re-validating each file against its
 * original snapshot).
 */
export class FixSessionManager {
  private session: FixSession | null = null;
  private readonly hunkLines = new Map<string, number>();
  private finishing = false;

  constructor(private readonly deps: FixSessionManagerDeps) {}

  get active(): boolean {
    return this.session !== null;
  }

  async start(error: ErrorAnalysisResult, hunks: FixHunk[]): Promise<void> {
    this.end();
    this.session = {
      id: `fix-${Date.now()}`,
      errorKey: `${error.errorType}:${error.filePath}`,
      hunks: hunks.map(h => ({ ...h, status: 'pending' as FixHunkStatus })),
      startedAt: Date.now(),
      snapshots: new Map(),
      staleFiles: new Set(),
    };
    await this.refresh();
  }

  /**
   * Re-validate every file against its snapshot and rebuild the preview.
   * Called on every hunk state change and on external text-document changes.
   */
  async refresh(): Promise<void> {
    if (this.finishing) return;
    const session = this.session;
    if (!session) return;

    const byFile = new Map<string, FixHunk[]>();
    for (const h of session.hunks) {
      const list = byFile.get(h.file) || [];
      list.push(h);
      byFile.set(h.file, list);
    }

    this.hunkLines.clear();

    for (const [file, hunks] of byFile) {
      let current: FileSnapshot | null = null;
      try {
        const doc = await vscode.workspace.openTextDocument(file);
        const lines: string[] = [];
        for (let i = 0; i < doc.lineCount; i++) lines.push(doc.lineAt(i).text);
        current = { lines, endsWithNewline: doc.getText().endsWith('\n') };
      } catch {
        current = null;
      }

      const snapshot = session.snapshots.get(file);
      if (!snapshot) {
        if (!current) {
          this.markAllStale(hunks);
          session.staleFiles.add(file);
          continue;
        }
        session.snapshots.set(file, current);
      } else if (!current || !sameLines(current.lines, snapshot.lines)) {
        this.markAllStale(hunks);
        session.staleFiles.add(file);
        continue;
      }

      const base = session.snapshots.get(file)!.lines;
      const edits: Array<{ hunk: FixHunk; startLine: number; endLine: number }> = [];
      for (const h of hunks) {
        if (h.status === 'stale') continue;
        const range = findLineRange(base, h.oldLines);
        if (!range) {
          h.status = 'stale';
          continue;
        }
        this.hunkLines.set(h.id, range.startLine + 1);
        edits.push({ hunk: h, startLine: range.startLine, endLine: range.endLine });
      }
      edits.sort((a, b) => a.startLine - b.startLine);
      let cursor = -1;
      for (const e of edits) {
        if (e.startLine <= cursor) {
          e.hunk.status = 'stale';
          this.hunkLines.delete(e.hunk.id);
          continue;
        }
        cursor = e.endLine;
      }
    }

    if (!this.finishing && this.session === session) {
      this.deps.decorations.render(session);
      this.deps.onStateChanged(this.buildSnapshot(session));
    }
  }

  async accept(hunkId: string): Promise<void> {
    const hunk = this.session?.hunks.find(h => h.id === hunkId);
    if (!hunk || hunk.status !== 'pending') return;
    hunk.status = 'accepted';
    await this.refresh();
  }

  async reject(hunkId: string): Promise<void> {
    const hunk = this.session?.hunks.find(h => h.id === hunkId);
    if (!hunk || hunk.status !== 'pending') return;
    hunk.status = 'rejected';
    await this.refresh();
  }

  async acceptAll(): Promise<void> {
    const session = this.session;
    if (!session) return;
    for (const hunk of session.hunks) {
      if (hunk.status === 'pending') hunk.status = 'accepted';
    }
    await this.refresh();
  }

  async rejectAll(): Promise<void> {
    const session = this.session;
    if (!session) return;
    for (const hunk of session.hunks) {
      if (hunk.status === 'pending') hunk.status = 'rejected';
    }
    await this.refresh();
  }

  async undoAll(): Promise<void> {
    const session = this.session;
    if (!session) return;
    for (const hunk of session.hunks) {
      if (hunk.status === 'accepted') hunk.status = 'pending';
    }
    await this.refresh();
  }

  /**
   * Finish the fix: write all accepted hunks into the real files and end the
   * session. Files that changed since the snapshot are skipped. Unconfirmed
   * hunks are not written (the user is warned first).
   */
  async finish(): Promise<FinishResult> {
    const session = this.session;
    if (!session) return { written: [], skipped: [], failed: [], cancelled: false };

    const pendingCount = session.hunks.filter(h => h.status === 'pending').length;
    if (pendingCount > 0) {
      const choice = await vscode.window.showWarningMessage(
        `还有 ${pendingCount} 处修改未确认，这些修改将不会写入。确定结束修复？`,
        { modal: true },
        '确定结束',
      );
      if (choice !== '确定结束') {
        return { written: [], skipped: [], failed: [], cancelled: true };
      }
    }

    this.finishing = true;
    const written: string[] = [];
    const skipped: string[] = [];
    const failed: string[] = [];

    const byFile = new Map<string, FixHunk[]>();
    for (const h of session.hunks) {
      if (h.status !== 'accepted') continue;
      const list = byFile.get(h.file) || [];
      list.push(h);
      byFile.set(h.file, list);
    }

    for (const [file, hunks] of byFile) {
      const snapshot = session.snapshots.get(file);
      if (!snapshot) {
        skipped.push(file);
        continue;
      }
      try {
        const doc = await vscode.workspace.openTextDocument(file);
        const currentLines: string[] = [];
        for (let i = 0; i < doc.lineCount; i++) currentLines.push(doc.lineAt(i).text);
        if (!sameLines(currentLines, snapshot.lines)) {
          skipped.push(file);
          continue;
        }

        const finalLines = buildFinalLines(snapshot.lines, hunks);
        const finalText = finalLines.join('\n') + (snapshot.endsWithNewline ? '\n' : '');
        const fullRange = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
        const edit = new vscode.WorkspaceEdit();
        edit.replace(doc.uri, fullRange, finalText);
        const applied = await vscode.workspace.applyEdit(edit);
        if (!applied) {
          failed.push(file);
          continue;
        }
        const saved = await doc.save();
        if (!saved) {
          failed.push(file);
          continue;
        }
        written.push(file);
      } catch {
        failed.push(file);
      }
    }

    this.finishing = false;
    this.end();
    return { written, skipped, failed, cancelled: false };
  }

  async openHunk(hunkId: string): Promise<void> {
    const session = this.session;
    const hunk = session?.hunks.find(h => h.id === hunkId);
    if (!session || !hunk) return;
    const line = this.hunkLines.get(hunkId);
    if (!line) return;
    try {
      const doc = await vscode.workspace.openTextDocument(hunk.file);
      const editor = await vscode.window.showTextDocument(doc);
      const lineIdx = Math.max(0, line - 1);
      const range = doc.lineAt(Math.min(lineIdx, doc.lineCount - 1)).range;
      editor.selection = new vscode.Selection(range.start, range.end);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
    } catch { /* file may be gone */ }
  }

  getSnapshot(): FixViewSnapshot | null {
    return this.session ? this.buildSnapshot(this.session) : null;
  }

  end(): void {
    if (!this.session) return;
    this.session.endedAt = Date.now();
    this.session = null;
    this.hunkLines.clear();
    this.deps.decorations.clear();
    this.deps.onStateChanged(null);
  }

  private markAllStale(hunks: FixHunk[]): void {
    for (const h of hunks) h.status = 'stale';
  }

  private buildSnapshot(session: FixSession): FixViewSnapshot {
    let pending = 0;
    let accepted = 0;
    let rejected = 0;
    let stale = 0;
    const hunks: FixHunkView[] = [];
    for (const h of session.hunks) {
      if (h.status === 'pending') pending++;
      else if (h.status === 'accepted') accepted++;
      else if (h.status === 'rejected') rejected++;
      else stale++;
      hunks.push({
        id: h.id,
        file: h.file,
        reason: h.reason,
        status: h.status,
        line: this.hunkLines.get(h.id) || 0,
        oldLines: h.oldLines,
        newLines: h.newLines,
      });
    }

    const byFile = new Map<string, FixHunk[]>();
    for (const h of session.hunks) {
      const list = byFile.get(h.file) || [];
      list.push(h);
      byFile.set(h.file, list);
    }

    const files: FilePreview[] = [];
    for (const [file, hs] of byFile) {
      const snapshot = session.snapshots.get(file);
      if (!snapshot) continue;
      if (session.staleFiles.has(file)) {
        files.push({ file, stale: true, blocks: [], addedCount: 0, removedCount: 0 });
        continue;
      }
      files.push(buildFilePreview(snapshot.lines, hs, file));
    }

    return {
      total: session.hunks.length,
      pending,
      accepted,
      rejected,
      stale,
      canUndoAll: accepted > 0,
      hunks,
      files,
    };
  }
}

/** Line-by-line equality, tolerant of trailing \r (CRLF files). */
function sameLines(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (normalizeLine(a[i]) !== normalizeLine(b[i])) return false;
  }
  return true;
}
