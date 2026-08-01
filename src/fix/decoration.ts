import * as vscode from 'vscode';
import type { FixHunk, FixSession } from './types';
import { diffLines, findLineRange } from './validator';

const ADDED_BG = 'rgba(46, 160, 67, 0.22)';
const REMOVED_BG = 'rgba(196, 43, 28, 0.22)';

/**
 * Renders pending fix hunks as green/red editor decorations and provides
 * per-hunk CodeLens actions (accept / reject).
 */
export class FixDecorationManager implements vscode.CodeLensProvider {
  private session: FixSession | null = null;
  private readonly addedType: vscode.TextEditorDecorationType;
  private readonly removedType: vscode.TextEditorDecorationType;

  constructor() {
    this.addedType = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      after: {
        backgroundColor: ADDED_BG,
        color: '#6a9955',
        margin: '0 0 0 12px',
      },
    });
    this.removedType = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: REMOVED_BG,
      textDecoration: 'line-through',
    });
  }

  render(session: FixSession | null): void {
    this.session = session;
    for (const editor of vscode.window.visibleTextEditors) {
      editor.setDecorations(this.addedType, []);
      editor.setDecorations(this.removedType, []);
    }
    if (!session) return;

    const addedByEditor = new Map<string, vscode.DecorationOptions[]>();
    const removedByEditor = new Map<string, vscode.Range[]>();

    for (const hunk of session.hunks) {
      if (hunk.status !== 'pending') continue;
      const editor = vscode.window.visibleTextEditors.find(e => e.document.uri.fsPath === hunk.file);
      if (!editor) continue;

      const range = this.findHunkRange(editor.document, hunk);
      if (!range) continue;

      const diff = diffLines(hunk.oldLines, hunk.newLines);
      for (const idx of diff.removed) {
        const line = editor.document.lineAt(range.startLine + idx);
        const list = removedByEditor.get(hunk.file) || [];
        list.push(line.range);
        removedByEditor.set(hunk.file, list);
      }
      if (diff.added.length > 0) {
        const anchorLine = range.startLine + hunk.oldLines.length - 1;
        const anchorRange = editor.document.lineAt(anchorLine).range;
        const list = addedByEditor.get(hunk.file) || [];
        list.push({
          range: anchorRange,
          hoverMessage: '新增/修改行（绿色）',
          renderOptions: {
            after: {
              contentText: diff.added.map(i => hunk.newLines[i]).join('\n'),
            },
          },
        });
        addedByEditor.set(hunk.file, list);
      }
    }

    for (const editor of vscode.window.visibleTextEditors) {
      const key = editor.document.uri.fsPath;
      editor.setDecorations(this.addedType, addedByEditor.get(key) || []);
      editor.setDecorations(this.removedType, removedByEditor.get(key) || []);
    }
  }

  clear(): void {
    this.session = null;
    for (const editor of vscode.window.visibleTextEditors) {
      editor.setDecorations(this.addedType, []);
      editor.setDecorations(this.removedType, []);
    }
    this.refreshCodeLenses();
  }

  dispose(): void {
    this.clear();
    this.addedType.dispose();
    this.removedType.dispose();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!this.session) return [];
    const lenses: vscode.CodeLens[] = [];
    for (const hunk of this.session.hunks) {
      if (hunk.status !== 'pending' || hunk.file !== document.uri.fsPath) continue;
      const range = this.findHunkRange(document, hunk);
      if (!range) continue;
      const lensLine = new vscode.Range(range.startLine, 0, range.startLine, 0);
      lenses.push(new vscode.CodeLens(lensLine, {
        title: '✓ 接受',
        command: 'errAnalyst.acceptFixHunk',
        arguments: [hunk.id],
        tooltip: '接受此修改并写入文件',
      }));
      lenses.push(new vscode.CodeLens(lensLine, {
        title: '✕ 拒绝',
        command: 'errAnalyst.rejectFixHunk',
        arguments: [hunk.id],
        tooltip: '拒绝此修改',
      }));
    }
    return lenses;
  }

  refreshCodeLenses(): void {
    void Promise.resolve(vscode.commands.executeCommand('editor.action.refreshCodeLens')).catch(() => undefined);
  }

  private findHunkRange(doc: vscode.TextDocument, hunk: FixHunk): { startLine: number; endLine: number } | null {
    const lines: string[] = [];
    for (let i = 0; i < doc.lineCount; i++) lines.push(doc.lineAt(i).text);
    return findLineRange(lines, hunk.oldLines);
  }
}
