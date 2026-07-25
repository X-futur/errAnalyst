import * as vscode from 'vscode';
import { ErrorMemory } from '../storage/errorMemory';

export class ErrorHistoryViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'errAnalyst.errorHistory';
  private _view?: vscode.WebviewView;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _errorMemory: ErrorMemory
  ) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true
    };

    webviewView.webview.html = this._getHtml();

    webviewView.webview.onDidReceiveMessage((message) => {
      switch (message.type) {
        case 'focusPanel':
          vscode.commands.executeCommand('errAnalyst.focusPanel');
          break;
      }
    });
  }

  refresh(): void {
    if (this._view) {
      this._view.webview.html = this._getHtml();
    }
  }

  private _getHtml(): string {
    const errors = this._errorMemory.getAll();

    let errorListHtml = '';
    if (errors.length === 0) {
      errorListHtml = '<div class="empty-state">暂无错误记录</div>';
    } else {
      for (const err of errors) {
        const date = new Date(err.lastSeen);
        const timeStr = date.toLocaleString('zh-CN', { hour12: false });
        errorListHtml += `
          <div class="error-item" onclick="focusPanel()">
            <div class="error-type">${this._esc(err.errorType)}</div>
            <div class="error-msg">${this._esc(err.errorMessage.slice(0, 80))}</div>
            <div class="error-meta">${this._esc(timeStr)} · 出现 ${err.count} 次</div>
          </div>
        `;
      }
    }

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  background: transparent;
  color: var(--vscode-foreground);
  padding: 8px;
  font-size: 12px;
  line-height: 1.5;
  margin: 0;
}
.empty-state {
  text-align: center;
  padding: 20px 8px;
  color: var(--vscode-descriptionForeground);
  font-size: 12px;
}
.error-item {
  background: var(--vscode-sideBar-background);
  border: 1px solid var(--vscode-sideBar-border);
  border-radius: 4px;
  padding: 8px;
  margin-bottom: 6px;
  cursor: pointer;
  transition: background .15s;
}
.error-item:hover {
  background: var(--vscode-list-hoverBackground);
}
.error-type {
  color: var(--vscode-errorForeground, #f48771);
  font-weight: bold;
  font-family: Consolas, Monaco, monospace;
  font-size: 11px;
  margin-bottom: 2px;
}
.error-msg {
  color: var(--vscode-foreground);
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.error-meta {
  color: var(--vscode-descriptionForeground);
  font-size: 10px;
  margin-top: 4px;
}
</style>
</head>
<body>
${errorListHtml}
<script>
(function() {
  const vscode = acquireVsCodeApi();
  window.focusPanel = function() {
    vscode.postMessage({ type: 'focusPanel' });
  };
})();
</script>
</body>
</html>`;
  }

  private _esc(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }
}
