import * as vscode from 'vscode';
import type { FixViewSnapshot } from '../fix/session';
import type { FilePreview, PreviewBlock } from '../fix/preview';
import { highlightLines, languageForFile } from '../fix/syntax';

export interface FixPreviewPanelHandlers {
  onHunkAction: (action: 'accept' | 'reject', hunkId: string) => void;
  onFinish: () => void;
}

type PanelMode = 'loading' | 'error' | 'session';

/**
 * Dedicated editor tab showing the whole fix session as virtual file content:
 * unchanged lines stay in place, changed regions are marked red/green, every
 * hunk can be accepted/rejected inline, and "结束修复" applies everything.
 */
export class FixPreviewPanel {
  private panel: vscode.WebviewPanel | null = null;
  private disposables: vscode.Disposable[] = [];
  private readonly lifecycle: vscode.Disposable[];
  private mode: PanelMode = 'loading';
  private error = '';
  private snapshot: FixViewSnapshot | null = null;
  private selectedFile = '';
  /** 定位目标：每次重渲染后自动滚动到该修改处，直到用户手动滚动或切换文件。 */
  private focusHunkId: string | null = null;
  /** 生成中标记：下一次成功展示会话时自动定位到第一处修改处。 */
  private pendingAutoFocus = false;
  /** Set when the user closes the tab manually; suppress auto-reopen. */
  private userClosed = false;
  private closingByUs = false;

  constructor(private readonly handlers: FixPreviewPanelHandlers) {
    // Re-render when the active color theme changes so the syntax palette
    // keeps matching the editor.
    this.lifecycle = [
      vscode.window.onDidChangeActiveColorTheme(() => {
        if (this.panel) this.render();
      }),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('workbench.colorTheme') && this.panel) this.render();
      }),
    ];
  }

  showGenerating(): void {
    this.mode = 'loading';
    this.error = '';
    this.snapshot = null;
    this.userClosed = false;
    this.focusHunkId = null;
    this.pendingAutoFocus = true;
    this.render();
  }

  showError(message: string): void {
    this.mode = 'error';
    this.error = message;
    this.snapshot = null;
    this.userClosed = false;
    this.focusHunkId = null;
    this.pendingAutoFocus = false;
    this.render();
  }

  showSession(snapshot: FixViewSnapshot, selectFile?: string, force = false, focusHunkId?: string): void {
    if (!this.panel && this.userClosed && !force) return;
    this.userClosed = false;
    this.mode = 'session';
    this.snapshot = snapshot;
    if (selectFile && snapshot.files.some(f => f.file === selectFile)) {
      this.selectedFile = selectFile;
    }
    if (!this.selectedFile || !snapshot.files.some(f => f.file === this.selectedFile)) {
      this.selectedFile = snapshot.files[0]?.file || '';
    }
    if (focusHunkId) {
      this.focusHunkId = focusHunkId;
      this.pendingAutoFocus = false;
    } else if (this.pendingAutoFocus) {
      this.pendingAutoFocus = false;
      const first = this.firstFocusableHunkId(snapshot);
      this.focusHunkId = first;
      const firstHunk = first ? snapshot.hunks.find(h => h.id === first) : undefined;
      if (firstHunk && snapshot.files.some(f => f.file === firstHunk.file)) {
        this.selectedFile = firstHunk.file;
      }
    }
    this.render();
  }

  private firstFocusableHunkId(snapshot: FixViewSnapshot): string | null {
    for (const h of snapshot.hunks) {
      if (h.status !== 'stale') return h.id;
    }
    return null;
  }

  close(): void {
    this.closingByUs = true;
    if (this.panel) this.panel.dispose();
    this.closingByUs = false;
    this.disposables.forEach(d => d.dispose());
    this.disposables = [];
    this.panel = null;
    this.mode = 'loading';
    this.error = '';
    this.snapshot = null;
    this.selectedFile = '';
    this.focusHunkId = null;
    this.pendingAutoFocus = false;
    this.userClosed = false;
  }

  dispose(): void {
    this.lifecycle.forEach(d => d.dispose());
    this.close();
  }

  private render(): void {
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        'errAnalyst.fixPreview',
        '修改预览',
        vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true }
      );
      this.panel.onDidDispose(() => {
        if (!this.closingByUs) this.userClosed = true;
        this.disposables.forEach(d => d.dispose());
        this.disposables = [];
        this.panel = null;
        // The session stays active; the card's 预览 button can force reopen.
        this.snapshot = null;
        this.selectedFile = '';
        this.focusHunkId = null;
        this.pendingAutoFocus = false;
      });
      this.disposables.push(
        this.panel.webview.onDidReceiveMessage(msg => this.handleMessage(msg))
      );
    }
    this.panel.title = this.mode === 'session' && this.snapshot
      ? `修改预览 - 共 ${this.snapshot.total} 处`
      : '修改预览';
    this.panel.webview.html = this.buildHtml();
  }

  private handleMessage(msg: any): void {
    switch (msg.type) {
      case 'hunkAction':
        if (typeof msg.hunkId === 'string' && (msg.action === 'accept' || msg.action === 'reject')) {
          this.handlers.onHunkAction(msg.action, msg.hunkId);
        }
        break;
      case 'finishFix':
        this.handlers.onFinish();
        break;
      case 'switchFile':
        if (typeof msg.file === 'string') {
          this.selectedFile = msg.file;
          this.focusHunkId = null;
          this.render();
        }
        break;
      case 'clearFocus':
        this.focusHunkId = null;
        break;
      case 'openFile':
        if (typeof msg.file === 'string' && typeof msg.line === 'number') {
          void this.openFile(msg.file, msg.line);
        }
        break;
    }
  }

  private async openFile(file: string, line: number): Promise<void> {
    try {
      const doc = await vscode.workspace.openTextDocument(file);
      const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
      const lineIdx = Math.max(0, Math.min(line - 1, doc.lineCount - 1));
      const range = doc.lineAt(lineIdx).range;
      editor.selection = new vscode.Selection(range.start, range.end);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
    } catch { /* file may be gone */ }
  }

  private buildHtml(): string {
    let body = '';
    if (this.mode === 'loading') {
      body = '<div class="center"><div class="spinner"></div><p>正在生成修复补丁...</p></div>';
    } else if (this.mode === 'error') {
      body = '<div class="center error">' + this.esc(this.error || '修复补丁生成失败') + '</div>';
    } else if (this.snapshot) {
      body = this.buildSessionHtml(this.snapshot);
    }

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
:root{--bg:var(--vscode-editor-background,#1e1e1e);--text:var(--vscode-editor-foreground,#d4d4d4);--text-muted:var(--vscode-descriptionForeground,#808080);--border:var(--vscode-panel-border,#3c3c3c);--accent:var(--vscode-focusBorder,#007acc);--success:#40c060;--error:#f48771;}
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:var(--bg);color:var(--text);font-size:12px;line-height:1.5;height:100vh;display:flex;flex-direction:column;}
.toolbar{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 12px;border-bottom:1px solid var(--border);}
.summary{color:var(--text-muted);font-size:12px;}
.finish-btn{background:var(--vscode-button-background,#0e639c);border:none;color:var(--vscode-button-foreground,#fff);border-radius:3px;padding:5px 14px;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap;}
.finish-btn:hover{background:var(--vscode-button-hoverBackground,#1177bb);}
.file-tabs{display:flex;gap:4px;padding:6px 12px 0;border-bottom:1px solid var(--border);overflow-x:auto;}
.file-tab{background:transparent;border:1px solid transparent;border-bottom:none;border-radius:3px 3px 0 0;color:var(--text-muted);padding:4px 10px;font-size:11px;cursor:pointer;white-space:nowrap;font-family:Consolas,Monaco,monospace;}
.file-tab:hover{color:var(--text);}
.file-tab.active{color:var(--text);border-color:var(--border);background:rgba(128,128,128,.08);}
.file-tab .count{color:#b5cea8;margin-left:4px;}
.file-tab .warn{color:#d7ba7d;}
.content{flex:1;overflow:auto;padding:10px 12px 24px;}
.stale-banner{background:rgba(196,43,28,.15);border:1px solid rgba(196,43,28,.45);color:var(--error);border-radius:4px;padding:8px 10px;font-size:12px;margin-bottom:10px;}
.empty{color:var(--text-muted);padding:30px;text-align:center;}
.center{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;color:var(--text-muted);}
.center.error{color:var(--error);}
.spinner{width:26px;height:26px;border:3px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin 1s linear infinite;}
@keyframes spin{to{transform:rotate(360deg);}}
.p-block{margin:0 0 2px;}
.p-block-head{display:flex;align-items:center;gap:8px;padding:2px 0;font-size:11px;color:var(--text-muted);}
.p-reason{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.p-status{flex:none;padding:0 6px;border-radius:3px;font-size:10px;}
.p-status.pending{color:#d7ba7d;border:1px solid rgba(215,186,125,.5);}
.p-status.accepted{color:#9cdc9c;border:1px solid rgba(76,175,80,.5);}
.p-status.rejected{color:var(--text-muted);border:1px solid var(--border);}
.p-actions{flex:none;display:flex;gap:4px;}
.p-btn{background:transparent;border:1px solid var(--border);color:var(--text);border-radius:3px;padding:1px 8px;font-size:10px;cursor:pointer;white-space:nowrap;}
.p-btn:hover{border-color:var(--accent);}
.p-btn.accept:hover{border-color:var(--success);color:#9cdc9c;}
.p-btn.reject:hover{border-color:#f44747;color:#f48771;}
.p-open{flex:none;color:#569cd6;cursor:pointer;text-decoration:underline;}
.p-open:hover{color:#75b8f0;}
.p-line{display:flex;gap:8px;padding:0 8px;font-family:Consolas,Monaco,monospace;font-size:12px;line-height:1.6;white-space:pre;}
.p-no{flex:none;width:44px;text-align:right;color:var(--text-muted);user-select:none;}
.p-mark{flex:none;width:14px;text-align:center;user-select:none;}
.p-text{min-width:0;white-space:pre;}
.p-line.add{background:rgba(46,160,67,.22);color:#9cdc9c;}
.p-line.del{background:rgba(196,43,28,.22);color:#f48771;text-decoration:line-through;}
.p-line.ctx .p-mark{color:transparent;}
/* Syntax highlighting — palette follows the active VS Code theme. The
   panel writes data-theme="dark2026|light2026|darkplus|lightplus" on the
   body based on the configured workbench theme; the 2026 palettes are this
   build's defaults and also the fallback when no theme is configured. */
:root{--tok-kw:#ff7b72;--tok-ctrl:#C586C0;--tok-string:#a5d6ff;--tok-comment:#8b949e;--tok-number:#b5cea8;--tok-fn:#d2a8ff;--tok-builtin:#DCDCAA;--tok-type:#4EC9B0;--tok-var:#79c0ff;--tok-const:#569cd6;}
body[data-theme="light2026"]{--tok-kw:#cf222e;--tok-ctrl:#AF00DB;--tok-string:#0a3069;--tok-comment:#6e7781;--tok-number:#098658;--tok-fn:#8250df;--tok-builtin:#795E26;--tok-type:#267f99;--tok-var:#0550ae;--tok-const:#0000ff;}
body[data-theme="darkplus"]{--tok-kw:#569CD6;--tok-ctrl:#C586C0;--tok-string:#CE9178;--tok-comment:#6A9955;--tok-number:#B5CEA8;--tok-fn:#DCDCAA;--tok-builtin:#DCDCAA;--tok-type:#4EC9B0;--tok-var:#9CDCFE;--tok-const:#569CD6;}
body[data-theme="lightplus"]{--tok-kw:#0000FF;--tok-ctrl:#AF00DB;--tok-string:#A31515;--tok-comment:#008000;--tok-number:#098658;--tok-fn:#795E26;--tok-builtin:#795E26;--tok-type:#267F99;--tok-var:#001080;--tok-const:#0000FF;}
.p-text .tok-kw{color:var(--tok-kw);}
.p-text .tok-ctrl{color:var(--tok-ctrl);}
.p-text .tok-string{color:var(--tok-string);}
.p-text .tok-comment{color:var(--tok-comment);}
.p-text .tok-number{color:var(--tok-number);}
.p-text .tok-fn{color:var(--tok-fn);}
.p-text .tok-builtin{color:var(--tok-builtin);}
.p-text .tok-type{color:var(--tok-type);}
.p-text .tok-var{color:var(--tok-var);}
.p-text .tok-const{color:var(--tok-const);}
</style>
</head>
<body data-theme="${this.currentThemePalette()}" data-focus="${this.escAttr(this.focusHunkId || '')}">
${body}
<script>
const vscode = acquireVsCodeApi();
const focusId = document.body.getAttribute('data-focus');
let suppressScrollMsg = false;
function scrollToFocus() {
  if (!focusId) return;
  // hunk id 由扩展生成（hunk-时间戳-序号），可直接用作元素 id 的后缀。
  const block = document.getElementById('ph-' + focusId);
  if (!block) {
    // 定位目标已不存在（例如该修改处随后失效），静默清除，不再尝试。
    vscode.postMessage({ type: 'clearFocus' });
    return;
  }
  suppressScrollMsg = true;
  const scroller = document.querySelector('.content');
  if (scroller && scroller.scrollHeight > scroller.clientHeight) {
    // 直接计算目标位置：把改动块顶部滚动到内容区顶部（留 4px 边距）。
    const cRect = scroller.getBoundingClientRect();
    const bRect = block.getBoundingClientRect();
    scroller.scrollTop = scroller.scrollTop + (bRect.top - cRect.top) - 4;
  } else {
    block.scrollIntoView({ block: 'start' });
  }
  setTimeout(() => { suppressScrollMsg = false; }, 300);
}
document.addEventListener('scroll', function(e) {
  if (suppressScrollMsg) return;
  const t = e.target;
  if (t && t.classList && t.classList.contains('content')) {
    // 用户手动滚动离开定位目标后清除定位。
    vscode.postMessage({ type: 'clearFocus' });
  }
}, true);
scrollToFocus();
// 首次打开面板时布局可能尚未完成，滚动会静默空转；重复几次直到布局稳定。
requestAnimationFrame(scrollToFocus);
window.addEventListener('load', scrollToFocus);
setTimeout(scrollToFocus, 100);
setTimeout(scrollToFocus, 300);
document.addEventListener('click', function(e) {
  const t = e.target;
  if (!t || !t.classList) return;
  if (t.classList.contains('p-btn-accept')) {
    vscode.postMessage({ type: 'hunkAction', action: 'accept', hunkId: t.getAttribute('data-id') });
  } else if (t.classList.contains('p-btn-reject')) {
    vscode.postMessage({ type: 'hunkAction', action: 'reject', hunkId: t.getAttribute('data-id') });
  } else if (t.id === 'finishBtn') {
    vscode.postMessage({ type: 'finishFix' });
  } else if (t.classList.contains('file-tab')) {
    vscode.postMessage({ type: 'switchFile', file: t.getAttribute('data-file') });
  } else if (t.classList.contains('p-open')) {
    vscode.postMessage({
      type: 'openFile',
      file: t.getAttribute('data-file'),
      line: parseInt(t.getAttribute('data-line'), 10)
    });
  }
});
</script>
</body>
</html>`;
  }

  private buildSessionHtml(snapshot: FixViewSnapshot): string {
    const file = snapshot.files.find(f => f.file === this.selectedFile);
    const tabs = snapshot.files.map(f => {
      const name = f.file.split(/[\\/]/).pop() || f.file;
      const count = f.addedCount + f.removedCount;
      const label = (f.stale ? '<span class="warn">⚠</span>' : '')
        + this.esc(name)
        + (count > 0 ? `<span class="count">${count}</span>` : '');
      return `<button class="file-tab${f.file === this.selectedFile ? ' active' : ''}" data-file="${this.escAttr(f.file)}">${label}</button>`;
    }).join('');

    let content = '';
    if (!file) {
      content = '<div class="empty">没有可显示的修改文件</div>';
    } else if (file.stale) {
      content = '<div class="stale-banner">该文件已被外部修改，与生成补丁时的内容不一致；结束修复时将跳过此文件。</div>';
    } else if (file.blocks.length === 0) {
      content = '<div class="empty">该文件没有待展示的修改</div>';
    } else {
      content = this.buildBlocksHtml(snapshot, file);
    }

    return '<div class="toolbar">'
      + `<div class="summary">共 ${snapshot.total} 处 · 待确认 ${snapshot.pending} · 已接受 ${snapshot.accepted} · 已拒绝 ${snapshot.rejected}${snapshot.stale ? ` · 失效 ${snapshot.stale}` : ''}</div>`
      + '<button class="finish-btn" id="finishBtn">结束修复</button>'
      + '</div>'
      + `<div class="file-tabs">${tabs}</div>`
      + `<div class="content">${content}</div>`;
  }

  private buildBlocksHtml(snapshot: FixViewSnapshot, file: FilePreview): string {
    const byId = new Map(snapshot.hunks.map(h => [h.id, h]));
    const lang = languageForFile(file.file);
    const lineHtmls: string[] | null = lang
      ? highlightLines(file.blocks.map(b => b.lines.map(l => l.text).join('\n')).join('\n'), lang)
      : null;
    let html = '';
    for (const block of file.blocks) {
      if (block.hunkId && block.status) {
        const hunk = byId.get(block.hunkId);
        const statusText: Record<string, string> = { pending: '待确认', accepted: '已接受', rejected: '已拒绝', stale: '已失效' };
        const actions = block.status === 'pending'
          ? `<span class="p-actions">`
            + `<button class="p-btn p-btn-accept" data-id="${block.hunkId}">接受</button>`
            + `<button class="p-btn p-btn-reject" data-id="${block.hunkId}">拒绝</button>`
            + `</span>`
          : '';
        const openLink = hunk && hunk.line > 0
          ? `<span class="p-open" data-file="${this.escAttr(hunk.file)}" data-line="${hunk.line}">打开</span>`
          : '';
        html += `<div class="p-block"${block.hunkId ? ` id="ph-${this.escAttr(block.hunkId)}" data-hunk="${this.escAttr(block.hunkId)}"` : ''}>`
          + '<div class="p-block-head">'
          + `<span class="p-reason" title="${this.escAttr(block.reason || '')}">${this.esc(block.reason || '')}</span>`
          + `<span class="p-status ${block.status}">${statusText[block.status] || block.status}</span>`
          + actions
          + openLink
          + '</div>'
          + this.buildLinesHtml(block, lineHtmls)
          + '</div>';
      } else {
        html += this.buildLinesHtml(block, lineHtmls);
      }
    }
    return html;
  }

  /** Palette id matching the theme the user's editor actually shows. */
  private currentThemePalette(): string {
    const configured = vscode.workspace.getConfiguration('workbench').get<string>('colorTheme');
    if (configured === 'Dark+' || configured === 'Dark Modern'
      || configured === 'Default Dark Modern' || configured === 'Default Dark+') {
      return 'darkplus';
    }
    if (configured === 'Light+' || configured === 'Light Modern'
      || configured === 'Default Light Modern' || configured === 'Default Light+') {
      return 'lightplus';
    }
    const kind = vscode.window.activeColorTheme.kind;
    return kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight
      ? 'light2026'
      : 'dark2026';
  }

  private buildLinesHtml(block: PreviewBlock, lineHtmls: string[] | null): string {
    let html = '';
    for (const line of block.lines) {
      const kind = line.kind === 'removed' ? 'del' : line.kind === 'added' ? 'add' : 'ctx';
      const mark = line.kind === 'removed' ? '-' : line.kind === 'added' ? '+' : ' ';
      const textHtml = lineHtmls
        ? (lineHtmls[line.lineNo - 1] ?? this.esc(line.text))
        : this.esc(line.text);
      html += `<div class="p-line ${kind}"><span class="p-no">${line.lineNo}</span><span class="p-mark">${mark}</span><span class="p-text">${textHtml}</span></div>`;
    }
    return html;
  }

  private esc(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }

  private escAttr(str: string): string {
    return this.esc(str).replace(/\\/g, '\\\\').replace(/`/g, '&#096;');
  }
}
