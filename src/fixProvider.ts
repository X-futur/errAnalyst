import * as vscode from 'vscode';
import { ErrorAnalysisResult } from './config';

export class FixProvider {
  private currentError: ErrorAnalysisResult | null = null;
  private currentFixCode: string = '';

  prepareFix(error: ErrorAnalysisResult, fixCode: string): void {
    this.currentError = error;
    this.currentFixCode = typeof fixCode === 'string' ? fixCode : '';
  }

  private async resolveFilePath(filePath: string): Promise<vscode.Uri | null> {
    try {
      const uri = vscode.Uri.file(filePath);
      await vscode.workspace.fs.stat(uri);
      return uri;
    } catch {}
    const basename = filePath.split(/[\\/]/).pop() || filePath;
    const folders = vscode.workspace.workspaceFolders || [];
    for (const folder of folders) {
      const fullPath = vscode.Uri.joinPath(folder.uri, filePath);
      try { await vscode.workspace.fs.stat(fullPath); return fullPath; } catch {}
    }
    for (const folder of folders) {
      try {
        const pattern = '**/' + basename;
        const results = await vscode.workspace.findFiles(pattern, '**/node_modules/**', 1);
        if (results.length > 0) return results[0];
      } catch {}
    }
    return null;
  }

  async showFixDiff(): Promise<void> {
    if (!this.currentError) {
      vscode.window.showWarningMessage('ErrAnalyst: No error data');
      return;
    }
    if (!this.currentFixCode || typeof this.currentFixCode !== 'string') {
      
      vscode.window.showInformationMessage('ErrAnalyst: The AI analysis did not produce executable fix code. Please review the fix suggestion shown in the panel.');
      return;
    }
    const { filePath, lineNumber } = this.currentError;
    if (!filePath) {
      vscode.window.showErrorMessage('ErrAnalyst: No file path for fix');
      return;
    }
    const uri = await this.resolveFilePath(filePath);
    if (!uri) {
      vscode.window.showErrorMessage('ErrAnalyst: Cannot find file: ' + filePath);
      return;
    }
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc);
      const lineIdx = Math.max(0, lineNumber - 1);
      const originalLine = doc.lineAt(lineIdx);
      const indent = originalLine.text.match(/^\s*/)?.[0] || '';
      const fixLines = this.currentFixCode.split('\n');
      const detailStr = filePath + ':' + lineNumber + '\n\n' + originalLine.text + '\n\u2192\n' + fixLines.map(l => indent + l).join('\n');
      const choice = await vscode.window.showInformationMessage(
        'ErrAnalyst: Apply fix?', { modal: false, detail: detailStr }, 'Apply', 'Cancel'
      );
      if (choice === 'Apply') {
        await editor.edit(editBuilder => {
          const range = new vscode.Range(lineIdx, 0, lineIdx, originalLine.text.length);
          editBuilder.replace(range, fixLines.map(l => indent + l).join('\n'));
        });
        vscode.window.showInformationMessage('ErrAnalyst: Fix applied');
      }
    } catch (e) {
      vscode.window.showErrorMessage('ErrAnalyst: Failed to apply fix: ' + (e instanceof Error ? e.message : String(e)));
    }
  }

  async applyFixDirectly(): Promise<void> {
    await this.showFixDiff();
  }
}
