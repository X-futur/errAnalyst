import * as vscode from 'vscode';
import { Config, ErrorAnalysisResult } from '../config';
import { resolveCoreTerm } from '../errorTerms';
import type { BuiltContext, FileContext } from '../context/contextBuilder';
import type { FixViewSnapshot } from '../fix/session';
import type { ChatViewSnapshot } from '../chat/types';

type AiAnalysisViewData = {
  translation: string;
  keywords: Array<{ cn: string; en: string }>;
  analysis: string;
  fixSuggestion: string;
};

const FILE_PATH_LINK_REGEX = /([A-Za-z0-9_./\\-]+(?:\.(?:py|js|jsx|ts|tsx|mjs|cjs|json|jsonc|ya?ml|toml|env|cfg|ini|conf|txt|md|markdown|html|css|scss|csv|tsv|log|sh|sql|xml|lock|gitignore|editorconfig)|(?:Dockerfile|Makefile|Gemfile|Rakefile|Procfile|Vagrantfile))):(\d+)/g;

interface ShowOptions {
  fromCache?: boolean;
  cachedAt?: number;
}

export type FixWebviewAction =
  | 'acceptFixHunk'
  | 'rejectFixHunk'
  | 'acceptAllFix'
  | 'rejectAllFix'
  | 'undoAllFix'
  | 'endFix'
  | 'openFixHunk';

export type ChatWebviewAction =
  | 'newChatSession'
  | 'generatePatch'
  | 'removeFile'
  | 'restoreDefaults';

interface AnalysisViewHandlers {
  onReanalyze: (error: ErrorAnalysisResult) => void;
  onStartFix: () => void;
  onFixAction: (action: FixWebviewAction, hunkId?: string) => void;
  onChatSend: (content: string) => void;
  onChatAction: (action: ChatWebviewAction, fileId?: string) => void;
  onChatAddFiles: () => void;
}

export class AnalysisViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'errAnalyst.errorHistory';
  private view?: vscode.WebviewView;
  private currentError: ErrorAnalysisResult | null = null;
  private currentAiData: AiAnalysisViewData | null = null;
  private currentContext: BuiltContext | null = null;
  private currentTraceback: string = "";
  private fromCache = false;
  private cachedAt = 0;
  private aiError: string | null = null;
  private fixState: FixViewSnapshot | null = null;
  private fixGenerating = false;
  private fixError: string | null = null;
  private chatSnapshot: ChatViewSnapshot | null = null;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly handlers: AnalysisViewHandlers,
  ) { }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.onDidReceiveMessage(msg => this.handleWebviewMessage(msg));
    this.updateContent();
  }

  show(error: ErrorAnalysisResult, aiData?: AiAnalysisViewData, options?: ShowOptions): void {
    this.currentError = error;
    this.currentAiData = aiData || null;
    this.fromCache = options?.fromCache || false;
    this.cachedAt = options?.cachedAt || 0;
    this.aiError = null;
    this.fixState = null;
    this.fixGenerating = false;
    this.fixError = null;
    if (this.view) {
      this.view.show(true);
      this.updateContent();
    } else {
      void this.focus();
    }
  }

  focus(): void {
    void vscode.commands.executeCommand(`${AnalysisViewProvider.viewType}.focus`)
      .then(() => this.updateContent());
  }

  showAiError(message: string): void {
    this.aiError = message;
    this.currentAiData = null;
    this.updateContent();
  }

  showFixGenerating(): void {
    this.fixGenerating = true;
    this.fixError = null;
    this.fixState = null;
    this.updateContent();
  }

  showFixSession(snapshot: FixViewSnapshot): void {
    this.fixState = snapshot;
    this.fixGenerating = false;
    this.fixError = null;
    this.updateContent();
  }

  showFixError(message: string): void {
    this.fixError = message;
    this.fixGenerating = false;
    this.fixState = null;
    this.updateContent();
  }

  clearFixState(): void {
    this.fixState = null;
    this.fixGenerating = false;
    this.fixError = null;
    this.updateContent();
  }

  /** Show full traceback and code context (sent from extension after AI returns) */
  showContext(fullTraceback: string, context?: BuiltContext): void {
    this.currentTraceback = fullTraceback;
    this.currentContext = context || null;
    this.updateContent();
  }

  showChat(snapshot: ChatViewSnapshot): void {
    this.chatSnapshot = snapshot;
    this.updateContent();
  }

  /** Forwards one streamed chunk to the webview without rebuilding the page. */
  streamChatChunk(messageId: string, content: string): void {
    void this.view?.webview.postMessage({ type: 'chatChunk', messageId, content });
  }

  private handleWebviewMessage(msg: any): void {
    switch (msg.type) {
      case 'openFile':
        this.openFileAtLine(msg.file, msg.line);
        break;
      case 'reanalyze':
        if (this.currentError) {
          this.handlers.onReanalyze(this.currentError);
        }
        break;
      case 'startFix':
        this.handlers.onStartFix();
        break;
      case 'acceptFixHunk':
      case 'rejectFixHunk':
      case 'openFixHunk':
        this.handlers.onFixAction(msg.type, msg.hunkId);
        break;
      case 'acceptAllFix':
      case 'rejectAllFix':
      case 'undoAllFix':
      case 'endFix':
        this.handlers.onFixAction(msg.type);
        break;
      case 'chatSend':
        if (typeof msg.content === 'string') {
          this.handlers.onChatSend(msg.content);
        }
        break;
      case 'chatAction':
        this.handlers.onChatAction(msg.action, msg.fileId);
        break;
      case 'chatAddFiles':
        this.handlers.onChatAddFiles();
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
    if (!this.view || !this.currentError) return;
    const error = this.currentError;

    const headerHtml = this.buildHeaderHtml();
    const analysisHtml = this.buildAnalysisHtml();
    const sourceInfoHtml = this.buildSourceInfoHtml();

    this.view.webview.html = this.getHtmlTemplate(headerHtml, analysisHtml, sourceInfoHtml);
  }

  private buildHeaderHtml(): string {
    const error = this.currentError;
    if (!error) return '';
    const aiData = this.currentAiData;

    let kwPills = '';
    if (aiData) {
      for (const kw of aiData.keywords) {
        const cn = resolveCoreTerm(kw.en, kw.cn);
        if (!cn) continue;
        kwPills += '<span class="keyword-badge" data-en="' + this.esc(kw.en) + '" data-cn="' + this.esc(cn) + '">'
          + '<span class="kw-en">' + this.esc(kw.en) + '</span> ↔ '
          + '<span class="kw-cn">' + this.esc(cn) + '</span>'
          + '</span>';
      }
    }

    let pairHtml = '';
    if (aiData) {
      pairHtml = `<div class="error-pair">
        <div class="error-original"><h4>原始报错</h4>`
        + `<pre class="error-text">`
        + `<div class="error-type">${this.esc(error.errorType)}</div>`
        + `<div class="error-msg">${this.esc(error.errorMessage)}</div>`
        + `</pre></div>`
        + `<div class="error-translated"><h4>中文翻译</h4>`
        + `<div class="translated-text">${aiData.translation}</div>`
        + `</div></div>`;
    }

    return '<div class="error-header">'
      + `<div class="error-type-row">`
      + `<div class="error-type-chip"><h3>${this.esc(error.errorType)}</h3></div>`
      + `<span class="tooltip-wrap align-right tooltip-below" data-tooltip="重新 AI 分析">`
      + `<button class="reanalyze-btn" onclick="reanalyze()">↻</button>`
      + `</span>`
      + `</div>`
      + this.buildCategoryHtml()
      + pairHtml
      + (kwPills ? '<div class="keyword-pills">' + kwPills + '</div>' : '')
      + '</div>';
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
      <div class="category-badge" style="border-left:3px solid ${c.color};color:${c.color}">
        <span>▶ ${c.label}</span>
      </div>
    </div>`;
  }

  private buildCodeContextContent(): string {
    const ctx = this.currentContext;
    if (!ctx) return '';

    const hasFiles = ctx.mainFile
      || ctx.stackFiles.length > 0
      || ctx.configFiles.length > 0
      || ctx.siblingFiles.length > 0;
    if (!hasFiles) {
      return '<div class="context-empty">未找到可重建的代码上下文，文件可能已变化</div>';
    }

    let html = '';
    if (ctx.mainFile) {
      html += this.renderFileContext(ctx.mainFile, true);
    }
    for (const f of ctx.stackFiles) {
      html += this.renderFileContext(f, false);
    }
    for (const f of ctx.configFiles) {
      html += this.renderFileContext(f, false);
    }
    for (const f of ctx.siblingFiles) {
      html += this.renderFileContext(f, false);
    }
    return html;
  }

  private renderFileContext(fc: FileContext, isMain: boolean): string {
    const label = isMain ? '主要报错文件' : (fc.path.split('/').pop() || fc.path);
    const relPath = fc.path;
    return `<div class="file-context ${isMain ? 'main-file' : ''}">
      <div class="file-row" onclick="toggleFile(this)">
        <span class="file-toggle">▶</span>
        <span class="file-label">${this.esc(label)}</span>
        <span class="file-path">${this.esc(relPath)}</span>
        <span class="file-lines">L${fc.startLine}-${fc.endLine}</span>
      </div>
      <div class="file-content" style="display:none">
        <pre>${this.esc(fc.content)}</pre>
      </div>
    </div>`;
  }

  private buildStackContent(): string {
    if (!this.currentError || this.currentError.stackFrames.length === 0) return '';
    let html = '';
    // Primary stack
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
    return html;
  }

  private buildTerminalContent(): string {
    if (!this.currentTraceback) return '';
    const tb = this.currentTraceback.slice(0, 2500);
    return `<pre class="terminal-text">${this.esc(tb)}${this.currentTraceback.length > 2500 ? '\n...' : ''}</pre>`;
  }

  private buildSourceInfoHtml(): string {
    const stackContent = this.buildStackContent();
    const terminalContent = this.buildTerminalContent();
    const contextContent = this.buildCodeContextContent();
    if (!stackContent && !terminalContent && !contextContent) return '';

    let html = '<div class="source-group">';
    html += '<div class="source-group-label"><h3>源信息</h3></div>';

    if (stackContent) {
      html += '<div class="source-item">'
        + '<div class="source-header" onclick="toggleSource(this)"><span class="file-toggle">▶</span><span>调用栈</span></div>'
        + '<div class="source-content" style="display:none">' + stackContent + '</div>'
        + '</div>';
    }
    if (terminalContent) {
      html += '<div class="source-item">'
        + '<div class="source-header" onclick="toggleSource(this)"><span class="file-toggle">▶</span><span>终端输出</span></div>'
        + '<div class="source-content" style="display:none">' + terminalContent + '</div>'
        + '</div>';
    }
    if (contextContent) {
      html += '<div class="source-item">'
        + '<div class="source-header" onclick="toggleSource(this)"><span class="file-toggle">▶</span><span>源代码上下文</span></div>'
        + '<div class="source-content" style="display:none">' + contextContent + '</div>'
        + '</div>';
    }
    html += '</div>';
    return html;
  }

  private buildAnalysisHtml(): string {
    const error = this.currentError;
    if (!error) return '';
    const aiData = this.currentAiData;

    let body: string;
    if (this.aiError) {
      body = '<div class="analysis-error">' + this.esc(this.aiError) + '</div>';
    } else if (aiData) {
      body = this.buildAnalysisContentHtml(error, aiData);
    } else {
      // Loading state
      body = '<div class="analysis-loading"><div class="spinner"></div><p>正在调用 AI 分析...</p></div>';
    }

    if (this.chatSnapshot && Config.getInstance().getEnableChat()) {
      body += this.buildChatHtml();
    }
    return body;
  }

  private buildAnalysisContentHtml(error: ErrorAnalysisResult, aiData: AiAnalysisViewData): string {
    // Make file:line references clickable in analysis text
    const analysisHtml = this.makeFileLinksClickable(this.esc(aiData.analysis));
    const fixSuggestionHtml = this.makeFileLinksClickable(this.esc(aiData.fixSuggestion));

    return '<div class="analysis-content">'
      + '<div class="section-card"><h3>错误分析</h3>'
      + '<p class="analysis-text">' + analysisHtml + '</p></div>'
      + '<div class="section-card fix-card"><h3>修复建议</h3>'
      + '<p class="analysis-text">' + fixSuggestionHtml + '</p>'
      + this.buildFixControlsHtml()
      + '</div>'
      + '</div>';
  }

  private buildFixControlsHtml(): string {
    if (this.fixGenerating) {
      return '<div class="fix-controls fix-generating"><span class="spinner"></span><span>正在生成修复补丁...</span></div>';
    }
    if (this.fixError) {
      return '<div class="fix-controls fix-error">' + this.esc(this.fixError) + '</div>';
    }
    if (this.fixState) {
      const s = this.fixState;
      const statusLabel: Record<string, string> = {
        pending: '待确认',
        accepted: '已接受',
        rejected: '已拒绝',
        stale: '已失效',
      };
      let hunksHtml = '';
      for (const h of s.hunks) {
        hunksHtml += `<div class="fix-hunk-row ${h.status}">`
          + `<span class="fix-hunk-file">${this.esc(h.file)}${h.line ? ':' + h.line : ''}</span>`
          + `<span class="fix-hunk-reason">${this.esc(h.reason)}</span>`
          + `<span class="fix-hunk-status">${statusLabel[h.status] || h.status}</span>`
          + (h.status === 'pending'
            ? `<button class="fix-mini-btn" onclick="fixAction('acceptFixHunk','${h.id}')">接受</button>`
            + `<button class="fix-mini-btn reject" onclick="fixAction('rejectFixHunk','${h.id}')">拒绝</button>`
            : '')
          + (h.line ? `<button class="fix-mini-btn" onclick="fixAction('openFixHunk','${h.id}')">查看</button>` : '')
          + '</div>';
      }
      return '<div class="fix-controls">'
        + `<div class="fix-summary">共 ${s.total} 处 · 待确认 ${s.pending} · 已接受 ${s.accepted}${s.stale ? ` · 失效 ${s.stale}` : ''}</div>`
        + '<div class="fix-actions">'
        + `<button class="fix-btn" onclick="fixAction('acceptAllFix')" ${s.pending === 0 ? 'disabled' : ''}>全部接受</button>`
        + `<button class="fix-btn" onclick="fixAction('rejectAllFix')" ${s.pending === 0 ? 'disabled' : ''}>全部拒绝</button>`
        + `<button class="fix-btn" onclick="fixAction('undoAllFix')" ${s.accepted === 0 ? 'disabled' : ''}>撤销全部</button>`
        + '<button class="fix-btn" onclick="fixAction(\'endFix\')">结束修复</button>'
        + '</div>'
        + (s.hunks.length > 0
          ? '<div class="fix-hunks">' + hunksHtml + '</div>'
          : '<div class="fix-empty">AI 未生成可应用的修复补丁</div>')
        + '</div>';
    }
    return '<div class="fix-controls fix-idle"><button class="fix-btn primary" onclick="startFix()">一键修复</button></div>';
  }

  private buildChatHtml(): string {
    const s = this.chatSnapshot;
    if (!s) return '';

    let chips = '';
    if (s.contextFiles.length === 0) {
      chips = '<span class="chat-files-empty">暂无上下文文件，可点击“添加文件”</span>';
    } else {
      for (const f of s.contextFiles) {
        const flags: string[] = [];
        if (f.truncated) flags.push('已截断');
        if (f.changed) flags.push('已变化');
        if (f.skipped) flags.push('超出预算');
        if (f.unavailable) flags.push('不可用');
        const flagHtml = flags.length
          ? ' <span class="chip-flag">' + flags.map(x => this.esc(x)).join(' · ') + '</span>'
          : '';
        const sourceLabel = f.source === 'auto' ? '自动' : '新增';
        const chipClass = (f.skipped ? ' skipped' : '') + (f.unavailable ? ' unavailable' : '');
        const fileName = f.path.split(/[\\/]/).pop() || f.path;
        chips += `<span class="chat-chip${chipClass}" title="${this.esc(f.path)}">`
          + `<span class="chip-name">${this.esc(fileName)}</span>`
          + `<span class="chip-meta">${sourceLabel} · L${f.startLine}-${f.endLine}</span>`
          + flagHtml
          + `<span class="tooltip-wrap" data-tooltip="移除">`
          + `<button class="chip-remove" onclick="chatAction('removeFile','${this.esc(f.id)}')">×</button>`
          + `</span>`
          + '</span>';
      }
    }

    let messages = '';
    for (const m of s.messages) {
      if (m.role === 'notice') {
        messages += '<div class="chat-msg notice">' + this.esc(m.content) + '</div>';
      } else {
        const label = m.role === 'user' ? '你' : 'AI';
        messages += `<div class="chat-msg ${m.role}">`
          + `<div class="chat-msg-label">${label}</div>`
          + '<div class="chat-msg-body">' + this.renderChatMarkdown(m.content) + '</div>'
          + '</div>';
      }
    }
    if (s.error) {
      messages += '<div class="chat-msg notice error">' + this.esc(s.error) + '</div>';
    }
    // if (messages === '') {
    //   messages = '<div class="chat-msg notice">还没有消息，可以直接追问报错原因。</div>';
    // }

    const busy = s.sending || s.generatingPatch;
    const patchDisabled = busy || s.messages.length === 0 ? 'disabled' : '';
    const sendDisabled = busy ? 'disabled' : '';
    const sendLabel = s.generatingPatch ? '生成补丁中...' : (s.sending ? '思考中...' : '发送');

    return `<div class="section-card chat-card">
      <div class="chat-header">
        <h3>错误分析会话</h3>
        <div class="chat-actions">
          <span class="tooltip-wrap align-right" data-tooltip="新开会话"><button class="icon-btn" onclick="chatAction('newChatSession')" ${busy ? 'disabled' : ''}>${this.iconSvg('new')}</button></span>
          <span class="tooltip-wrap align-right" data-tooltip="生成修复补丁"><button class="icon-btn primary" onclick="chatAction('generatePatch')" ${patchDisabled}>${this.iconSvg('patch')}</button></span>
          <span class="tooltip-wrap align-right" data-tooltip="添加文件"><button class="icon-btn" onclick="chatAddFiles()" ${busy ? 'disabled' : ''}>${this.iconSvg('add')}</button></span>
          <span class="tooltip-wrap align-right" data-tooltip="恢复默认文件"><button class="icon-btn" onclick="chatAction('restoreDefaults')" ${busy ? 'disabled' : ''}>${this.iconSvg('restore')}</button></span>
        </div>
      </div>
      <div class="chat-messages" id="chatMessages">${messages}</div>
      <div class="chat-files"><div class="chat-chips">${chips}</div></div>
      <div class="chat-input-row">
        <textarea id="chatInput" placeholder="追问具体出错原因或行号..." ${sendDisabled}></textarea>
        <button class="chat-btn primary" onclick="chatSend()" ${sendDisabled}>${sendLabel}</button>
      </div>
    </div>`;
  }

  private iconSvg(name: 'new' | 'patch' | 'add' | 'restore'): string {
    const paths: Record<string, string> = {
      new: '<path d="M21 12a8 8 0 0 1-8 8H4l2-3a8 8 0 1 1 15-5z"/><path d="M12 9v6M9 12h6"/>',
      patch: '<path d="M6 2h8l4 4v16H6z"/><path d="M9 9l-2 2 2 2M15 9l2 2-2 2"/>',
      add: '<path d="M6 2h8l4 4v16H6z"/><path d="M12 11v6M9 14h6"/>',
      restore: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
    };
    return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths[name]}</svg>`;
  }

  private renderChatMarkdown(text: string): string {
    const escaped = this.esc(text);
    const parts = escaped.split(/```/);
    let html = '';
    for (let i = 0; i < parts.length; i++) {
      if (i % 2 === 1) {
        // Fenced code block: drop an optional language tag on the first line.
        const body = parts[i].replace(/^[a-zA-Z0-9_+-]+\n/, '');
        html += '<pre class="chat-code">' + body + '</pre>';
      } else {
        html += this.renderChatInlineBlock(parts[i]);
      }
    }
    return html;
  }

  private renderChatInlineBlock(block: string): string {
    const lines = block.split('\n');
    const out: string[] = [];
    let listOpen: 'ul' | 'ol' | null = null;
    const closeList = () => {
      if (listOpen) {
        out.push('</' + listOpen + '>');
        listOpen = null;
      }
    };

    for (const rawLine of lines) {
      const heading = rawLine.match(/^\s{0,3}(#{1,4})\s+(.*)$/);
      if (heading) {
        closeList();
        out.push('<h4 class="chat-h">' + this.renderChatInline(heading[2]) + '</h4>');
        continue;
      }
      const ul = rawLine.match(/^\s*[-*]\s+(.*)$/);
      if (ul) {
        if (listOpen !== 'ul') {
          closeList();
          out.push('<ul>');
          listOpen = 'ul';
        }
        out.push('<li>' + this.renderChatInline(ul[1]) + '</li>');
        continue;
      }
      const ol = rawLine.match(/^\s*(\d+)\.\s+(.*)$/);
      if (ol) {
        if (listOpen !== 'ol') {
          closeList();
          out.push('<ol>');
          listOpen = 'ol';
        }
        out.push('<li>' + this.renderChatInline(ol[2]) + '</li>');
        continue;
      }
      closeList();
      if (rawLine.trim() === '') {
        out.push('<div class="chat-p"></div>');
      } else {
        out.push('<p class="chat-p">' + this.renderChatInline(rawLine) + '</p>');
      }
    }
    closeList();
    return out.join('');
  }

  private renderChatInline(text: string): string {
    let html = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    return this.makeBroadFileLinksClickable(html);
  }

  /** Broader file:line linking for chat replies (config and code files alike). */
  private makeBroadFileLinksClickable(text: string): string {
    return this.makeFileLinksClickable(text);
  }

  /**
   * Convert "file:line" references in text into clickable links.
   */
  private makeFileLinksClickable(text: string): string {
    return text.replace(
      FILE_PATH_LINK_REGEX,
      (_match, file: string, line: string) => {
        // Keep the original path in data-file, but add break opportunities
        // after path separators so long paths wrap instead of widening the row.
        const wrappedFile = file.replace(/\//g, '/<wbr>').replace(/\\/g, '\\<wbr>');
        return `<a href="#" class="file-link" data-file="${file}" data-line="${line}">${wrappedFile}:${line}</a>`;
      }
    );
  }

  private esc(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }

  private getHtmlTemplate(
    headerHtml: string,
    analysisHtml: string,
    sourceInfoHtml: string,
  ): string {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
:root{--bg:var(--vscode-sideBar-background,#1e1e1e);--bg-card:var(--vscode-sideBarSectionHeader-background,#252526);--text:var(--vscode-sideBar-foreground,#d4d4d4);--text-muted:var(--vscode-descriptionForeground,#808080);--accent:var(--vscode-focusBorder,#007acc);--border:var(--vscode-panel-border,#3c3c3c);--success:var(--vscode-testing-iconPassed,#40c060);--error:var(--vscode-errorForeground,#f48771);}
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:var(--bg);color:var(--text);padding:10px;font-size:11px;line-height:1.5;}
h3{margin-bottom:8px;font-size:14px;}h4{font-size:11px;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;color:#999;}
.cache-badge{background:transparent;border:none;border-radius:0;color:var(--success);padding:4px 0;font-size:11px;margin-bottom:8px;}
.error-header{border-bottom:1px solid var(--border);padding-bottom:8px;margin-bottom:8px;}
.error-type-row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;}
.error-type-chip{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--text-muted);padding:0;}
.error-type-chip b{color:var(--text);font-family:Consolas,Monaco,monospace;font-weight:600;}
.reanalyze-btn{background:var(--bg-card);border:1px solid var(--border);color:var(--text);border-radius:4px;padding:4px 8px;font-size:11px;cursor:pointer;}
.reanalyze-btn:hover{border-color:var(--accent);color:#fff;}
.category-section{margin-bottom:10px;}
.category-badge{background:transparent;border-left:3px solid currentColor;border-radius:0;padding:2px 0 2px 8px;font-size:12px;font-weight:600;display:inline-block;margin-bottom:6px;}
.file-context{background:transparent;border:none;border-radius:0;margin-bottom:0;overflow:hidden;}
.file-context.main-file .file-label{color:var(--accent);}
.file-row{border-top:1px solid var(--border);padding:6px 0;cursor:pointer;display:flex;align-items:center;gap:6px;user-select:none;font-size:11px;}
.file-context:first-child .file-row{border-top:none;}
.file-row:hover{background:rgba(255,255,255,0.03);}
.file-toggle{color:var(--text-muted);font-size:10px;transition:transform .15s;display:inline-block;}
.file-toggle.open{transform:rotate(90deg);}
.file-label{font-weight:600;white-space:nowrap;}
.file-path{color:var(--text-muted);font-size:10px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.file-lines{color:var(--text-muted);font-size:10px;white-space:nowrap;}
.file-content pre{font-family:Consolas,Monaco,monospace;font-size:10px;line-height:1.5;padding:4px 0 4px 8px;background:transparent;border-left:2px solid var(--border);overflow-x:auto;white-space:pre;color:var(--text);margin:0;}
.source-group{background:transparent;border:none;border-radius:0;border-top:1px solid var(--border);margin-top:8px;overflow:hidden;}
.source-group-label{padding:6px 0 2px;font-size:10px;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);}
.source-item{border-top:1px solid var(--border);}
.source-item:first-child{border-top:none;}
.source-header{padding:6px 0;cursor:pointer;display:flex;align-items:center;gap:6px;user-select:none;font-size:11px;}
.source-header:hover{background:rgba(255,255,255,0.03);}
.source-content{padding:0 0 6px;}
.stack-frame{padding:3px 0;border-bottom:1px solid var(--border);font-family:Consolas,Monaco,monospace;font-size:12px;}
.stack-frame:last-child{border-bottom:none;}
.chain-header{font-size:11px;color:var(--text-muted);padding:6px 0 2px;font-style:italic;border-top:1px dashed var(--border);margin-top:4px;}
.chain-frame{padding-left:12px;}
.frame-file{color:#569cd6;cursor:pointer;}.frame-file:hover{text-decoration:underline;}
.frame-line{color:#b5cea8;}.frame-func{color:#dcdcaa;}
.code-line{color:#ce9178;padding-left:16px;margin-top:2px;font-size:11px;}
.error-pair{display:flex;gap:0;margin-bottom:8px;}
.error-original,.error-translated{flex:1;background:transparent;border:none;border-radius:0;padding:0;min-width:0;}
.error-original{border-right:1px solid var(--border);padding-right:8px;}
.error-translated{padding-left:8px;}
.error-text,.translated-text{font-family:Consolas,Monaco,monospace;font-size:11px;line-height:1.6;white-space:pre-wrap;word-break:break-word;}
.error-type{color:#f48771;font-weight:bold;margin-bottom:4px;}
.error-msg{color:#ce9178;}
.section-card{background:transparent;border:none;border-radius:0;border-top:1px solid var(--border);padding:8px 0;margin:0;}
.fix-card{border-left:none;}
.fix-card p{color:var(--success);}
.keyword-pills{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px;}
.keyword-badge{background:transparent;border:1px solid #e6b800;border-radius:12px;padding:2px 8px;font-size:10px;cursor:pointer;transition:all .15s;}
.keyword-badge:hover{background:rgba(230,184,0,0.2);box-shadow:0 0 4px rgba(230,184,0,.3);}
.kw-en{color:#569cd6;}.kw-cn{color:#e6b800;}
/* Clickable file links in analysis text */
.analysis-text{line-height:1.8;}
.file-link{color:#569cd6;text-decoration:underline;cursor:pointer;}
.file-link:hover{color:#75b8f0;}
.terminal-text{font-family:Consolas,Monaco,monospace;font-size:10px;line-height:1.5;color:#ce9178;max-height:200px;overflow-y:auto;white-space:pre-wrap;word-break:break-word;background:transparent;padding:4px 0 4px 8px;border-left:2px solid var(--border);border-radius:0;margin-top:4px;}
.analysis-loading{text-align:center;padding:40px;color:var(--text-muted);}
.analysis-error{background:transparent;border:none;border-left:3px solid var(--error);border-radius:0;padding:8px;font-size:12px;color:var(--error);}
.chat-card{display:flex;flex-direction:column;gap:6px;border-left:none;}
.chat-header{display:flex;align-items:center;justify-content:space-between;gap:8px;}
.chat-header h4{margin:0;text-transform:none;color:var(--text);}
.chat-actions{display:flex;gap:6px;}
.icon-btn{background:transparent;border:1px solid transparent;color:var(--text-muted);border-radius:4px;padding:4px;font-size:0;line-height:0;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;}
.icon-btn:hover:not(:disabled){border-color:var(--border);color:var(--text);}
.icon-btn.primary{color:var(--accent);}
.icon-btn.primary:hover:not(:disabled){color:#fff;background:var(--accent);border-color:var(--accent);}
.icon-btn:disabled{opacity:.45;cursor:default;}
.tooltip-wrap{position:relative;display:inline-flex;--tt-left:50%;--tt-right:auto;--tt-transform:translateX(-50%);}
.tooltip-wrap.align-right{--tt-left:auto;--tt-right:0;--tt-transform:none;}
.tooltip-wrap[data-tooltip]:hover::after,.tooltip-wrap[data-tooltip]:focus-within::after{content:attr(data-tooltip);position:absolute;bottom:calc(100% + 6px);left:var(--tt-left);right:var(--tt-right);transform:var(--tt-transform);background:var(--vscode-editorHoverWidget-background,#252526);color:var(--vscode-editorHoverWidget-foreground,#d4d4d4);border:1px solid var(--vscode-editorHoverWidget-border,#3c3c3c);padding:3px 7px;font-size:11px;line-height:1.4;white-space:nowrap;border-radius:3px;z-index:20;pointer-events:none;box-shadow:0 2px 8px rgba(0,0,0,.25);}
.tooltip-wrap.tooltip-below[data-tooltip]:hover::after,.tooltip-wrap.tooltip-below[data-tooltip]:focus-within::after{top:calc(100% + 6px);bottom:auto;}
.chat-btn{background:var(--bg-card);border:1px solid var(--border);color:var(--text);border-radius:4px;padding:4px 8px;font-size:11px;cursor:pointer;}
.chat-btn:hover:not(:disabled){border-color:var(--accent);color:#fff;}
.chat-btn:disabled{opacity:.45;cursor:default;}
.chat-btn.primary{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600;}
.chat-files{display:flex;flex-direction:column;gap:6px;border-top:1px solid var(--border);padding-top:6px;}
.chat-chips{display:flex;flex-wrap:nowrap;gap:6px;overflow-x:auto;padding-bottom:2px;}
.chat-chip{display:inline-flex;align-items:center;gap:5px;background:transparent;border:1px solid var(--border);border-radius:0;padding:2px 6px;font-size:10px;max-width:100%;}
.chat-chip.skipped,.chat-chip.unavailable{opacity:.55;}
.chip-name{color:#569cd6;font-family:Consolas,Monaco,monospace;white-space:nowrap;}
.chip-meta{color:var(--text-muted);white-space:nowrap;}
.chip-flag{color:#d7ba7d;}
.chip-remove{background:transparent;border:none;color:var(--text-muted);cursor:pointer;font-size:12px;line-height:1;padding:0 2px;}
.chip-remove:hover{color:#f44747;}
.chat-files-empty{color:var(--text-muted);font-size:11px;}
.chat-messages{display:flex;flex-direction:column;gap:8px;max-height:320px;overflow-y:auto;padding-right:2px;}
.chat-msg{display:flex;flex-direction:column;gap:3px;align-items:flex-start;}
.chat-msg.user{align-items:flex-end;}
.chat-msg-label{font-size:10px;color:var(--text-muted);}
.chat-msg.user .chat-msg-label{text-align:right;}
.chat-msg-body{max-width:92%;padding:6px 10px;border-radius:8px;border:1px solid var(--border);font-size:11px;line-height:1.6;word-break:break-word;background:rgba(128,128,128,.08);background:color-mix(in srgb,var(--vscode-editorWidget-background,#252526) 60%,transparent);}
.chat-msg.user .chat-msg-body{text-align:left;background:rgba(0,122,204,.10);background:color-mix(in srgb,var(--accent) 12%,transparent);border-color:color-mix(in srgb,var(--accent) 30%,transparent);}
.chat-msg.notice{align-self:center;width:100%;text-align:center;color:var(--text-muted);font-size:11px;}
.chat-msg.notice.error{color:#f48771;}
.chat-msg.streaming .chat-msg-body::after{content:'▋';color:var(--accent);margin-left:2px;animation:streamBlink 1s step-start infinite;}
@keyframes streamBlink{50%{opacity:0;}}
.chat-msg-body p{margin:0 0 4px;}.chat-msg-body p:last-child{margin-bottom:0;}
.chat-msg-body ul,.chat-msg-body ol{margin:4px 0 4px 18px;}
.chat-msg-body li{margin:2px 0;}
.chat-msg-body code{font-family:Consolas,Monaco,monospace;font-size:11px;background:rgba(0,0,0,.3);padding:1px 3px;border-radius:3px;}
.chat-code{font-family:Consolas,Monaco,monospace;font-size:11px;line-height:1.5;background:transparent;border:none;border-left:2px solid var(--border);border-radius:0;padding:4px 0 4px 8px;overflow-x:auto;white-space:pre-wrap;word-break:break-word;margin:4px 0;}
.chat-h{margin:6px 0 2px;}
.chat-p{margin:2px 0;}
.chat-input-row{display:flex;gap:6px;align-items:flex-end;border-top:1px solid var(--border);padding-top:6px;}
.chat-input-row textarea{flex:1;min-height:56px;resize:vertical;background:transparent;border:1px solid var(--border);color:var(--text);border-radius:0;padding:6px;font-family:inherit;font-size:11px;}
.chat-input-row textarea:focus{outline:none;border-color:var(--accent);}
.context-empty{color:var(--text-muted);font-size:11px;padding:8px 0;}
.spinner{width:24px;height:24px;border:3px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin 1s linear infinite;margin:0 auto 12px;}
@keyframes spin{to{transform:rotate(360deg);}}
.fix-controls{margin-top:8px;border-top:1px solid var(--border);padding-top:8px;display:flex;flex-direction:column;gap:8px;}
.fix-controls.fix-idle{align-items:flex-end;border-top:none;padding-top:0;margin-top:6px;}
.fix-controls.fix-generating{flex-direction:row;align-items:center;gap:8px;color:var(--text-muted);font-size:11px;}
.fix-controls.fix-generating .spinner{width:14px;height:14px;margin:0;border-width:2px;}
.fix-error{color:var(--error);font-size:11px;}
.fix-summary{font-size:11px;color:var(--text-muted);}
.fix-actions{display:flex;gap:6px;flex-wrap:wrap;}
.fix-btn{background:var(--bg-card);border:1px solid var(--border);color:var(--text);border-radius:4px;padding:4px 8px;font-size:11px;cursor:pointer;}
.fix-btn:hover:not(:disabled){border-color:var(--accent);color:#fff;}
.fix-btn:disabled{opacity:.45;cursor:default;}
.fix-btn.primary{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600;}
.fix-hunks{display:flex;flex-direction:column;gap:4px;max-height:180px;overflow-y:auto;}
.fix-hunk-row{display:flex;align-items:center;gap:6px;font-size:11px;background:transparent;border:none;border-top:1px solid var(--border);border-radius:0;padding:4px 0;}
.fix-hunk-row.accepted{border-left:3px solid var(--success);}
.fix-hunk-row.rejected{opacity:.6;}
.fix-hunk-row.stale{border-left:3px solid #f44747;opacity:.7;}
.fix-hunk-file{color:#569cd6;font-family:Consolas,Monaco,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:150px;}
.fix-hunk-reason{flex:1;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.fix-hunk-status{color:var(--text-muted);white-space:nowrap;}
.fix-mini-btn{background:transparent;border:1px solid var(--border);color:var(--text);border-radius:3px;padding:1px 6px;font-size:10px;cursor:pointer;white-space:nowrap;}
.fix-mini-btn:hover{border-color:var(--accent);}
.fix-mini-btn.reject:hover{border-color:#f44747;color:#f44747;}
.fix-empty{color:var(--text-muted);font-size:11px;}
</style>
</head>
<body>
${this.fromCache ? `<div class="cache-badge">来自本地缓存 · ${new Date(this.cachedAt).toLocaleString('zh-CN')}</div>` : ''}
${headerHtml}
${analysisHtml}
${sourceInfoHtml}
<script>
(function(){
  const vscode = acquireVsCodeApi();

  window.reanalyze = function() {
    vscode.postMessage({ type: 'reanalyze' });
  };

  window.startFix = function() {
    vscode.postMessage({ type: 'startFix' });
  };

  window.fixAction = function(action, id) {
    vscode.postMessage({ type: action, hunkId: id });
  };

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

  // Toggle source info sections (调用栈 / 终端输出 / 源代码上下文)
  window.toggleSource = function(el) {
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

  // Error analysis chat
  window.chatSend = function() {
    const input = document.getElementById('chatInput');
    if (!input) return;
    const content = input.value;
    if (!content.trim()) return;
    input.value = '';
    vscode.postMessage({ type: 'chatSend', content: content });
  };

  window.chatAction = function(action, fileId) {
    vscode.postMessage({ type: 'chatAction', action: action, fileId: fileId });
  };

  window.chatAddFiles = function() {
    vscode.postMessage({ type: 'chatAddFiles' });
  };

  // ── Streaming chat output ──
  const FILE_LINK_RE = /([A-Za-z0-9_./\\\\-]+(?:\\.(?:py|js|jsx|ts|tsx|mjs|cjs|json|jsonc|ya?ml|toml|env|cfg|ini|conf|txt|md|markdown|html|css|scss|csv|tsv|log|sh|sql|xml|lock|gitignore|editorconfig)|(?:Dockerfile|Makefile|Gemfile|Rakefile|Procfile|Vagrantfile))):(\\d+)/g;

  function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }

  function linkifyFileLines(text) {
    return text.replace(FILE_LINK_RE, function(_m, file, line) {
      const wrappedFile = file.replace(/\\//g, '/<wbr>').replace(/\\\\/g, '\\\\<wbr>');
      return '<a href="#" class="file-link" data-file="' + escHtml(file) + '" data-line="' + line + '">'
        + wrappedFile + ':' + line + '</a>';
    });
  }

  function renderChatInline(text) {
    let html = text.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
    html = html.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
    return linkifyFileLines(html);
  }

  function renderChatInlineBlock(block) {
    const lines = block.split('\\n');
    const out = [];
    let listOpen = null;
    const closeList = function() {
      if (listOpen) {
        out.push('</' + listOpen + '>');
        listOpen = null;
      }
    };

    for (const rawLine of lines) {
      const heading = rawLine.match(/^\\s{0,3}(#{1,4})\\s+(.*)$/);
      if (heading) {
        closeList();
        out.push('<h4 class="chat-h">' + renderChatInline(heading[2]) + '</h4>');
        continue;
      }
      const ul = rawLine.match(/^\\s*[-*]\\s+(.*)$/);
      if (ul) {
        if (listOpen !== 'ul') {
          closeList();
          out.push('<ul>');
          listOpen = 'ul';
        }
        out.push('<li>' + renderChatInline(ul[1]) + '</li>');
        continue;
      }
      const ol = rawLine.match(/^\\s*(\\d+)\\.\\s+(.*)$/);
      if (ol) {
        if (listOpen !== 'ol') {
          closeList();
          out.push('<ol>');
          listOpen = 'ol';
        }
        out.push('<li>' + renderChatInline(ol[2]) + '</li>');
        continue;
      }
      closeList();
      if (rawLine.trim() === '') {
        out.push('<div class="chat-p"></div>');
      } else {
        out.push('<p class="chat-p">' + renderChatInline(rawLine) + '</p>');
      }
    }
    closeList();
    return out.join('');
  }

  function renderChatMarkdown(text) {
    const escaped = escHtml(text);
    const parts = escaped.split(/\`\`\`/);
    let html = '';
    for (let i = 0; i < parts.length; i++) {
      if (i % 2 === 1) {
        // Fenced code block: drop an optional language tag on the first line.
        const body = parts[i].replace(/^[a-zA-Z0-9_+-]+\\n/, '');
        html += '<pre class="chat-code">' + body + '</pre>';
      } else {
        html += renderChatInlineBlock(parts[i]);
      }
    }
    return html;
  }

  const streamingBubbles = {};
  window.addEventListener('message', function(e) {
    const msg = e.data;
    if (!msg || msg.type !== 'chatChunk') return;
    const container = document.getElementById('chatMessages');
    if (!container) return;
    let entry = streamingBubbles[msg.messageId];
    if (!entry || !entry.body.isConnected) {
      delete streamingBubbles[msg.messageId];
      const wrap = document.createElement('div');
      wrap.className = 'chat-msg assistant streaming';
      wrap.innerHTML = '<div class="chat-msg-label">AI</div><div class="chat-msg-body"></div>';
      container.appendChild(wrap);
      entry = { body: wrap.querySelector('.chat-msg-body'), raw: '' };
      streamingBubbles[msg.messageId] = entry;
    }
    // The extension sends the full accumulated text on every chunk, so the
    // bubble stays correct even if the page was rebuilt mid-stream.
    entry.raw = String(msg.content || '');
    entry.body.innerHTML = renderChatMarkdown(entry.raw);
    container.scrollTop = container.scrollHeight;
  });

  document.addEventListener('keydown', function(e) {
    const target = e.target;
    // Skip while IME composition is active (e.g. confirming English text
    // typed via a Chinese input method); otherwise Enter would send the
    // message before the composition is committed.
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229 && target && target.id === 'chatInput') {
      e.preventDefault();
      window.chatSend();
    }
  });

  const chatMessagesEl = document.getElementById('chatMessages');
  if (chatMessagesEl) chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
})();
</script>
</body>
</html>`;
  }
}
