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
exports.TerminalWatcher = void 0;
const vscode = __importStar(require("vscode"));
const pythonTraceback_1 = require("./parser/pythonTraceback");
const errorLinkProvider_1 = require("./ui/errorLinkProvider");
class TerminalWatcher {
    constructor(onErrorDetected) {
        this.disposables = [];
        this.lastErrorKey = '';
        this.lastErrorTime = 0;
        this.lastTraceback = '';
        this.DEBOUNCE_MS = 3000;
        this.MAX_BUFFER_SIZE = 100 * 1024;
        this.lineBuffers = new Map();
        this.onErrorDetected = onErrorDetected;
    }
    activate() {
        console.log('TerminalWatcher: activate()');
        // ── 触发 1: onDidEndTerminalShellExecution (shell integration) ──
        this.disposables.push(vscode.window.onDidEndTerminalShellExecution(async (event) => {
            const exitCode = event.exitCode;
            if (exitCode === undefined)
                return;
            const execution = event.execution;
            let buffer = '';
            try {
                for await (const data of execution.read()) {
                    buffer += data;
                    if (buffer.length > this.MAX_BUFFER_SIZE) {
                        buffer = buffer.slice(-this.MAX_BUFFER_SIZE);
                    }
                }
            }
            catch {
                return;
            }
            if (!buffer)
                return;
            if (exitCode !== 0) {
                this.checkForError(buffer, exitCode);
            }
            else {
                this.checkForSupplementaryError(buffer);
            }
        }));
        // ── 触发 2: TerminalLinkProvider ──
        const linkProvider = new errorLinkProvider_1.ErrorLinkProvider_((line, terminal) => {
            const termId = terminal.name;
            let buf = this.lineBuffers.get(termId) || '';
            buf += line + '\n';
            if (buf.length > this.MAX_BUFFER_SIZE)
                buf = buf.slice(-this.MAX_BUFFER_SIZE);
            this.lineBuffers.set(termId, buf);
            setTimeout(() => {
                const fullBuf = this.lineBuffers.get(termId) || '';
                this.checkForStreamData(fullBuf);
            }, 500);
        });
        this.disposables.push(vscode.window.registerTerminalLinkProvider(linkProvider));
        console.log('TerminalWatcher: linkProvider registered');
        // ── 触发 3: onDidWriteTerminalData (直接尝试，不用 typeof 检查) ──
        try {
            const win = vscode.window;
            if (typeof win.onDidWriteTerminalData === 'function') {
                console.log('TerminalWatcher: onDidWriteTerminalData IS available');
                this.disposables.push(win.onDidWriteTerminalData((event) => {
                    const data = event.data;
                    console.log('TerminalWatcher: onDidWriteTerminalData got data:', data.slice(0, 100));
                    const terminalId = event.terminal?.name || 'unknown';
                    let buf = this.lineBuffers.get(terminalId) || '';
                    buf += data;
                    if (buf.length > this.MAX_BUFFER_SIZE)
                        buf = buf.slice(-this.MAX_BUFFER_SIZE);
                    this.lineBuffers.set(terminalId, buf);
                    if (this.hasErrorKeywords(data)) {
                        setTimeout(() => {
                            this.checkForStreamData(buf);
                        }, 300);
                    }
                }));
            }
            else {
                console.log('TerminalWatcher: onDidWriteTerminalData NOT available');
            }
        }
        catch (e) {
            console.log('TerminalWatcher: onDidWriteTerminalData error:', e.message);
        }
        // ── 触发 4: onDidStartTerminalShellExecution ──
        this.disposables.push(vscode.window.onDidStartTerminalShellExecution(async (event) => {
            // 新命令开始时清空该终端的缓冲区，避免旧错误干扰
            const termId = event.terminal.name;
            this.lineBuffers.set(termId, '');
            console.log('TerminalWatcher: cleared buffer for', termId);
            const execution = event.execution;
            let buffer = '';
            try {
                for await (const data of execution.read()) {
                    buffer += data;
                    if (buffer.length > this.MAX_BUFFER_SIZE)
                        buffer = buffer.slice(-this.MAX_BUFFER_SIZE);
                    if (this.hasErrorKeywords(data)) {
                        setTimeout(() => this.checkForStreamData(buffer), 200);
                    }
                }
            }
            catch { /* ignore */ }
        }));
    }
    deactivate() {
        this.disposables.forEach(d => d.dispose());
        this.disposables = [];
    }
    hasErrorKeywords(data) {
        const kw = [
            'Traceback', 'Error:', 'Exception:',
            'SyntaxError', 'ModuleNotFoundError', 'ZeroDivisionError',
            'TypeError', 'ValueError', 'NameError', 'KeyError',
        ];
        return kw.some(k => data.includes(k));
    }
    checkForError(buffer, exitCode) {
        this.processBuffer(buffer, exitCode);
    }
    checkForSupplementaryError(buffer) {
        if (!buffer.includes('Traceback'))
            return;
        this.processBuffer(buffer);
    }
    checkForStreamData(buffer) {
        if (!buffer)
            return;
        this.processBuffer(buffer);
    }
    processBuffer(buffer, exitCode) {
        const traceback = pythonTraceback_1.PythonTracebackParser.extractErrorBlock(buffer);
        const workspaceFolders = (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath);
        const parseResult = traceback ? pythonTraceback_1.PythonTracebackParser.parse(traceback, workspaceFolders) : null;
        if (!parseResult)
            return;
        const errorKey = parseResult.errorType + '::' + parseResult.errorMessage.slice(0, 100);
        const now = Date.now();
        if (errorKey === this.lastErrorKey && now - this.lastErrorTime < this.DEBOUNCE_MS)
            return;
        const result = {
            errorType: parseResult.errorType,
            errorMessage: parseResult.errorMessage,
            filePath: parseResult.filePath,
            lineNumber: parseResult.lineNumber,
            stackFrames: parseResult.stackFrames,
            fullTraceback: parseResult.fullTraceback,
            chain: parseResult.chain,
            hasExitCode: exitCode !== undefined ? exitCode !== 0 : true,
            firstErrorLine: pythonTraceback_1.PythonTracebackParser.extractFirstErrorLine(buffer),
            timestamp: Date.now(),
        };
        this.lastErrorKey = errorKey;
        this.lastErrorTime = now;
        this.lastTraceback = traceback || '';
        console.log('TerminalWatcher: ERROR DETECTED:', result.errorType);
        this.onErrorDetected(result);
    }
    getLastTraceback() {
        return this.lastTraceback;
    }
}
exports.TerminalWatcher = TerminalWatcher;
//# sourceMappingURL=terminalWatcher.js.map