import * as vscode from 'vscode';
import { PythonTracebackParser } from '../parser/pythonTraceback';

export class ErrorLinkProvider_ implements vscode.TerminalLinkProvider {
  private onErrorLine: (line: string, terminal: vscode.Terminal) => void;

  constructor(onErrorLine: (line: string, terminal: vscode.Terminal) => void) {
    this.onErrorLine = onErrorLine;
  }

  provideTerminalLinks(
    context: vscode.TerminalLinkContext,
    _token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.TerminalLink[]> {
    // 每次被调用都记录
    console.log('ErrorLinkProvider: provideTerminalLinks called, line:', context.line.slice(0, 100));
    const line = context.line;
    if (PythonTracebackParser.hasErrorLine(line)) {
      this.onErrorLine(line, context.terminal);
    }
    return [];
  }

  handleTerminalLink(_link: vscode.TerminalLink): vscode.ProviderResult<void> {
  }
}
