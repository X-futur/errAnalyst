import * as vscode from 'vscode';
import { ErrorAnalysisResult } from './config';

export class FixProvider {
  private currentError: ErrorAnalysisResult | null = null;
  private currentFixCode: string = '';
  private decorationType: vscode.TextEditorDecorationType | null = null;

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
    if (!this.currentFixCode) {
      vscode.window.showInformationMessage('ErrAnalyst: The AI analysis did not produce executable fix code. Please review the fix suggestion shown in the panel.');
      return;
    }

    // Try to determine the target file - prioritize fixFile from AI
    let targetFile = this.currentError.fixFile || this.currentError.filePath;
    let targetLine = this.currentError.lineNumber;

    // If still empty, try extracting from stack frames
    if (!targetFile && this.currentError.stackFrames.length > 0) {
      const lastFrame = this.currentError.stackFrames[this.currentError.stackFrames.length - 1];
      targetFile = lastFrame.file;
      targetLine = lastFrame.line;
    }

    // If still no file, let user pick
    if (!targetFile) {
      const folders = vscode.workspace.workspaceFolders || [];
      if (folders.length > 0) {
        const files = await vscode.workspace.findFiles('**/*.py', '**/node_modules/**', 50);
        const filePicks = files.map(f => ({
          label: f.fsPath.split('/').pop() || f.fsPath,
          description: vscode.workspace.asRelativePath(f),
          uri: f
        }));
        if (filePicks.length > 0) {
          const selected = await vscode.window.showQuickPick(filePicks, {
            placeHolder: 'Select the Python file to apply the fix'
          });
          if (!selected) return;
          await this.applyFixToFile(selected.uri, 0, true);
          return;
        }
      }
      vscode.window.showErrorMessage('ErrAnalyst: Cannot determine which file to fix. The error traceback does not contain file location information.');
      return;
    }

    // Resolve the file URI
    let uri = await this.resolveFilePath(targetFile);
    if (!uri) {
      // Try searching by basename
      const basename = targetFile.split(/[\\/]/).pop() || targetFile;
      const folders = vscode.workspace.workspaceFolders || [];
      for (const folder of folders) {
        const results = await vscode.workspace.findFiles('**/' + basename, '**/node_modules/**', 5);
        if (results.length === 1) {
          uri = results[0];
          break;
        } else if (results.length > 1) {
          const picks = results.map(f => ({
            label: vscode.workspace.asRelativePath(f),
            uri: f
          }));
          const picked = await vscode.window.showQuickPick(picks, {
            placeHolder: 'Multiple files named "' + basename + '" found. Which one to fix?'
          });
          if (picked) uri = picked.uri;
          break;
        }
      }
    }

    if (!uri) {
      vscode.window.showErrorMessage('ErrAnalyst: Cannot find file: ' + targetFile + '. Make sure the file exists in your workspace.');
      return;
    }

    await this.applyFixToFile(uri, targetLine, false);
  }

  private async applyFixToFile(uri: vscode.Uri, targetLine: number, insertAsNew: boolean): Promise<void> {
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc);
      const relPath = vscode.workspace.asRelativePath(uri);

      const fixLines = this.currentFixCode.split('\n');
      let range: vscode.Range;
      let newText: string;
      let startLine: number;

      if (insertAsNew || targetLine <= 0) {
        // Insert at end of file
        const lastLineIdx = doc.lineCount - 1;
        const lastLine = doc.lineAt(lastLineIdx);
        newText = '\n' + fixLines.join('\n') + '\n';
        range = new vscode.Range(lastLineIdx, lastLine.text.length, lastLineIdx, lastLine.text.length);
        startLine = -1; // calculated after edit
      } else {
        const lineIdx = Math.max(0, targetLine - 1);
        const originalLine = doc.lineAt(lineIdx);
        const indent = originalLine.text.match(/^\s*/)?.[0] || '';
        newText = fixLines.map(l => indent + l).join('\n');
        range = originalLine.range;
        startLine = lineIdx;
      }

      // Show diff preview first
      const previewOriginal = (insertAsNew || targetLine <= 0)
        ? '(新代码)'
        : doc.lineAt(Math.max(0, targetLine - 1)).text;
      const detailStr = relPath + (targetLine > 0 ? ':' + targetLine : '')
        + '\n\n' + previewOriginal + '\n\u2192\n' + newText;

      const choice = await vscode.window.showInformationMessage(
        'ErrAnalyst: 应用修复?', { modal: false, detail: detailStr }, '\u5e94\u7528', '\u53d6\u6d88'
      );
      if (choice !== '\u5e94\u7528') return;

      // Apply the edit
      await editor.edit(editBuilder => {
        editBuilder.replace(range, newText);
      });

      // Calculate changed lines for highlighting
      if (startLine < 0) {
        startLine = Math.max(0, doc.lineCount - fixLines.length - 1);
      }
      const endLine = Math.min(startLine + fixLines.length - 1, doc.lineCount - 1);

      const decorationRanges: vscode.Range[] = [];
      for (let l = startLine; l <= endLine; l++) {
        decorationRanges.push(doc.lineAt(l).range);
      }

      // Create green highlight decoration
      this.clearDecoration();
      this.decorationType = vscode.window.createTextEditorDecorationType({
        backgroundColor: 'rgba(60, 180, 75, 0.2)',
        border: '1px solid rgba(60, 180, 75, 0.6)',
        borderRadius: '3px',
        isWholeLine: true,
        overviewRulerColor: 'rgba(60, 180, 75, 0.6)',
        overviewRulerLane: vscode.OverviewRulerLane.Left
      });
      editor.setDecorations(this.decorationType, decorationRanges);

      // Scroll to the first changed line
      editor.revealRange(decorationRanges[0], vscode.TextEditorRevealType.InCenter);

      // Show Accept/Revert buttons
      const action = await vscode.window.showInformationMessage(
        'ErrAnalyst: ' + relPath + ' \u7eff\u8272\u9ad8\u4eae\u884c\u5df2\u4fee\u6539',
        '\u2713 \u4fdd\u7559', '\u21a9 \u64a4\u9500'
      );

      if (action === '\u21a9 \u64a4\u9500') {
        await vscode.commands.executeCommand('undo');
        this.clearDecoration();
        vscode.window.showInformationMessage('ErrAnalyst: \u4fee\u590d\u5df2\u64a4\u9500');
      } else if (action === '\u2713 \u4fdd\u7559') {
        this.clearDecoration();
        vscode.window.showInformationMessage('ErrAnalyst: \u4fee\u590d\u5df2\u4fdd\u7559');
      }
      // If dismissed (user clicks elsewhere), decoration stays until next fix or cleanup

    } catch (e) {
      this.clearDecoration();
      vscode.window.showErrorMessage('ErrAnalyst: \u4fee\u590d\u5931\u8d25: ' + (e instanceof Error ? e.message : String(e)));
    }
  }

  private clearDecoration(): void {
    if (this.decorationType) {
      this.decorationType.dispose();
      this.decorationType = null;
    }
  }
  async applyFixDirectly(): Promise<void> {
    await this.showFixDiff();
  }
}
