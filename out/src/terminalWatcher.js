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
/**
 * Strip ANSI escape sequences and OSC sequences from terminal output.
 * Keeps only visible text content.
 */
function stripAnsi(text) {
    // Remove OSC sequences: ESC ] ... BEL (\x07) or ESC ] ... ESC \
    text = text.replace(/\x1b\].*?(\x07|\x1b\\)/g, '');
    // Remove CSI sequences: ESC [ <params> <letter>
    text = text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
    // Remove standalone ESC characters that might remain
    text = text.replace(/\x1b/g, '');
    // Remove carriage returns
    text = text.replace(/\r/g, '');
    return text;
}
class TerminalWatcher {
    constructor(onErrorDetected) {
        this.disposables = [];
        this.lastErrorKey = '';
        this.lastErrorTime = 0;
        this.lastTraceback = '';
        this.DEBOUNCE_MS = 3000;
        this.MAX_BUFFER_SIZE = 100 * 1024;
        this.lineBuffers = new Map();
        this.dataDebounceTimers = new Map();
        this.onErrorDetected = onErrorDetected;
    }
    activate() {
        console.log('TerminalWatcher: activate()');
        // ── 触发 1: onDidEndTerminalShellExecution (shell integration) ──
        this.disposables.push(vscode.window.onDidEndTerminalShellExecution(async (event) => {
            const exitCode = event.exitCode;
            console.log('TerminalWatcher: onDidEndTerminalShellExecution fire, exitCode=' + exitCode);
            if (exitCode === undefined)
                return;
            const execution = event.execution;
            let buffer = '';
            try {
                for await (const data of execution.read()) {
                    buffer += data;
                    console.log('TerminalWatcher: onDidEnd read chunk, len=' + data.length);
                    if (buffer.length > this.MAX_BUFFER_SIZE) {
                        buffer = buffer.slice(-this.MAX_BUFFER_SIZE);
                    }
                }
            }
            catch (e) {
                console.log('TerminalWatcher: onDidEnd read error:', e.message);
                return;
            }
            console.log('TerminalWatcher: onDidEnd final buffer len=' + buffer.length + ', first 200=' + buffer.slice(0, 200));
            if (!buffer) {
                console.log('TerminalWatcher: onDidEnd buffer empty, skipping');
                return;
            }
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
                        // 取消该终端上一个定时器，确保只有最后一次（数据最完整时）触发
                        const existing = this.dataDebounceTimers.get(terminalId);
                        if (existing)
                            clearTimeout(existing);
                        const timer = setTimeout(() => {
                            this.dataDebounceTimers.delete(terminalId);
                            this.checkForStreamData(this.lineBuffers.get(terminalId) || '');
                        }, 500);
                        this.dataDebounceTimers.set(terminalId, timer);
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
            const termId = event.terminal.name;
            this.lineBuffers.set(termId, '');
            console.log('TerminalWatcher: cleared buffer for', termId);
            // 从 execution.read() 获取数据（可能被截断，作为备用）
            const execution = event.execution;
            let execBuffer = '';
            try {
                for await (const data of execution.read()) {
                    execBuffer += data;
                    if (execBuffer.length > this.MAX_BUFFER_SIZE)
                        execBuffer = execBuffer.slice(-this.MAX_BUFFER_SIZE);
                }
            }
            catch { /* ignore */ }
            // 延迟等待 lineBuffers（由 onDidWriteTerminalData 持续追加）积累完整数据
            setTimeout(() => {
                const lineBuf = this.lineBuffers.get(termId) || '';
                // 优先使用 lineBuffers（更完整），fallback 到 execution.read 的 buffer
                const bestBuf = lineBuf.length > execBuffer.length ? lineBuf : execBuffer;
                console.log('TerminalWatcher: trigger4 check, execBuf=' + execBuffer.length + ' lineBuf=' + lineBuf.length + ' using=' + (lineBuf.length > execBuffer.length ? 'lineBuf' : 'execBuf'));
                if (bestBuf) {
                    this.checkForStreamData(bestBuf);
                }
            }, 1500);
        }));
    }
    deactivate() {
        // Clean up all pending debounce timers
        for (const timer of this.dataDebounceTimers.values()) {
            clearTimeout(timer);
        }
        this.dataDebounceTimers.clear();
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
    /**
     * Strip ANSI escape sequences from terminal output.
     * Handles CSI sequences (\x1b[...m) and OSC sequences (\x1b]...;...\x07).
     */
    processBuffer(buffer, exitCode) {
        buffer = stripAnsi(buffer).replace(/\r\n/g, '\n');
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