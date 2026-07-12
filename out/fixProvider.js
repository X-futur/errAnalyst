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
exports.FixProvider = void 0;
const vscode = __importStar(require("vscode"));
class FixProvider {
    constructor() {
        this.currentError = null;
        this.currentFixCode = '';
    }
    prepareFix(error, fixCode) {
        this.currentError = error;
        this.currentFixCode = fixCode;
    }
    async resolveFilePath(filePath) {
        try {
            const uri = vscode.Uri.file(filePath);
            await vscode.workspace.fs.stat(uri);
            return uri;
        }
        catch { }
        const basename = filePath.split(/[\\/]/).pop() || filePath;
        const folders = vscode.workspace.workspaceFolders || [];
        for (const folder of folders) {
            const fullPath = vscode.Uri.joinPath(folder.uri, filePath);
            try {
                await vscode.workspace.fs.stat(fullPath);
                return fullPath;
            }
            catch { }
        }
        for (const folder of folders) {
            try {
                const pattern = '**/' + basename;
                const results = await vscode.workspace.findFiles(pattern, '**/node_modules/**', 1);
                if (results.length > 0)
                    return results[0];
            }
            catch { }
        }
        return null;
    }
    async showFixDiff() {
        if (!this.currentError) {
            vscode.window.showWarningMessage('ErrAnalyst: No error data');
            return;
        }
        if (!this.currentFixCode) {
            vscode.window.showInformationMessage('ErrAnalyst: AI did not provide a fix code (only fix suggestion)');
            return;
        }
        const { filePath, lineNumber } = this.currentError;
        if (!filePath) {
            vscode.window.showErrorMessage('ErrAnalyst: No file path for fix');
            return;
        }
        const uri = await this.resolveFilePath(filePath);
        if (!uri) {
            vscode.window.showErrorMessage('ErrAnalyst: Cannot find file: ' + filePath);
            return;
        }
        try {
            const doc = await vscode.workspace.openTextDocument(uri);
            const editor = await vscode.window.showTextDocument(doc);
            const lineIdx = Math.max(0, lineNumber - 1);
            const originalLine = doc.lineAt(lineIdx);
            const indent = originalLine.text.match(/^\s*/)?.[0] || '';
            const fixLines = this.currentFixCode.split('\n');
            const detailStr = filePath + ':' + lineNumber + '\n\n' + originalLine.text + '\n\u2192\n' + fixLines.map(l => indent + l).join('\n');
            const choice = await vscode.window.showInformationMessage('ErrAnalyst: Apply fix?', { modal: false, detail: detailStr }, 'Apply', 'Cancel');
            if (choice === 'Apply') {
                await editor.edit(editBuilder => {
                    const range = new vscode.Range(lineIdx, 0, lineIdx, originalLine.text.length);
                    editBuilder.replace(range, fixLines.map(l => indent + l).join('\n'));
                });
                vscode.window.showInformationMessage('ErrAnalyst: Fix applied');
            }
        }
        catch (e) {
            vscode.window.showErrorMessage('ErrAnalyst: Failed to apply fix: ' + (e instanceof Error ? e.message : String(e)));
        }
    }
    async applyFixDirectly() {
        await this.showFixDiff();
    }
}
exports.FixProvider = FixProvider;
//# sourceMappingURL=fixProvider.js.map