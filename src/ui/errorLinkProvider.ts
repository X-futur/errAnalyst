import * as vscode from 'vscode';
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
    // 转发所有行：作为流式触发的稳定兜底数据通道（onDidWriteTerminalData
    // 提案 API 不可用时，流式检测仍能拿到逐行输出）。
    this.onErrorLine(context.line, context.terminal);
    return [];
  }

  handleTerminalLink(_link: vscode.TerminalLink): vscode.ProviderResult<void> {
  }
}
