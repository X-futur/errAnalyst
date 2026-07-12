import * as vscode from 'vscode';
import { ErrorAnalysisResult } from './config';

export class AnalysisWebview {
  private panel: vscode.WebviewPanel | null = null;
  private currentError: ErrorAnalysisResult | null = null;
  private currentAiData: {
    translation: string;
    keywords: Array<{ cn: string; en: string }>;
    analysis: string;
    fixSuggestion: string;
    fixCode?: string;
  } | null = null;
  private highlightDecoration: vscode.TextEditorDecorationType | null = null;

  show(error: ErrorAnalysisResult, aiData?: {
    translation: string;
    keywords: Array<{ cn: string; en: string }>;
    analysis: string;
    fixSuggestion: string;
    fixCode?: string;
  }): void {
    this.currentError = error;
    if (aiData) this.currentAiData = aiData;
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        'errAnalyst.analysis',
        'ErrAnalyst - 错误分析',
        vscode.ViewColumn.Beside,
        { enableScripts: true, retainContextWhenHidden: true }
      );
      this.panel.onDidDispose(() => { this.panel = null; });
      this.panel.webview.onDidReceiveMessage(msg => this.handleWebviewMessage(msg));
    }
    this.panel.reveal(vscode.ViewColumn.Beside, true);
    this.updateContent();
  }

  close(): void {
    if (this.panel) { this.panel.dispose(); this.panel = null; }
    this.clearHighlight();
  }

  focus(): void {
    if (this.panel) this.panel.reveal(vscode.ViewColumn.Beside, true);
  }

  private handleWebviewMessage(msg: any): void {
    switch (msg.type) {
      case 'highlightEditor': this.highlightInEditor(msg.term); break;
      case 'applyFix':
        vscode.commands.executeCommand('errAnalyst.showFixDiff').then(undefined, err => {
          console.error('ErrAnalyst: Fix command failed:', err);
        });
        break;
    }
  }

  private updateContent(): void {
    if (!this.panel || !this.currentError) return;
    const error = this.currentError;
    const aiData = this.currentAiData;
    const categoryHtml = this.buildCategoryHtml();
    let stackHtml = '';
    for (const frame of error.stackFrames) {
      const codeLine = frame.codeLine ? '<div class="code-line">' + this.esc(frame.codeLine) + '</div>' : '';
      stackHtml += '<div class="stack-frame"><span class="frame-file">' + this.esc(frame.file) + '</span>:<span class="frame-line">' + frame.line + '</span>, in <span class="frame-func">' + this.esc(frame.function) + '</span>' + codeLine + '</div>';
    }
    let analysisHtml = '';
    if (aiData) {
      let transHtml = aiData.translation;
      for (const kw of aiData.keywords) {
        const escaped = this.esc(kw.cn);
        transHtml = transHtml.replace(
          new RegExp('\\{\\{' + this.escRegex(kw.en) + '\\}\\}', 'g'),
          '<span class="hl-keyword" data-en="' + this.esc(kw.en) + '" data-cn="' + escaped + '">' + escaped + '</span>'
        );
      }
      let kwPills = '';
      for (const kw of aiData.keywords) {
        kwPills += '<span class="keyword-badge" data-en="' + this.esc(kw.en) + '" data-cn="' + this.esc(kw.cn) + '"><span class="kw-en">' + this.esc(kw.en) + '</span> \u2194 <span class="kw-cn">' + this.esc(kw.cn) + '</span></span>';
      }
      let errorTypeHtml = '<div class="error-type">' + this.esc(error.errorType) + '</div>';
      let errorMsgHtml = this.esc(error.errorMessage);
      for (const kw of aiData.keywords) {
        errorMsgHtml = errorMsgHtml.replace(
          new RegExp(this.escRegex(kw.en), 'gi'),
          (match) => '<span class="hl-keyword" data-en="' + this.esc(kw.en) + '" data-cn="' + this.esc(kw.cn) + '">' + this.esc(match) + '</span>'
        );
      }
      analysisHtml = '<div class="analysis-content">'
        + '<div class="error-pair">'
        + '<div class="error-original"><h4>原始报错</h4><pre class="error-text">' + errorTypeHtml + '<div class="error-msg">' + errorMsgHtml + '</div></pre></div>'
        + '<div class="error-translated"><h4>中文翻译</h4><div class="translated-text">' + transHtml + '</div></div></div>'
        + (kwPills ? '<div class="keyword-pills">' + kwPills + '</div>' : '')
        + '<div class="section-card"><h4>错误分析</h4><p>' + this.esc(aiData.analysis) + '</p></div>'
        + '<div class="section-card fix-card"><h4>修复建议</h4><p>' + this.esc(aiData.fixSuggestion) + '</p></div>'
        + '<div class="action-buttons"><button class="btn btn-primary" onclick="applyFix()">\uD83D\uDD27 应用修复</button></div></div>';
    } else {
      analysisHtml = '<div class="analysis-loading"><div class="spinner"></div><p>正在调用 AI 分析...</p></div>';
    }
    this.panel.webview.html = this.getHtmlTemplate(stackHtml, categoryHtml, analysisHtml);
  }

  private buildCategoryHtml(): string {
    if (!this.currentError || !this.currentError.category || this.currentError.category === 'UNKNOWN') {
      return '';
    }
    const category = this.currentError.category;
    const actionPlan = this.currentError.actionPlan || '';
    const suggestion = this.currentError.suggestion || '';
    const hasExitCode = this.currentError.hasExitCode;
    const cfg: Record<string, { label: string; color: string }> = {
      COMPILATION_ERROR: { label: '🛠️ 编译错误', color: '#d4872e' },
      DEPENDENCY_ERROR: { label: '📦 依赖错误', color: '#3794ff' },
      SYSTEM_ERROR: { label: '⚙️ 系统错误', color: '#f44747' },
      RUNTIME_ERROR: { label: '▶️ 运行时错误', color: '#b180d7' }
    };
    const c = cfg[category];
    if (!c) return '';
    let html = `<div class="category-section">
      <div class="category-badge" style="background:${c.color}22;border-left:3px solid ${c.color};color:${c.color}">
        <span>${c.label}</span>
      </div>
      <div class="action-plan-card">
        <span class="action-icon">📋</span>
        <span class="action-text">${this.esc(actionPlan)}</span>
      </div>`;
    if (hasExitCode) {
      html += `<div class="exit-code-warning">⚠️ ${this.esc(suggestion)}</div>`;
    }
    html += `</div>`;
    return html;
  }
  
  private highlightInEditor(term: string): void {
    this.clearHighlight();
    const editor = vscode.window.activeTextEditor;
    if (!editor || !this.currentError) return;
    this.highlightDecoration = vscode.window.createTextEditorDecorationType({
      backgroundColor: 'rgba(255, 200, 0, 0.3)',
      border: '1px solid rgba(255, 200, 0, 0.8)',
      borderRadius: '3px',
      fontWeight: 'bold'
    });
    const lineIdx = Math.max(0, this.currentError.lineNumber - 1);
    const text = editor.document.lineAt(lineIdx).text;
    const ranges: vscode.Range[] = [];
    let searchFrom = 0, idx;
    while ((idx = text.toLowerCase().indexOf(term.toLowerCase(), searchFrom)) !== -1) {
      ranges.push(new vscode.Range(lineIdx, idx, lineIdx, idx + term.length));
      searchFrom = idx + term.length;
    }
    if (ranges.length > 0) editor.setDecorations(this.highlightDecoration, ranges);
  }

  private clearHighlight(): void {
    if (this.highlightDecoration) { this.highlightDecoration.dispose(); this.highlightDecoration = null; }
  }

  private esc(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }

  private escRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private getHtmlTemplate(stackHtml: string, categoryHtml: string, analysisHtml: string): string {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
:root{--bg:#1e1e1e;--bg-card:#252526;--text:#d4d4d4;--text-muted:#808080;--accent:#007acc;--border:#3c3c3c;--error-border:#c04040;--highlight-bg:rgba(230,184,0,0.15);--highlight-border:#e6b800;--success:#40c060;}
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:var(--bg);color:var(--text);padding:12px;font-size:13px;line-height:1.5;}
h3{margin-bottom:8px;font-size:15px;}h4{font-size:12px;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;color:#999;}
.category-section{margin-bottom:10px;}
.category-badge{padding:4px 10px;border-radius:4px;font-size:12px;font-weight:600;display:inline-block;margin-bottom:6px;}
.action-plan-card{background:var(--bg-card);border:1px solid var(--border);border-radius:6px;padding:8px 10px;font-size:12px;line-height:1.4;display:flex;align-items:flex-start;gap:6px;margin-bottom:6px;}
.action-icon{flex-shrink:0;}
.exit-code-warning{background:rgba(244,71,71,0.1);border:1px solid rgba(244,71,71,0.3);border-radius:4px;padding:6px 10px;font-size:11px;color:#f48771;}
.stack-section{background:var(--bg-card);border:1px solid var(--border);border-radius:6px;padding:10px;margin-bottom:12px;}
.stack-frame{padding:3px 0;border-bottom:1px solid var(--border);font-family:Consolas,Monaco,monospace;font-size:12px;}
.stack-frame:last-child{border-bottom:none;}.frame-file{color:#569cd6;}.frame-line{color:#b5cea8;}.frame-func{color:#dcdcaa;}
.code-line{color:#ce9178;padding-left:16px;margin-top:2px;font-size:11px;}
.hl-keyword{background:var(--highlight-bg);border-bottom:2px solid var(--highlight-border);padding:0 2px;border-radius:2px;cursor:pointer;transition:all .15s;}
.hl-keyword:hover,.hl-keyword.active{background:rgba(230,184,0,0.4)!important;box-shadow:0 0 6px rgba(230,184,0,.3);}
.error-pair{display:flex;gap:12px;margin-bottom:12px;}
.error-original,.error-translated{flex:1;background:var(--bg-card);border:1px solid var(--border);border-radius:6px;padding:10px;min-width:0;}
.error-text,.translated-text{font-family:Consolas,Monaco,monospace;font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-word;}
.error-type{color:#f48771;font-weight:bold;margin-bottom:4px;}
.error-msg{color:#ce9178;}
.section-card{background:var(--bg-card);border:1px solid var(--border);border-radius:6px;padding:10px;margin-bottom:8px;}
.fix-card{border-left:3px solid var(--success);}
.fix-card p{color:var(--success);}
.keyword-pills{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px;}
.keyword-badge{background:var(--bg-card);border:1px solid var(--highlight-border);border-radius:12px;padding:3px 8px;font-size:11px;cursor:pointer;transition:all .15s;}
.keyword-badge:hover{background:rgba(230,184,0,0.2);box-shadow:0 0 4px rgba(230,184,0,.3);}
.kw-en{color:#569cd6;}.kw-cn{color:#e6b800;}
.action-buttons{display:flex;gap:8px;margin-top:8px;}
.btn{padding:6px 16px;border:none;border-radius:4px;font-size:13px;cursor:pointer;transition:background .15s;}
.btn-primary{background:var(--accent);color:#fff;}.btn-primary:hover{background:#1a8ad4;}
.analysis-loading{text-align:center;padding:40px;color:var(--text-muted);}
.spinner{width:24px;height:24px;border:3px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin 1s linear infinite;margin:0 auto 12px;}
@keyframes spin{to{transform:rotate(360deg);}}
</style>
</head>
<body>
<h3>\u26a0\ufe0f ` + this.esc(this.currentError?.errorType || 'Error') + `</h3>
` + categoryHtml + `
<div class="stack-section"><h4>\u8c03\u7528\u6808</h4>` + stackHtml + `</div>
` + analysisHtml + `
<script>
(function(){var vscode=acquireVsCodeApi();var vsApi=vscode;
function hk(t){document.querySelectorAll('.hl-keyword').forEach(function(e){e.classList.add('active');});}
function uk(){document.querySelectorAll('.hl-keyword').forEach(function(e){e.classList.remove('active');});}
document.addEventListener('mouseover',function(e){var t=e.target;if(t&&t.classList&&t.classList.contains('hl-keyword')){var kw=t.getAttribute('data-en')||t.textContent;hk(kw);vsApi.postMessage({type:'highlightEditor',term:kw});}});
document.addEventListener('mouseout',function(e){var t=e.target;if(t&&t.classList&&t.classList.contains('hl-keyword')){uk();}});
function ab(){document.querySelectorAll('.keyword-badge').forEach(function(b){b.addEventListener('mouseover',function(){var en=this.getAttribute('data-en');hk(en);vsApi.postMessage({type:'highlightEditor',term:en});});b.addEventListener('mouseout',function(){uk();});});}
ab();var ob=new MutationObserver(function(){ab();});ob.observe(document.body,{childList:true,subtree:true});
window.applyFix=function(){vsApi.postMessage({type:'applyFix'});};})();
</script>
</body>
</html>`;
  }
}
