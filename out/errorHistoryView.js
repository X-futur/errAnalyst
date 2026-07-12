"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ErrorHistoryViewProvider = void 0;
const vscode = __importStar(require("vscode"));
class ErrorHistoryViewProvider {
    constructor(_extensionUri, _errorMemory) {
        this._extensionUri = _extensionUri;
        this._errorMemory = _errorMemory;
    }
    resolveWebviewView(webviewView, _context, _token) {
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
    refresh() {
        if (this._view) {
            this._view.webview.html = this._getHtml();
        }
    }
    _getHtml() {
        const errors = this._errorMemory.getAll();
        let errorListHtml = '';
        if (errors.length === 0) {
            errorListHtml = '<div class="empty-state">暂无错误记录</div>';
        }
        else {
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
    _esc(str) {
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
    }
}
exports.ErrorHistoryViewProvider = ErrorHistoryViewProvider;
ErrorHistoryViewProvider.viewType = 'errAnalyst.errorHistory';
//# sourceMappingURL=errorHistoryView.js.map