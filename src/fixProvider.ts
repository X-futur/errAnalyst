import * as vscode from 'vscode';
import { ErrorAnalysisResult } from './config';
import { FixAction, CommandAction, FileEdit } from './llmProvider';

export class FixProvider {
  private currentError: ErrorAnalysisResult | null = null;
  private currentFixCode: string = '';
  private decorationType: vscode.TextEditorDecorationType | null = null;

  private actions: FixAction[] = [];

  prepareFix(error: ErrorAnalysisResult, fixCode: string): void {
    this.currentError = error;
    this.currentFixCode = typeof fixCode === 'string' ? fixCode : '';
  }

  prepareActions(actions: FixAction[]): void {
    this.actions = actions;
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

    // Priority 1: Use new FixAction system
    const executableActions = this.actions.filter(
      a => a.type === 'edit_file' || a.type === 'run_command'
    );
    if (executableActions.length > 0) {
      await this.executeActions(executableActions);
      return;
    }

    // Priority 2: Fall back to legacy fixCode system
    if (!this.currentFixCode && (!this.currentError?.fixImports || this.currentError.fixImports.length === 0)) {
      vscode.window.showInformationMessage(
        'ErrAnalyst: No executable fix available. Please review the fix suggestion in the panel.'
      );
      return;
    }

    // Legacy flow: single file single line fix
    let targetFile = this.currentError.fixFile || this.currentError.filePath;
    let targetLine = this.currentError.fixLine || this.currentError.lineNumber;

    if (!targetFile && this.currentError.stackFrames.length > 0) {
      const lastFrame = this.currentError.stackFrames[this.currentError.stackFrames.length - 1];
      targetFile = lastFrame.file;
      targetLine = lastFrame.line;
    }

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

    let uri = await this.resolveFilePath(targetFile);
    if (!uri) {
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
      vscode.window.showErrorMessage('ErrAnalyst: Cannot find file: ' + targetFile);
      return;
    }

    await this.applyFixToFile(uri, targetLine, false);
  }

  private async executeActions(actions: FixAction[]): Promise<void> {
    // Show user a summary and let them choose which actions to apply
    const actionLabels = actions.map((a, i) => {
      const icon = a.type === 'edit_file' ? '\u270f\ufe0f' : '\u25b6\ufe0f';
      return icon + ' ' + a.title + ': ' + a.description.slice(0, 60);
    });

    const pick = await vscode.window.showQuickPick(actionLabels, {
      placeHolder: 'Select a fix action to apply (×' + actions.length + ' available)',
      canPickMany: false,
    });
    if (!pick) return;

    const idx = actionLabels.indexOf(pick);
    if (idx < 0) return;
    const action = actions[idx];

    switch (action.type) {
      case 'edit_file':
        await this.executeEditFileAction(action);
        break;
      case 'run_command':
        await this.executeRunCommandAction(action);
        break;
      case 'info_only':
        vscode.window.showInformationMessage('ErrAnalyst: ' + action.description);
        break;
    }
  }

  private async executeEditFileAction(action: FixAction): Promise<void> {
    const edits = action.edits || [];
    let applied = 0;
    const failed: string[] = [];

    for (const edit of edits) {
      try {
        const uri = vscode.Uri.file(edit.file);
        await this.applyFixToFile(uri, edit.startLine, false, edit);
        applied++;
      } catch (e) {
        failed.push(edit.file + ': ' + (e instanceof Error ? e.message : String(e)));
      }
    }

    if (failed.length === 0) {
      vscode.window.showInformationMessage(
        'ErrAnalyst: ' + action.title + ' \u2714 ' + applied + ' file(s) updated'
      );
    } else {
      vscode.window.showWarningMessage(
        'ErrAnalyst: ' + applied + ' file(s) updated, ' + failed.length + ' failed: ' + failed.join('; ')
      );
    }
  }

  private async executeRunCommandAction(action: FixAction): Promise<void> {
    const commands = action.commands || [];
    for (const cmd of commands) {
      const confirmMsg = 'ErrAnalyst: ' + cmd.description + '\n\n' + cmd.cmd;
      const choice = cmd.autoApprove
        ? '\u25b6 \u6267\u884c'
        : await vscode.window.showWarningMessage(confirmMsg, { modal: true }, '\u25b6 \u6267\u884c', '\u53d6\u6d88');
      if (!choice || choice === '\u53d6\u6d88') continue;

      const terminal = vscode.window.createTerminal({
        name: 'ErrAnalyst Fix',
        cwd: cmd.cwd || vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath,
      });
      terminal.show();
      terminal.sendText(cmd.cmd);
    }
  }

  private async applyFixToFile(uri: vscode.Uri, targetLine: number, insertAsNew: boolean, edit?: FileEdit): Promise<void> {
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc);
      const relPath = vscode.workspace.asRelativePath(uri);
      const fixImports = this.currentError?.fixImports || [];

      const fixText = edit ? edit.newText : this.currentFixCode;
      const fixLines = fixText.split('\n');
      let range: vscode.Range;
      let newText: string;
      let startLine: number;
      let importInsertCount = 0;

      if (insertAsNew || targetLine <= 0) {
        const lastLineIdx = doc.lineCount - 1;
        const lastLine = doc.lineAt(lastLineIdx);
        newText = '\n' + fixLines.join('\n') + '\n';
        range = new vscode.Range(lastLineIdx, lastLine.text.length, lastLineIdx, lastLine.text.length);
        startLine = -1;
      } else {
        const lineIdx = Math.max(0, targetLine - 1);
        const endIdx = edit ? edit.endLine - 1 : lineIdx;
        const originalLine = doc.lineAt(lineIdx);
        const indent = originalLine.text.match(/^\s*/)?.[0] || '';
        newText = fixLines.map(l => indent + l).join('\n');
        if (edit && endIdx > lineIdx) {
          // Multi-line replacement
          const endPos = endIdx < doc.lineCount ? doc.lineAt(endIdx).rangeIncludingLineBreak.end : doc.lineAt(doc.lineCount - 1).rangeIncludingLineBreak.end;
          range = new vscode.Range(lineIdx, 0, endPos.line, endPos.character);
        } else {
          range = originalLine.range;
        }
        startLine = lineIdx;
      }

      // Determine if there's actual code to replace (vs only imports)
      const hasCodeFix = this.currentFixCode.trim().length > 0;

      // Build preview: show both imports (if any) and code replacement
      let previewParts: string[] = [];
      if (fixImports.length > 0) {
        previewParts.push('(顶部插入): ' + fixImports.join('\n'));
      }
      if (hasCodeFix && !insertAsNew && targetLine > 0) {
        const orig = doc.lineAt(Math.max(0, targetLine - 1)).text;
        previewParts.push(relPath + ':' + targetLine + '\n' + orig + '\n\u2192\n' + newText);
      } else if (hasCodeFix && fixImports.length === 0) {
        previewParts.push('(新代码): ' + newText);
      }
      const detailStr = previewParts.join('\n---\n');

      const choice = await vscode.window.showInformationMessage(
        'ErrAnalyst: \u5e94\u7528\u4fee\u590d?', { modal: false, detail: detailStr }, '\u5e94\u7528', '\u53d6\u6d88'
      );
      if (choice !== '\u5e94\u7528') return;

      // Step 1: Insert imports at the top of the file (if any)
      if (fixImports.length > 0) {
        await editor.edit(editBuilder => {
          const firstPos = new vscode.Position(0, 0);
          editBuilder.insert(firstPos, fixImports.join('\n') + '\n\n');
        });
        importInsertCount = fixImports.length + 1; // +1 for the blank line
      }

      // Step 2: Skip if fixCode is empty (only imports needed)

      if (hasCodeFix) {
        if (insertAsNew || targetLine <= 0) {
          // Insert at end
          await editor.edit(editBuilder => {
            editBuilder.replace(range, newText);
          });
        } else {
          const adjustedLine = targetLine + importInsertCount;
          const lineIdx = Math.max(0, adjustedLine - 1);
          if (lineIdx < doc.lineCount) {
            await editor.edit(editBuilder => {
              const targetLineRange = doc.lineAt(lineIdx).range;
              const indent = doc.lineAt(lineIdx).text.match(/^\s*/)?.[0] || '';
              const indentedFix = fixLines.map(l => indent + l).join('\n');
              editBuilder.replace(targetLineRange, indentedFix);
            });
          }
        }
      }

      // Calculate changed lines for highlighting
      const topStart = 0;
      const topEnd = Math.max(0, importInsertCount - 2); // the import lines themselves
      let codeStart: number;
      let codeEnd: number;

      if (insertAsNew || targetLine <= 0) {
        codeStart = Math.max(0, doc.lineCount - fixLines.length - 1);
        codeEnd = doc.lineCount - 1;
      } else {
        codeStart = Math.max(0, targetLine + importInsertCount - 1);
        codeEnd = Math.min(codeStart + fixLines.length - 1, doc.lineCount - 1);
      }

      const decorationRanges: vscode.Range[] = [];
      // Highlight import lines
      if (importInsertCount > 0) {
        for (let l = topStart; l <= topEnd && l < doc.lineCount; l++) {
          decorationRanges.push(doc.lineAt(l).range);
        }
      }
      // Highlight code change lines
      for (let l = codeStart; l <= codeEnd && l < doc.lineCount; l++) {
        // Avoid duplicates if ranges overlap
        if (!decorationRanges.some(r => r.start.line === l)) {
          decorationRanges.push(doc.lineAt(l).range);
        }
      }

      if (decorationRanges.length > 0) {
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
        editor.revealRange(decorationRanges[0], vscode.TextEditorRevealType.InCenter);
      }

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
