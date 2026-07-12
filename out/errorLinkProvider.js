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
exports.ErrorLinkProvider = void 0;
const vscode = __importStar(require("vscode"));
const errorParser_1 = require("./errorParser");
class ErrorTerminalLink extends vscode.TerminalLink {
    constructor(startIndex, length, tooltip, filePath, lineNum) {
        super(startIndex, length, tooltip);
        this.filePath = filePath;
        this.lineNum = lineNum;
    }
}
class ErrorLinkProvider {
    constructor() {
        this.errors = new Map();
        this.hoverCallbacks = [];
    }
    onHoverDetected(callback) {
        this.hoverCallbacks.push(callback);
    }
    registerError(result) {
        const key = `${result.filePath}:${result.lineNumber}`;
        this.errors.set(key, result);
        if (this.errors.size > 50) {
            const firstKey = this.errors.keys().next().value;
            if (firstKey)
                this.errors.delete(firstKey);
        }
    }
    provideTerminalLinks(context, _token) {
        const links = [];
        const line = context.line;
        const fileLinePattern = /File\s+"([^"]+)",\s+line\s+(\d+)/g;
        let match;
        while ((match = fileLinePattern.exec(line)) !== null) {
            const filePath = match[1];
            const lineNum = parseInt(match[2]);
            let tooltip = `行 ${lineNum} | 点击跳转到代码位置`;
            for (const [, err] of this.errors) {
                if (err.filePath.includes(filePath) || filePath.includes(err.filePath)) {
                    if (err.lineNumber === lineNum) {
                        tooltip = `⚠️ ${err.errorType}: ${err.errorMessage.slice(0, 60)} | 查看分析`;
                        this.hoverCallbacks.forEach(cb => cb(err));
                        break;
                    }
                }
            }
            links.push(new ErrorTerminalLink(match.index, match[0].length, tooltip, filePath, lineNum));
        }
        return links;
    }
    async handleTerminalLink(link) {
        const workspaceFolders = (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath);
        const resolvedPath = errorParser_1.ErrorParser['resolvePath'](link.filePath, workspaceFolders);
        try {
            const doc = await vscode.workspace.openTextDocument(resolvedPath);
            const editor = await vscode.window.showTextDocument(doc);
            const lineIdx = Math.max(0, link.lineNum - 1);
            const range = doc.lineAt(lineIdx).range;
            editor.selection = new vscode.Selection(range.start, range.end);
            editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
        }
        catch (e) {
            const basename = link.filePath.split('/').pop() || link.filePath;
            for (const folder of workspaceFolders) {
                try {
                    const found = await vscode.workspace.findFiles(`**/${basename}`, '**/node_modules/**', 1);
                    if (found.length > 0) {
                        const doc = await vscode.workspace.openTextDocument(found[0]);
                        const editor = await vscode.window.showTextDocument(doc);
                        const lineIdx = Math.max(0, link.lineNum - 1);
                        const range = doc.lineAt(lineIdx).range;
                        editor.selection = new vscode.Selection(range.start, range.end);
                        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
                        return;
                    }
                }
                catch { /* continue */ }
            }
            vscode.window.showWarningMessage(`ErrAnalyst: 无法定位文件 ${link.filePath}`);
        }
    }
}
exports.ErrorLinkProvider = ErrorLinkProvider;
//# sourceMappingURL=errorLinkProvider.js.map