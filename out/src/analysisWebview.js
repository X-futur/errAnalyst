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
exports.AnalysisWebview = void 0;
const vscode = __importStar(require("vscode"));
class AnalysisWebview {
    constructor() {
        this.panel = null;
        this.currentError = null;
        this.currentAiData = null;
        this.currentActions = [];
        this.currentContext = null;
        this.currentTraceback = "";
        this.highlightDecoration = null;
    }
    show(error, aiData) {
        this.currentError = error;
        if (aiData)
            this.currentAiData = aiData;
        if (!this.panel) {
            this.panel = vscode.window.createWebviewPanel('errAnalyst.analysis', 'ErrAnalyst - 错误分析', vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true });
            this.panel.onDidDispose(() => { this.panel = null; });
            this.panel.webview.onDidReceiveMessage(msg => this.handleWebviewMessage(msg));
        }
        this.panel.reveal(vscode.ViewColumn.Beside, true);
        this.updateContent();
    }
    close() {
        if (this.panel) {
            this.panel.dispose();
            this.panel = null;
        }
        this.clearHighlight();
    }
    focus() {
        if (this.panel)
            this.panel.reveal(vscode.ViewColumn.Beside, true);
    }
    showActions(actions) {
        this.currentActions = actions;
        this.updateContent();
    }
    showContext(fullTraceback, context) {
        this.currentTraceback = fullTraceback;
        this.currentContext = context || null;
        this.updateContent();
    }
    handleWebviewMessage(msg) {
        switch (msg.type) {
            case 'highlightEditor':
                this.highlightInEditor(msg.term);
                break;
            case 'applyFix':
                vscode.commands.executeCommand('errAnalyst.showFixDiff').then(undefined, err => {
                    console.error('ErrAnalyst: Fix command failed:', err);
                });
                break;
        }
    }
    updateContent() {
        if (!this.panel || !this.currentError)
            return;
        const error = this.currentError;
        const aiData = this.currentAiData;
        // Build all sections
        const categoryHtml = this.buildCategoryHtml();
        const terminalHtml = this.buildTerminalHtml();
        const codeContextHtml = this.buildCodeContextHtml();
        const stackHtml = this.buildStackHtml();
        const analysisHtml = this.buildAnalysisHtml();
        const actionsHtml = this.buildActionsHtml();
        this.panel.webview.html = this.getHtmlTemplate(categoryHtml, terminalHtml, codeContextHtml, stackHtml, analysisHtml, actionsHtml);
    }
    buildCategoryHtml() {
        if (!this.currentError || !this.currentError.category || this.currentError.category === 'UNKNOWN') {
            return '';
        }
        const category = this.currentError.category;
        const actionPlan = this.currentError.actionPlan || '';
        const suggestion = this.currentError.suggestion || '';
        const hasExitCode = this.currentError.hasExitCode;
        const cfg = {
            COMPILATION_ERROR: { label: '🛠️ 编译错误', color: '#d4872e' },
            DEPENDENCY_ERROR: { label: '📦 依赖错误', color: '#3794ff' },
            SYSTEM_ERROR: { label: '⚙️ 系统错误', color: '#f44747' },
            RUNTIME_ERROR: { label: '▶️ 运行时错误', color: '#b180d7' }
        };
        const c = cfg[category];
        if (!c)
            return '';
        let html = `<div class="category-section">
      <div class="category-badge" style="background:${c.color}22;border-left:3px solid ${c.color};color:${c.color}">
        <span>${c.label}</span>
      </div>
      <div class="action-plan-card">
        <span class="action-icon">📋</span>
        <span class="action-text">${this.esc(actionPlan)}</span>
      </div>`;
        html += `<div class="first-error-line">\u25b6 ${this.esc(this.currentError.firstErrorLine || "")}</div>`;
        if (hasExitCode) {
            html += `<div class="exit-code-warning">⚠️ ${this.esc(suggestion)}</div>`;
        }
        html += `</div>`;
        return html;
    }
    buildTerminalHtml() {
        if (!this.currentTraceback)
            return '';
        const tb = this.currentTraceback.slice(0, 2500);
        return `<div class="section-card terminal-section">
      <h4>\u7ec8\u7aef\u8f93\u51fa</h4>
      <pre class="terminal-text">${this.esc(tb)}${this.currentTraceback.length > 2500 ? '\n...' : ''}</pre>
    </div>`;
    }
    buildCodeContextHtml() {
        const ctx = this.currentContext;
        if (!ctx)
            return '';
        let html = '<div class="code-context-section">';
        html += '<h4>\u672c\u9879\u76ee\u4ee3\u7801\u4e0a\u4e0b\u6587</h4>';
        if (ctx.mainFile) {
            html += this.renderFileContext(ctx.mainFile, true);
        }
        for (const f of ctx.relatedFiles) {
            html += this.renderFileContext(f, false);
        }
        for (const f of ctx.configFiles) {
            html += this.renderFileContext(f, false);
        }
        html += '</div>';
        return html;
    }
    renderFileContext(fc, isMain) {
        const label = isMain ? '\ud83d\udcc4 \u4e3b\u8981\u62a5\u9519\u6587\u4ef6' : '\ud83d\udcc4 ' + fc.path.split('/').pop();
        const relPath = fc.path;
        return `<div class="file-context ${isMain ? 'main-file' : ''}">
      <div class="file-header" onclick="toggleFile(this)">
        <span class="file-toggle">\u25b6</span>
        <span class="file-label">${label}</span>
        <span class="file-path">${this.esc(relPath)}</span>
        <span class="file-lines">L${fc.startLine}-${fc.endLine}</span>
      </div>
      <div class="file-content" style="display:none">
        <pre>${this.esc(fc.content)}</pre>
      </div>
    </div>`;
    }
    buildStackHtml() {
        if (!this.currentError || this.currentError.stackFrames.length === 0)
            return '';
        let html = '';
        for (const frame of this.currentError.stackFrames) {
            const codeLine = frame.codeLine ? '<div class="code-line">' + this.esc(frame.codeLine) + '</div>' : '';
            html += '<div class="stack-frame"><span class="frame-file">' + this.esc(frame.file) + '</span>:<span class="frame-line">' + frame.line + '</span>, in <span class="frame-func">' + this.esc(frame.function) + '</span>' + codeLine + '</div>';
        }
        return '<div class="stack-section"><h4>\u8c03\u7528\u6808</h4>' + html + '</div>';
    }
    buildAnalysisHtml() {
        const error = this.currentError;
        if (!error)
            return '';
        const aiData = this.currentAiData;
        if (aiData) {
            let kwPills = '';
            for (const kw of aiData.keywords) {
                kwPills += '<span class="keyword-badge" data-en="' + this.esc(kw.en) + '" data-cn="' + this.esc(kw.cn) + '"><span class="kw-en">' + this.esc(kw.en) + '</span> \u2194 <span class="kw-cn">' + this.esc(kw.cn) + '</span></span>';
            }
            return '<div class="analysis-content">'
                + '<div class="error-pair">'
                + '<div class="error-original"><h4>\u539f\u59cb\u62a5\u9519</h4><pre class="error-text"><div class="error-type">' + this.esc(error.errorType) + '</div><div class="error-msg">' + this.esc(error.errorMessage) + '</div></pre></div>'
                + '<div class="error-translated"><h4>\u4e2d\u6587\u7ffb\u8bd1</h4><div class="translated-text">' + aiData.translation + '</div></div></div>'
                + (kwPills ? '<div class="keyword-pills">' + kwPills + '</div>' : '')
                + '<div class="section-card"><h4>\u9519\u8bef\u5206\u6790</h4><p>' + this.esc(aiData.analysis) + '</p></div>'
                + '<div class="section-card fix-card"><h4>\u4fee\u590d\u5efa\u8bae</h4><p>' + this.esc(aiData.fixSuggestion) + '</p></div>'
                + '<div class="action-buttons"><button class="btn btn-primary" onclick="applyFix()">\ud83d\udd27 \u5e94\u7528\u4fee\u590d</button></div></div>';
        }
        // Loading state
        return '<div class="analysis-loading"><div class="spinner"></div><p>\u6b63\u5728\u8c03\u7528 AI \u5206\u6790...</p></div>';
    }
    buildActionsHtml() {
        if (this.currentActions.length === 0)
            return '';
        if (this.currentActions.length === 0)
            return '';
        const editActions = this.currentActions.filter(a => a.type === 'edit_file');
        const cmdActions = this.currentActions.filter(a => a.type === 'run_command');
        let html = '<div class="actions-section">';
        if (editActions.length > 0) {
            html += '<h4>\u270f\ufe0f \u4fee\u6539\u6587\u4ef6</h4>';
            for (const a of editActions) {
                const fileCount = a.edits?.length || 0;
                const files = a.edits?.map(e => e.file.split('/').pop()).join(', ') || '';
                html += '<div class="action-card action-edit">'
                    + '<div class="action-title">' + this.esc(a.title) + '</div>'
                    + '<div class="action-desc">' + this.esc(a.description) + '</div>'
                    + '<div class="action-meta">\u2590 ' + fileCount + ' \u6587\u4ef6: ' + this.esc(files) + '</div>'
                    + '</div>';
            }
        }
        if (cmdActions.length > 0) {
            html += '<h4>\u25b6\ufe0f \u6267\u884c\u547d\u4ee4</h4>';
            html += '<div style="margin-bottom:8px;font-size:11px;color:var(--text-muted)">\u70b9\u51fb\u4e0b\u65b9\u201c\u5e94\u7528\u4fee\u590d\u201d\u6309\u94ae\u5728\u7ec8\u7aef\u4e2d\u6267\u884c\u547d\u4ee4</div>';
            for (const a of cmdActions) {
                const cmds = a.commands?.map(c => '<code>' + this.esc(c.cmd) + '</code>').join('<br>') || '';
                html += '<div class="action-card action-cmd">'
                    + '<div class="action-title">' + this.esc(a.title) + '</div>'
                    + '<div class="action-desc">' + this.esc(a.description) + '</div>'
                    + '<div class="action-commands">' + cmds + '</div>'
                    + '</div>';
            }
        }
        html += '<div class="action-buttons" style="margin-top:10px"><button class="btn btn-primary" onclick="applyFix()">\u2692\ufe0f \u5e94\u7528\u4fee\u590d</button></div></div>';
        return html;
    }
    highlightInEditor(term) {
        this.clearHighlight();
        const editor = vscode.window.activeTextEditor;
        if (!editor || !this.currentError)
            return;
        this.highlightDecoration = vscode.window.createTextEditorDecorationType({
            backgroundColor: 'rgba(255, 200, 0, 0.3)',
            border: '1px solid rgba(255, 200, 0, 0.8)',
            borderRadius: '3px',
            fontWeight: 'bold'
        });
        const lineIdx = Math.max(0, this.currentError.lineNumber - 1);
        const text = editor.document.lineAt(lineIdx).text;
        const ranges = [];
        let searchFrom = 0, idx;
        while ((idx = text.toLowerCase().indexOf(term.toLowerCase(), searchFrom)) !== -1) {
            ranges.push(new vscode.Range(lineIdx, idx, lineIdx, idx + term.length));
            searchFrom = idx + term.length;
        }
        if (ranges.length > 0)
            editor.setDecorations(this.highlightDecoration, ranges);
    }
    clearHighlight() {
        if (this.highlightDecoration) {
            this.highlightDecoration.dispose();
            this.highlightDecoration = null;
        }
    }
    esc(str) {
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
    }
    escRegex(str) {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    getHtmlTemplate(categoryHtml, terminalHtml, codeContextHtml, stackHtml, analysisHtml, actionsHtml) {
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
.first-error-line{background:rgba(0,122,204,0.08);border:1px solid rgba(0,122,204,0.25);border-radius:4px;padding:5px 10px;font-size:11px;color:var(--accent);margin-bottom:6px;font-family:Consolas,Monaco,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.terminal-section{margin-bottom:10px;}
.terminal-text{font-family:Consolas,Monaco,monospace;font-size:11px;line-height:1.5;color:#ce9178;max-height:200px;overflow-y:auto;white-space:pre-wrap;word-break:break-word;background:rgba(0,0,0,0.3);padding:8px;border-radius:4px;margin-top:4px;}
.code-context-section{margin-bottom:12px;}
.file-context{background:var(--bg-card);border:1px solid var(--border);border-radius:6px;margin-bottom:6px;overflow:hidden;}
.file-context.main-file{border-left:3px solid var(--accent);}
.file-header{padding:6px 10px;cursor:pointer;display:flex;align-items:center;gap:6px;user-select:none;font-size:12px;}
.file-header:hover{background:rgba(255,255,255,0.03);}
.file-toggle{color:var(--text-muted);font-size:10px;transition:transform .15s;}
.file-toggle.open{transform:rotate(90deg);}
.file-label{font-weight:600;white-space:nowrap;}
.file-path{color:var(--text-muted);font-size:10px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.file-lines{color:var(--text-muted);font-size:10px;white-space:nowrap;}
.file-content pre{font-family:Consolas,Monaco,monospace;font-size:11px;line-height:1.5;padding:8px 10px;background:rgba(0,0,0,0.2);overflow-x:auto;white-space:pre;color:var(--text);}

.actions-section{margin-bottom:12px;}
.action-card{background:var(--bg-card);border:1px solid var(--border);border-radius:6px;padding:8px 10px;margin-bottom:6px;}
.action-edit{border-left:3px solid var(--accent);}
.action-cmd{border-left:3px solid #b180d7;}
.action-title{font-size:13px;font-weight:600;margin-bottom:2px;}
.action-desc{font-size:11px;color:var(--text-muted);margin-bottom:4px;}
.action-meta{font-size:10px;color:var(--text-muted);}
.action-commands code{display:block;background:rgba(0,0,0,0.3);padding:4px 8px;border-radius:3px;font-size:11px;margin-top:4px;color:#ce9178;}
.actions-section h4{font-size:12px;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;color:#999;margin-top:8px;}
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
` + terminalHtml + `
` + codeContextHtml + `
` + stackHtml + `
` + analysisHtml + `
<script>
(function(){var vscode=acquireVsCodeApi();var vsApi=vscode;
function hk(t){document.querySelectorAll('.hl-keyword').forEach(function(e){e.classList.add('active');});}
function uk(){document.querySelectorAll('.hl-keyword').forEach(function(e){e.classList.remove('active');});}
document.addEventListener('mouseover',function(e){var t=e.target;if(t&&t.classList&&t.classList.contains('hl-keyword')){var kw=t.getAttribute('data-en')||t.textContent;hk(kw);vsApi.postMessage({type:'highlightEditor',term:kw});}});
document.addEventListener('mouseout',function(e){var t=e.target;if(t&&t.classList&&t.classList.contains('hl-keyword')){uk();}});
function ab(){document.querySelectorAll('.keyword-badge').forEach(function(b){b.addEventListener('mouseover',function(){var en=this.getAttribute('data-en');hk(en);vsApi.postMessage({type:'highlightEditor',term:en});});b.addEventListener('mouseout',function(){uk();});});}
ab();var ob=new MutationObserver(function(){ab();});ob.observe(document.body,{childList:true,subtree:true});
window.toggleFile=function(el){var content=el.nextElementSibling;var toggle=el.querySelector('.file-toggle');if(content.style.display==='none'||!content.style.display){content.style.display='block';toggle.classList.add('open');}else{content.style.display='none';toggle.classList.remove('open');}};
window.applyFix=function(){vsApi.postMessage({type:'applyFix'});};})();
</script>
</body>
</html>`;
    }
}
exports.AnalysisWebview = AnalysisWebview;
//# sourceMappingURL=analysisWebview.js.map