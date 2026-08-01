import * as vscode from 'vscode';
import type { ErrorAnalysisResult } from '../config';
import type { FixDecorationManager } from './decoration';
import type { FixHunk, FixHunkStatus, FixSession } from './types';
import { findLineRange, findLineRangeAt, normalizeLine, type LineRange } from './validator';

export interface FixHunkView {
  id: string;
  file: string;
  reason: string;
  status: FixHunkStatus;
  line: number;
}

export interface FixViewSnapshot {
  total: number;
  pending: number;
  accepted: number;
  rejected: number;
  stale: number;
  canUndoAll: boolean;
  hunks: FixHunkView[];
}

export interface FixSessionManagerDeps {
  decorations: FixDecorationManager;
  onStateChanged: (snapshot: FixViewSnapshot | null) => void;
}

/**
 * Owns the single active fix session: validation, per-hunk apply, undo-all,
 * and lifecycle tied to the current error.
 */
export class FixSessionManager {
  private session: FixSession | null = null;
  private acceptOrder = 0;
  private readonly hunkLines = new Map<string, number>();

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
    };
    await this.refresh();
  }

  async refresh(): Promise<void> {
    const session = this.session;
    if (!session) return;

    this.hunkLines.clear();
    for (const hunk of session.hunks) {
      if (hunk.status !== 'pending') continue;
      const range = await this.findRange(hunk);
      if (range) {
        this.hunkLines.set(hunk.id, range.startLine + 1);
      } else {
        hunk.status = 'stale';
      }
    }

    this.deps.decorations.render(session);
    this.deps.onStateChanged(this.buildSnapshot(session));
  }

  async accept(hunkId: string): Promise<void> {
    const session = this.session;
    const hunk = session?.hunks.find(h => h.id === hunkId);
    if (!session || !hunk || hunk.status !== 'pending') return;

    const range = await this.findRange(hunk);
    if (!range) {
      hunk.status = 'stale';
      await this.refresh();
      return;
    }

    try {
      const doc = await vscode.workspace.openTextDocument(hunk.file);
      const editor = await vscode.window.showTextDocument(doc);
      const afterLine = range.endLine + 1 < doc.lineCount
        ? normalizeLine(doc.lineAt(range.endLine + 1).text)
        : null;
      const newText = hunk.newLines.length > 0 ? hunk.newLines.join('\n') + '\n' : '';
      const applied = await editor.edit(builder => {
        builder.replace(fullLineRange(doc, range.startLine, range.endLine), newText);
      });

      if (applied) {
        hunk.status = 'accepted';
        hunk.applied = { startLine: range.startLine, endLine: range.endLine, afterLine, order: ++this.acceptOrder };
      } else {
        hunk.status = 'stale';
      }
    } catch {
      hunk.status = 'stale';
    }
    await this.refresh();
  }

  async reject(hunkId: string): Promise<void> {
    const session = this.session;
    const hunk = session?.hunks.find(h => h.id === hunkId);
    if (!session || !hunk || hunk.status !== 'pending') return;
    hunk.status = 'rejected';
    await this.refresh();
  }

  async acceptAll(): Promise<void> {
    const pendingIds = this.session?.hunks.filter(h => h.status === 'pending').map(h => h.id) || [];
    for (const id of pendingIds) {
      await this.accept(id);
    }
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
    const accepted = session.hunks
      .filter(h => h.status === 'accepted' && h.applied)
      .sort((a, b) => (a.applied?.order || 0) - (b.applied?.order || 0));
    let failed = false;

    for (const hunk of [...accepted].reverse()) {
      const restored = await this.undoOne(hunk);
      if (restored) {
        hunk.status = 'pending';
        hunk.applied = undefined;
      } else {
        hunk.status = 'stale';
        failed = true;
      }
    }
    if (failed) {
      void vscode.window.showWarningMessage('ErrAnalyst: 部分修改无法撤销（文件已被手动改动），已标记为失效');
    }
    await this.refresh();
  }

  async openHunk(hunkId: string): Promise<void> {
    const session = this.session;
    const hunk = session?.hunks.find(h => h.id === hunkId);
    if (!session || !hunk) return;
    const line = this.hunkLines.get(hunkId) || hunk.applied?.startLine;
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

  end(): void {
    if (!this.session) return;
    this.session.endedAt = Date.now();
    this.session = null;
    this.hunkLines.clear();
    this.deps.decorations.clear();
    this.deps.onStateChanged(null);
  }

  private async findRange(hunk: FixHunk): Promise<LineRange | null> {
    try {
      const doc = await vscode.workspace.openTextDocument(hunk.file);
      const lines: string[] = [];
      for (let i = 0; i < doc.lineCount; i++) lines.push(doc.lineAt(i).text);
      return findLineRange(lines, hunk.oldLines);
    } catch {
      return null;
    }
  }

  private async undoOne(hunk: FixHunk): Promise<boolean> {
    const applied = hunk.applied;
    if (!applied) return false;
    try {
      const doc = await vscode.workspace.openTextDocument(hunk.file);
      const editor = await vscode.window.showTextDocument(doc);

      if (hunk.newLines.length === 0) {
        // Deletion: verify the expected following line is still in place.
        if (applied.afterLine === null) {
          if (doc.lineCount !== applied.startLine) return false;
        } else {
          if (doc.lineCount <= applied.startLine) return false;
          if (normalizeLine(doc.lineAt(applied.startLine).text) !== normalizeLine(applied.afterLine)) return false;
        }
        return await editor.edit(builder => {
          builder.insert(new vscode.Position(applied.startLine, 0), hunk.oldLines.join('\n') + '\n');
        });
      }

      const lines: string[] = [];
      for (let i = 0; i < doc.lineCount; i++) lines.push(doc.lineAt(i).text);
      const range = findLineRangeAt(lines, hunk.newLines, applied.startLine) || findLineRange(lines, hunk.newLines);
      if (!range) return false;
      return await editor.edit(builder => {
        builder.replace(fullLineRange(doc, range.startLine, range.endLine), hunk.oldLines.join('\n') + '\n');
      });
    } catch {
      return false;
    }
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
      });
    }
    return {
      total: session.hunks.length,
      pending,
      accepted,
      rejected,
      stale,
      canUndoAll: accepted > 0,
      hunks,
    };
  }
}

/** Replace whole lines (including their trailing line break) for clean line edits. */
function fullLineRange(doc: vscode.TextDocument, startLine: number, endLine: number): vscode.Range {
  const startPos = new vscode.Position(startLine, 0);
  const endPos = endLine + 1 < doc.lineCount
    ? new vscode.Position(endLine + 1, 0)
    : doc.positionAt(doc.getText().length);
  return new vscode.Range(startPos, endPos);
}
