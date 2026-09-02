import * as vscode from 'vscode';

// 实例化vscode的链接提供器，本来是用作监控终端的每一行输出并在可以插入链接的地方安排链接的
// 这里用来监控终端的每一行输出，作为流式触发的稳定兜底数据通道（onDidWriteTerminalData提案 API 不可用时，流式检测仍能拿到逐行输出）
// 相当于借链接机制拿到逐行输出
export class ErrorLinkProvider_ implements vscode.TerminalLinkProvider {
  private onErrorLine: (line: string, terminal: vscode.Terminal) => void;

  constructor(onErrorLine: (line: string, terminal: vscode.Terminal) => void) {
    this.onErrorLine = onErrorLine;
  }

  // vscode.TerminalLinkProvider 接口的实现，检测并创建链接，一旦终端产生新的行就自动执行
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

  // 自定义的处理点击的操作，点击在终端创建的链接时触发
  handleTerminalLink(_link: vscode.TerminalLink): vscode.ProviderResult<void> {
  }
}
