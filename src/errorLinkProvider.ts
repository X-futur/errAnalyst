import * as vscode from 'vscode';
import { ErrorAnalysisResult } from './config';
import { ErrorParser } from './errorParser';

class ErrorTerminalLink extends vscode.TerminalLink {
  constructor(
    startIndex: number,
    length: number,
    tooltip: string | undefined,
    public readonly filePath: string,
    public readonly lineNum: number
  ) {
    super(startIndex, length, tooltip);
  }
}

export class ErrorLinkProvider implements vscode.TerminalLinkProvider<ErrorTerminalLink> {
  private errors: Map<string, ErrorAnalysisResult> = new Map();
  private hoverCallbacks: Array<(result: ErrorAnalysisResult) => void> = [];

  constructor() {}

  onHoverDetected(callback: (result: ErrorAnalysisResult) => void): void {
    this.hoverCallbacks.push(callback);
  }

  registerError(result: ErrorAnalysisResult): void {
    const key = `${result.filePath}:${result.lineNumber}`;
    this.errors.set(key, result);
    if (this.errors.size > 50) {
      const firstKey = this.errors.keys().next().value;
      if (firstKey) this.errors.delete(firstKey);
    }
  }

  provideTerminalLinks(
    context: vscode.TerminalLinkContext,
    _token: vscode.CancellationToken
  ): vscode.ProviderResult<ErrorTerminalLink[]> {
    const links: ErrorTerminalLink[] = [];
    const line = context.line;
    const fileLinePattern = /File\s+"([^"]+)",\s+line\s+(\d+)/g;
    let match;

    while ((match = fileLinePattern.exec(line)) !== null) {
      const filePath = match[1];
      const lineNum = parseInt(match[2]);
      let tooltip = `行 ${lineNum} | 点击跳转到代码位置`;
      for (const [, err] of this.errors) {
        if (err.filePath.includes(filePath) || filePath.includes(err.filePath)) {
          if (err.lineNumber === lineNum) {
            tooltip = `⚠️ ${err.errorType}: ${err.errorMessage.slice(0, 60)} | 查看分析`;
            this.hoverCallbacks.forEach(cb => cb(err));
            break;
          }
        }
      }
      links.push(new ErrorTerminalLink(match.index, match[0].length, tooltip, filePath, lineNum));
    }
    return links;
  }

  async handleTerminalLink(link: ErrorTerminalLink): Promise<void> {
    const workspaceFolders = (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath);
    const resolvedPath = ErrorParser['resolvePath'](link.filePath, workspaceFolders);
    try {
      const doc = await vscode.workspace.openTextDocument(resolvedPath);
      const editor = await vscode.window.showTextDocument(doc);
      const lineIdx = Math.max(0, link.lineNum - 1);
      const range = doc.lineAt(lineIdx).range;
      editor.selection = new vscode.Selection(range.start, range.end);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
    } catch (e) {
      const basename = link.filePath.split('/').pop() || link.filePath;
      for (const folder of workspaceFolders) {
        try {
          const found = await vscode.workspace.findFiles(`**/${basename}`, '**/node_modules/**', 1);
          if (found.length > 0) {
            const doc = await vscode.workspace.openTextDocument(found[0]);
            const editor = await vscode.window.showTextDocument(doc);
            const lineIdx = Math.max(0, link.lineNum - 1);
            const range = doc.lineAt(lineIdx).range;
            editor.selection = new vscode.Selection(range.start, range.end);
            editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
            return;
          }
        } catch { /* continue */ }
      }
      vscode.window.showWarningMessage(`ErrAnalyst: 无法定位文件 ${link.filePath}`);
    }
  }
}
