import * as vscode from 'vscode';
import { ErrorAnalysisResult } from '../config';
import type { BuiltContext, FileContext } from '../context/contextBuilder';

export class AnalysisWebview {
  private panel: vscode.WebviewPanel | null = null;
  private currentError: ErrorAnalysisResult | null = null;
  private currentAiData: {
    translation: string;
    keywords: Array<{ cn: string; en: string }>;
    analysis: string;
    fixSuggestion: string;
  } | null = null;
  private currentContext: BuiltContext | null = null;
  private currentTraceback: string = "";

  show(error: ErrorAnalysisResult, aiData?: {
    translation: string;
    keywords: Array<{ cn: string; en: string }>;
    analysis: string;
    fixSuggestion: string;
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
  }

  focus(): void {
    if (this.panel) this.panel.reveal(vscode.ViewColumn.Beside, true);
  }

  /** Show full traceback and code context (sent from extension after AI returns) */
  showContext(fullTraceback: string, context?: BuiltContext): void {
    this.currentTraceback = fullTraceback;
    this.currentContext = context || null;
    this.updateContent();
  }

  private handleWebviewMessage(msg: any): void {
    switch (msg.type) {
      case 'openFile':
        this.openFileAtLine(msg.file, msg.line);
        break;
    }
  }

  private async openFileAtLine(file: string, line: number): Promise<void> {
    try {
      const doc = await vscode.workspace.openTextDocument(file);
      const editor = await vscode.window.showTextDocument(doc);
      const lineIdx = Math.max(0, line - 1);
      const range = doc.lineAt(lineIdx).range;
      editor.selection = new vscode.Selection(range.start, range.end);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
    } catch {
      // Try fuzzy match by basename
      const basename = file.split(/[\\/]/).pop();
      if (basename) {
        const folders = vscode.workspace.workspaceFolders || [];
        for (const folder of folders) {
          try {
            const found = await vscode.workspace.findFiles(`**/${basename}`, '**/node_modules/**', 1);
            if (found.length > 0) {
              const doc = await vscode.workspace.openTextDocument(found[0]);
              const editor = await vscode.window.showTextDocument(doc);
              const lineIdx = Math.max(0, line - 1);
              const range = doc.lineAt(lineIdx).range;
              editor.selection = new vscode.Selection(range.start, range.end);
              editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
              return;
            }
          } catch { /* continue */ }
        }
      }
    }
  }

  private updateContent(): void {
    if (!this.panel || !this.currentError) return;
    const error = this.currentError;
    const aiData = this.currentAiData;

    const categoryHtml = this.buildCategoryHtml();
    const codeContextHtml = this.buildCodeContextHtml();
    const stackHtml = this.buildStackHtml();
    const analysisHtml = this.buildAnalysisHtml();
    const terminalHtml = this.buildTerminalHtml();

    this.panel.webview.html = this.getHtmlTemplate(
      error, categoryHtml, codeContextHtml, stackHtml, analysisHtml, terminalHtml
    );
  }

  private buildCategoryHtml(): string {
    if (!this.currentError || !this.currentError.category || this.currentError.category === 'UNKNOWN') {
      return '';
    }
    const category = this.currentError.category;
    const cfg: Record<string, { label: string; color: string }> = {
      COMPILATION_ERROR: { label: '编译错误', color: '#d4872e' },
      DEPENDENCY_ERROR: { label: '依赖错误', color: '#3794ff' },
      SYSTEM_ERROR: { label: '系统错误', color: '#f44747' },
      RUNTIME_ERROR: { label: '运行时错误', color: '#b180d7' }
    };
    const c = cfg[category];
    if (!c) return '';
    return `<div class="category-section">
      <div class="category-badge" style="background:${c.color}22;border-left:3px solid ${c.color};color:${c.color}">
        <span>▶ ${c.label}</span>
      </div>
    </div>`;
  }

  private buildCodeContextHtml(): string {
    const ctx = this.currentContext;
    if (!ctx) return '';
    let html = '<div class="code-context-section">';
    html += '<h4>源代码上下文</h4>';

    // Analysis-referenced files should be expanded.
    // We detect which files are referenced in the analysis text.
    const referencedFiles = this.extractReferencedFiles();

    if (ctx.mainFile) {
      const isReferenced = referencedFiles.some(r => ctx.mainFile && ctx.mainFile.path.endsWith(r.file));
      html += this.renderFileContext(ctx.mainFile, true, isReferenced);
    }
    for (const f of ctx.stackFiles) {
      const isReferenced = referencedFiles.some(r => f.path.endsWith(r.file));
      html += this.renderFileContext(f, false, isReferenced);
    }
    for (const f of ctx.configFiles) {
      html += this.renderFileContext(f, false, false);
    }
    for (const f of ctx.siblingFiles) {
      html += this.renderFileContext(f, false, false);
    }
    html += '</div>';
    return html;
  }

  /**
   * Extract (file, line) pairs from AI analysis text for auto-expand.
   */
  private extractReferencedFiles(): Array<{ file: string; line: number }> {
    const analysis = this.currentAiData?.analysis || '';
    const refs: Array<{ file: string; line: number }> = [];
    // Match patterns like "service.py:25" or "/path/to/file.py:42"
    const pattern = /([a-zA-Z0-9_./\\-]+\.py):(\d+)/g;
    let match;
    while ((match = pattern.exec(analysis)) !== null) {
      const file = match[1].split('/').pop() || match[1];
      refs.push({ file, line: parseInt(match[2], 10) });
    }
    return refs;
  }

  private renderFileContext(fc: FileContext, isMain: boolean, expanded: boolean): string {
    const label = isMain ? '主要报错文件' : (fc.path.split('/').pop() || fc.path);
    const relPath = fc.path;
    const display = expanded ? 'block' : 'none';
    const toggleClass = expanded ? 'open' : '';
    return `<div class="file-context ${isMain ? 'main-file' : ''}">
      <div class="file-header" onclick="toggleFile(this)">
        <span class="file-toggle ${toggleClass}">▶</span>
        <span class="file-label">${this.esc(label)}</span>
        <span class="file-path">${this.esc(relPath)}</span>
        <span class="file-lines">L${fc.startLine}-${fc.endLine}</span>
      </div>
      <div class="file-content" style="display:${display}">
        <pre>${this.esc(fc.content)}</pre>
      </div>
    </div>`;
  }

  private buildStackHtml(): string {
    if (!this.currentError || this.currentError.stackFrames.length === 0) return '';
    let html = '';
    // Primary stack
    html += '<h4>调用栈</h4>';
    for (const frame of this.currentError.stackFrames) {
      const codeLine = frame.codeLine
        ? '<div class="code-line">' + this.esc(frame.codeLine) + '</div>'
        : '';
      html += `<div class="stack-frame">`
        + `<span class="frame-file">${this.esc(frame.file)}</span>:`
        + `<span class="frame-line">${frame.line}</span>, in `
        + `<span class="frame-func">${this.esc(frame.function)}</span>`
        + codeLine + '</div>';
    }
    // Chain stacks
    if (this.currentError.chain.length > 0) {
      for (const entry of this.currentError.chain) {
        const relLabel = entry.relationship === 'cause' ? 'Direct cause' : 'Context';
        html += `<div class="chain-header">${relLabel} — ${this.esc(entry.errorType)}: ${this.esc(entry.errorMessage.slice(0, 80))}</div>`;
        for (const frame of entry.stackFrames) {
          const codeLine = frame.codeLine
            ? '<div class="code-line">' + this.esc(frame.codeLine) + '</div>'
            : '';
          html += `<div class="stack-frame chain-frame">`
            + `<span class="frame-file">${this.esc(frame.file)}</span>:`
            + `<span class="frame-line">${frame.line}</span>, in `
            + `<span class="frame-func">${this.esc(frame.function)}</span>`
            + codeLine + '</div>';
        }
      }
    }
    return '<div class="stack-section">' + html + '</div>';
  }

  private buildAnalysisHtml(): string {
    const error = this.currentError;
    if (!error) return '';
    const aiData = this.currentAiData;

    if (aiData) {
      let kwPills = '';
      for (const kw of aiData.keywords) {
        kwPills += '<span class="keyword-badge" data-en="' + this.esc(kw.en) + '" data-cn="' + this.esc(kw.cn) + '">'
          + '<span class="kw-en">' + this.esc(kw.en) + '</span> ↔ '
          + '<span class="kw-cn">' + this.esc(kw.cn) + '</span>'
          + '</span>';
      }

      // Make file:line references clickable in analysis text
      const analysisHtml = this.makeFileLinksClickable(this.esc(aiData.analysis));

      return '<div class="analysis-content">'
        + '<div class="error-pair">'
        + '<div class="error-original"><h4>原始报错</h4>'
        + '<pre class="error-text">'
        + '<div class="error-type">' + this.esc(error.errorType) + '</div>'
        + '<div class="error-msg">' + this.esc(error.errorMessage) + '</div>'
        + '</pre></div>'
        + '<div class="error-translated"><h4>中文翻译</h4>'
        + '<div class="translated-text">' + aiData.translation + '</div>'
        + '</div></div>'
        + (kwPills ? '<div class="keyword-pills">' + kwPills + '</div>' : '')
        + '<div class="section-card"><h4>错误分析</h4>'
        + '<p class="analysis-text">' + analysisHtml + '</p></div>'
        + '<div class="section-card fix-card"><h4>修复建议</h4>'
        + '<p>' + this.esc(aiData.fixSuggestion) + '</p></div>'
        + '</div>';
    }

    // Loading state
    return '<div class="analysis-loading"><div class="spinner"></div><p>正在调用 AI 分析...</p></div>';
  }

  /**
   * Convert "file:line" references in text into clickable links.
   */
  private makeFileLinksClickable(text: string): string {
    // Replace "file.py:123" with a clickable link
    return text.replace(
      /([a-zA-Z0-9_./\\-]+\.py):(\d+)/g,
      '<a href="#" class="file-link" data-file="$1" data-line="$2">$1:$2</a>'
    );
  }

  private buildTerminalHtml(): string {
    if (!this.currentTraceback) return '';
    const tb = this.currentTraceback.slice(0, 2500);
    return `<div class="section-card terminal-section">
      <div class="terminal-header" onclick="toggleTerminal(this)">
        <span class="file-toggle">▶</span>
        <span>终端输出</span>
      </div>
      <pre class="terminal-text" style="display:none">${this.esc(tb)}${this.currentTraceback.length > 2500 ? '\n...' : ''}</pre>
    </div>`;
  }

  private esc(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }

  private getHtmlTemplate(
    error: ErrorAnalysisResult,
    categoryHtml: string,
    codeContextHtml: string,
    stackHtml: string,
    analysisHtml: string,
    terminalHtml: string,
  ): string {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
:root{--bg:#1e1e1e;--bg-card:#252526;--text:#d4d4d4;--text-muted:#808080;--accent:#007acc;--border:#3c3c3c;--success:#40c060;}
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:var(--bg);color:var(--text);padding:12px;font-size:13px;line-height:1.5;}
h3{margin-bottom:8px;font-size:16px;}h4{font-size:12px;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;color:#999;}
.category-section{margin-bottom:10px;}
.category-badge{padding:4px 10px;border-radius:4px;font-size:12px;font-weight:600;display:inline-block;margin-bottom:6px;}
.code-context-section{margin-bottom:12px;}
.file-context{background:var(--bg-card);border:1px solid var(--border);border-radius:6px;margin-bottom:6px;overflow:hidden;}
.file-context.main-file{border-left:3px solid var(--accent);}
.file-header{padding:6px 10px;cursor:pointer;display:flex;align-items:center;gap:6px;user-select:none;font-size:12px;}
.file-header:hover{background:rgba(255,255,255,0.03);}
.file-toggle{color:var(--text-muted);font-size:10px;transition:transform .15s;display:inline-block;}
.file-toggle.open{transform:rotate(90deg);}
.file-label{font-weight:600;white-space:nowrap;}
.file-path{color:var(--text-muted);font-size:10px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.file-lines{color:var(--text-muted);font-size:10px;white-space:nowrap;}
.file-content pre{font-family:Consolas,Monaco,monospace;font-size:11px;line-height:1.5;padding:8px 10px;background:rgba(0,0,0,0.2);overflow-x:auto;white-space:pre;color:var(--text);margin:0;}
.stack-section{background:var(--bg-card);border:1px solid var(--border);border-radius:6px;padding:10px;margin-bottom:12px;}
.stack-frame{padding:3px 0;border-bottom:1px solid var(--border);font-family:Consolas,Monaco,monospace;font-size:12px;}
.stack-frame:last-child{border-bottom:none;}
.chain-header{font-size:11px;color:var(--text-muted);padding:6px 0 2px;font-style:italic;border-top:1px dashed var(--border);margin-top:4px;}
.chain-frame{padding-left:12px;}
.frame-file{color:#569cd6;cursor:pointer;}.frame-file:hover{text-decoration:underline;}
.frame-line{color:#b5cea8;}.frame-func{color:#dcdcaa;}
.code-line{color:#ce9178;padding-left:16px;margin-top:2px;font-size:11px;}
.error-pair{display:flex;gap:12px;margin-bottom:12px;}
.error-original,.error-translated{flex:1;background:var(--bg-card);border:1px solid var(--border);border-radius:6px;padding:10px;min-width:0;}
.error-text,.translated-text{font-family:Consolas,Monaco,monospace;font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-word;}
.error-type{color:#f48771;font-weight:bold;margin-bottom:4px;}
.error-msg{color:#ce9178;}
.section-card{background:var(--bg-card);border:1px solid var(--border);border-radius:6px;padding:10px;margin-bottom:8px;}
.fix-card{border-left:3px solid var(--success);}
.fix-card p{color:var(--success);}
.keyword-pills{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px;}
.keyword-badge{background:var(--bg-card);border:1px solid #e6b800;border-radius:12px;padding:3px 8px;font-size:11px;cursor:pointer;transition:all .15s;}
.keyword-badge:hover{background:rgba(230,184,0,0.2);box-shadow:0 0 4px rgba(230,184,0,.3);}
.kw-en{color:#569cd6;}.kw-cn{color:#e6b800;}
/* Clickable file links in analysis text */
.analysis-text{line-height:1.8;}
.file-link{color:#569cd6;text-decoration:underline;cursor:pointer;}
.file-link:hover{color:#75b8f0;}
.terminal-section{margin-bottom:0;border:1px solid var(--border);}
.terminal-header{padding:6px 10px;cursor:pointer;display:flex;align-items:center;gap:6px;user-select:none;font-size:12px;color:var(--text-muted);}
.terminal-header:hover{background:rgba(255,255,255,0.03);}
.terminal-text{font-family:Consolas,Monaco,monospace;font-size:11px;line-height:1.5;color:#ce9178;max-height:200px;overflow-y:auto;white-space:pre-wrap;word-break:break-word;background:rgba(0,0,0,0.3);padding:8px;border-radius:4px;margin:0 4px 4px;}
.analysis-loading{text-align:center;padding:40px;color:var(--text-muted);}
.spinner{width:24px;height:24px;border:3px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin 1s linear infinite;margin:0 auto 12px;}
@keyframes spin{to{transform:rotate(360deg);}}
</style>
</head>
<body>
<h3>⚠ ${this.esc(error.errorType)}</h3>
${categoryHtml}
${codeContextHtml}
${stackHtml}
${analysisHtml}
${terminalHtml}
<script>
(function(){
  const vscode = acquireVsCodeApi();

  // Toggle file context sections
  window.toggleFile = function(el) {
    const content = el.nextElementSibling;
    const toggle = el.querySelector('.file-toggle');
    if (content.style.display === 'none' || !content.style.display) {
      content.style.display = 'block';
      toggle.classList.add('open');
    } else {
      content.style.display = 'none';
      toggle.classList.remove('open');
    }
  };

  // Toggle terminal section
  window.toggleTerminal = function(el) {
    const content = el.nextElementSibling;
    const toggle = el.querySelector('.file-toggle');
    if (content.style.display === 'none' || !content.style.display) {
      content.style.display = 'block';
      toggle.classList.add('open');
    } else {
      content.style.display = 'none';
      toggle.classList.remove('open');
    }
  };

  // Clickable file:line links in analysis text
  document.addEventListener('click', function(e) {
    const target = e.target;
    if (target.classList.contains('file-link')) {
      e.preventDefault();
      const file = target.getAttribute('data-file');
      const line = parseInt(target.getAttribute('data-line'), 10);
      vscode.postMessage({ type: 'openFile', file: file, line: line });
    }
  });

  // Clickable stack frame files
  document.addEventListener('click', function(e) {
    const target = e.target;
    if (target.classList.contains('frame-file')) {
      const text = target.textContent;
      // Try to extract line from sibling elements
      const parent = target.parentElement;
      const lineEl = parent?.querySelector('.frame-line');
      const line = lineEl ? parseInt(lineEl.textContent, 10) : 1;
      vscode.postMessage({ type: 'openFile', file: text, line: line });
    }
  });

  // Auto-open any expanded file sections
  document.querySelectorAll('.file-toggle.open').forEach(function(el) {
    el.closest('.file-header')?.click();
  });
})();
</script>
</body>
</html>`;
  }
}
