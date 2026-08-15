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
exports.isKeyboardInterruptError = isKeyboardInterruptError;
const vscode = __importStar(require("vscode"));
const pythonTraceback_1 = require("./parser/pythonTraceback");
const errorLinkProvider_1 = require("./ui/errorLinkProvider");
const terminalStream_1 = require("./terminalStream");
const MAX_BUFFER_SIZE = 100 * 1024;
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
/** Normalize TerminalShellExecutionCommandLine to its raw string form. */
function commandLineToString(cl) {
    return cl?.value;
}
/**
 * True when the parsed error is a KeyboardInterrupt caused by a manual stop
 * (e.g. Ctrl+C). The parser may fall back to errorType "Error" with
 * "KeyboardInterrupt" as the message, so both forms are checked.
 */
function isKeyboardInterruptError(parseResult) {
    return parseResult.errorType === 'KeyboardInterrupt' ||
        /^KeyboardInterrupt(?:\s*:|\s|$)/m.test(parseResult.errorMessage);
}
class TerminalWatcher {
    constructor(onErrorDetected, onOccurrence) {
        this.disposables = [];
        this.streamStates = new Map();
        /** 分档冷却：`结构化key` 或 `log::内容` -> 最近一次分析时间。 */
        this.cooldowns = new Map();
        this.lastErrorKey = '';
        this.lastErrorTime = 0;
        this.lastTraceback = '';
        this.DEBOUNCE_MS = 3000;
        this.onErrorDetected = onErrorDetected;
        this.onOccurrence = onOccurrence;
    }
    activate() {
        console.log('TerminalWatcher: activate()');
        // ── 触发 1: onDidEndTerminalShellExecution（命令结束） ──
        this.disposables.push(vscode.window.onDidEndTerminalShellExecution(async (event) => {
            const exitCode = event.exitCode;
            console.log('TerminalWatcher: onDidEndTerminalShellExecution fire, exitCode=' + exitCode);
            if (exitCode === undefined)
                return;
            const execution = event.execution;
            const commandLine = commandLineToString(execution.commandLine);
            // 若流式等待尚未触发，取消它，避免与服务崩溃的结束分析重复
            this.cancelPending(event.terminal);
            let buffer = '';
            try {
                for await (const data of execution.read()) {
                    buffer += data;
                    if (buffer.length > MAX_BUFFER_SIZE) {
                        buffer = buffer.slice(-MAX_BUFFER_SIZE);
                    }
                }
            }
            catch (e) {
                console.log('TerminalWatcher: onDidEnd read error:', e.message);
                return;
            }
            if (!buffer) {
                console.log('TerminalWatcher: onDidEnd buffer empty, skipping');
                return;
            }
            const stripped = stripAnsi(buffer).replace(/\r\n/g, '\n');
            // 升级检查：流式刚分析过同一报错，命令随即以非零退出 → 升级为命令结束报错
            const workspaceFolders = this.workspaceFolders();
            const traceback = pythonTraceback_1.PythonTracebackParser.extractErrorBlock(stripped);
            const parseResult = traceback
                ? pythonTraceback_1.PythonTracebackParser.parse(traceback, workspaceFolders)
                : null;
            if (parseResult) {
                const key = parseResult.errorType + '::' + parseResult.errorMessage.slice(0, 100);
                const now = Date.now();
                if (key === this.lastErrorKey &&
                    now - this.lastErrorTime < terminalStream_1.UPGRADE_WINDOW_MS &&
                    this.lastErrorTriggerSource === 'runtime') {
                    console.log('TerminalWatcher: upgrade runtime -> command-end:', parseResult.errorType);
                    this.lastErrorTriggerSource = 'command-end';
                    this.lastErrorTime = now;
                    const upgraded = {
                        errorType: parseResult.errorType,
                        errorMessage: parseResult.errorMessage,
                        filePath: parseResult.filePath,
                        lineNumber: parseResult.lineNumber,
                        stackFrames: parseResult.stackFrames,
                        fullTraceback: parseResult.fullTraceback,
                        chain: parseResult.chain,
                        hasExitCode: exitCode !== 0,
                        exitCode,
                        triggerSource: 'command-end',
                        recognitionTier: 'structured',
                        commandLine,
                        firstErrorLine: pythonTraceback_1.PythonTracebackParser.extractFirstErrorLine(stripped),
                        timestamp: now,
                    };
                    this.lastTraceback = traceback || '';
                    this.onErrorDetected(upgraded, { upgrade: true });
                    return;
                }
            }
            if (exitCode !== 0) {
                this.checkForError(stripped, exitCode, commandLine);
            }
            else {
                this.checkForSupplementaryError(stripped, commandLine);
            }
        }));
        // ── 触发 2: TerminalLinkProvider（稳定兜底数据通道） ──
        const linkProvider = new errorLinkProvider_1.ErrorLinkProvider_((line, terminal) => {
            this.appendData(terminal, line + '\n');
        });
        this.disposables.push(vscode.window.registerTerminalLinkProvider(linkProvider));
        console.log('TerminalWatcher: linkProvider registered');
        // ── 触发 3: onDidWriteTerminalData（提案 API，完整数据通道） ──
        try {
            const win = vscode.window;
            if (typeof win.onDidWriteTerminalData === 'function') {
                console.log('TerminalWatcher: onDidWriteTerminalData IS available');
                this.disposables.push(win.onDidWriteTerminalData((event) => {
                    const data = event.data;
                    const terminal = event.terminal;
                    if (!terminal || typeof data !== 'string')
                        return;
                    this.appendData(terminal, data);
                }));
            }
            else {
                console.log('TerminalWatcher: onDidWriteTerminalData NOT available');
            }
        }
        catch (e) {
            console.log('TerminalWatcher: onDidWriteTerminalData error:', e.message);
        }
        // ── 触发 4: onDidStartTerminalShellExecution（清空缓冲 + 记录命令） ──
        this.disposables.push(vscode.window.onDidStartTerminalShellExecution((event) => {
            const state = this.getState(event.terminal);
            this.cancelPending(event.terminal);
            state.buffer = '';
            state.commandLine = commandLineToString(event.execution.commandLine);
            console.log('TerminalWatcher: cleared stream buffer for', event.terminal.name);
        }));
    }
    deactivate() {
        for (const state of this.streamStates.values()) {
            if (state.pending)
                clearTimeout(state.pending.timer);
        }
        this.streamStates.clear();
        this.cooldowns.clear();
        this.disposables.forEach(d => d.dispose());
        this.disposables = [];
    }
    getLastTraceback() {
        return this.lastTraceback;
    }
    // ── 流式数据通道 ──
    getState(terminal) {
        let state = this.streamStates.get(terminal);
        if (!state) {
            state = { buffer: '', pending: null };
            this.streamStates.set(terminal, state);
        }
        return state;
    }
    appendData(terminal, data) {
        const clean = stripAnsi(data).replace(/\r\n/g, '\n');
        if (!clean)
            return;
        const state = this.getState(terminal);
        state.buffer += clean;
        if (state.buffer.length > MAX_BUFFER_SIZE) {
            state.buffer = state.buffer.slice(-MAX_BUFFER_SIZE);
        }
        this.feedStreamDetector(terminal, state, clean);
    }
    /** 命中报错特征后进入/延续等待窗口；输出稳定后触发分析。 */
    feedStreamDetector(terminal, state, chunk) {
        const tier = (0, terminalStream_1.detectStreamTier)(chunk);
        if (!tier)
            return;
        if (state.pending) {
            // 日志档等待期间出现完整 traceback → 升级为结构化档
            if (tier === 'structured' && state.pending.tier === 'log-line') {
                state.pending.tier = 'structured';
            }
            this.reschedulePending(terminal, state.pending);
            return;
        }
        state.pending = {
            tier,
            firstHitAt: Date.now(),
            timer: setTimeout(() => this.fireStreamAnalysis(terminal), terminalStream_1.STREAM_GRACE_MS),
        };
    }
    reschedulePending(terminal, pending) {
        clearTimeout(pending.timer);
        const elapsed = Date.now() - pending.firstHitAt;
        const delay = Math.max(0, Math.min(terminalStream_1.STREAM_GRACE_MS, terminalStream_1.STREAM_HARD_CAP_MS - elapsed));
        pending.timer = setTimeout(() => this.fireStreamAnalysis(terminal), delay);
    }
    cancelPending(terminal) {
        const state = this.streamStates.get(terminal);
        if (state?.pending) {
            clearTimeout(state.pending.timer);
            state.pending = null;
        }
    }
    fireStreamAnalysis(terminal) {
        const state = this.streamStates.get(terminal);
        if (!state?.pending)
            return;
        const pending = state.pending;
        state.pending = null;
        this.analyzeStream(terminal, state, pending.tier);
    }
    analyzeStream(terminal, state, tier) {
        const buffer = state.buffer;
        if (!buffer)
            return;
        const workspaceFolders = this.workspaceFolders();
        // 先尝试结构化解析（日志档等待期间可能跟进了完整 traceback）
        const traceback = pythonTraceback_1.PythonTracebackParser.extractErrorBlock(buffer);
        if (traceback) {
            const parseResult = pythonTraceback_1.PythonTracebackParser.parse(traceback, workspaceFolders);
            if (parseResult && (0, terminalStream_1.isStreamStructuredEligible)(parseResult)) {
                if (isKeyboardInterruptError(parseResult))
                    return;
                this.emitStreamResult(terminal, parseResult, 'structured', traceback, buffer);
                return;
            }
        }
        // 结构化档要求解析成功；失败则静默丢弃
        if (tier === 'structured')
            return;
        const log = (0, terminalStream_1.extractLogError)(buffer);
        if (!log)
            return;
        const pseudo = {
            errorType: log.errorType,
            errorMessage: log.errorMessage,
            filePath: '',
            lineNumber: 0,
            stackFrames: [],
            fullTraceback: log.line,
            chain: [],
        };
        this.emitStreamResult(terminal, pseudo, 'log-line', log.line, buffer);
    }
    emitStreamResult(terminal, source, tier, tracebackText, buffer) {
        const key = tier === 'log-line'
            ? 'log::' + (0, terminalStream_1.normalizeLogMessage)(source.errorMessage)
            : source.errorType + '::' + source.errorMessage.slice(0, 100);
        const now = Date.now();
        const lastAt = this.cooldowns.get(key) || 0;
        if (now - lastAt < (0, terminalStream_1.getCooldownMs)(tier)) {
            console.log('TerminalWatcher: stream repeat suppressed, key=' + key);
            this.onOccurrence?.({
                errorType: source.errorType,
                errorMessage: source.errorMessage,
                filePath: source.filePath,
                lineNumber: source.lineNumber,
                stackFrames: source.stackFrames,
                fullTraceback: source.fullTraceback,
                chain: source.chain,
                recognitionTier: tier,
                triggerSource: 'runtime',
                timestamp: now,
            });
            return;
        }
        this.cooldowns.set(key, now);
        if (this.cooldowns.size > 200)
            this.pruneCooldowns();
        const state = this.streamStates.get(terminal);
        const result = {
            errorType: source.errorType,
            errorMessage: source.errorMessage,
            filePath: source.filePath,
            lineNumber: source.lineNumber,
            stackFrames: source.stackFrames,
            fullTraceback: source.fullTraceback,
            chain: source.chain,
            hasExitCode: false,
            triggerSource: 'runtime',
            recognitionTier: tier,
            commandLine: state?.commandLine,
            firstErrorLine: pythonTraceback_1.PythonTracebackParser.extractFirstErrorLine(buffer),
            timestamp: now,
        };
        this.lastErrorKey = key;
        this.lastErrorTime = now;
        this.lastErrorTriggerSource = 'runtime';
        this.lastTraceback = tracebackText;
        console.log('TerminalWatcher: RUNTIME ERROR DETECTED (' + tier + '):', result.errorType);
        this.onErrorDetected(result);
    }
    // ── 命令结束路径 ──
    checkForError(buffer, exitCode, commandLine) {
        this.processBuffer(buffer, { exitCode, triggerSource: 'command-end' }, commandLine);
    }
    checkForSupplementaryError(buffer, commandLine) {
        if (!buffer.includes('Traceback'))
            return;
        this.processBuffer(buffer, { triggerSource: 'command-end' }, commandLine);
    }
    /**
     * 解析命令结束缓冲并触发分析（结构化档）。
     * hasExitCode 语义：仅命令结束报错有意义；运行时报错恒为 false。
     */
    processBuffer(buffer, opts, commandLine) {
        buffer = stripAnsi(buffer).replace(/\r\n/g, '\n');
        const traceback = pythonTraceback_1.PythonTracebackParser.extractErrorBlock(buffer);
        const workspaceFolders = this.workspaceFolders();
        const parseResult = traceback ? pythonTraceback_1.PythonTracebackParser.parse(traceback, workspaceFolders) : null;
        if (!parseResult)
            return;
        if (isKeyboardInterruptError(parseResult)) {
            console.log('TerminalWatcher: ignoring KeyboardInterrupt (manual stop)');
            return;
        }
        const errorKey = parseResult.errorType + '::' + parseResult.errorMessage.slice(0, 100);
        const now = Date.now();
        if (errorKey === this.lastErrorKey && now - this.lastErrorTime < this.DEBOUNCE_MS)
            return;
        // 写入冷却，供流式路径跨通道去重
        this.cooldowns.set(errorKey, now);
        if (this.cooldowns.size > 200)
            this.pruneCooldowns();
        const result = {
            errorType: parseResult.errorType,
            errorMessage: parseResult.errorMessage,
            filePath: parseResult.filePath,
            lineNumber: parseResult.lineNumber,
            stackFrames: parseResult.stackFrames,
            fullTraceback: parseResult.fullTraceback,
            chain: parseResult.chain,
            hasExitCode: opts.triggerSource === 'command-end'
                ? opts.exitCode !== undefined && opts.exitCode !== 0
                : false,
            exitCode: opts.exitCode,
            triggerSource: opts.triggerSource,
            recognitionTier: 'structured',
            commandLine,
            firstErrorLine: pythonTraceback_1.PythonTracebackParser.extractFirstErrorLine(buffer),
            timestamp: now,
        };
        this.lastErrorKey = errorKey;
        this.lastErrorTime = now;
        this.lastErrorTriggerSource = opts.triggerSource;
        this.lastTraceback = traceback || '';
        console.log('TerminalWatcher: ERROR DETECTED:', result.errorType);
        this.onErrorDetected(result);
    }
    workspaceFolders() {
        return (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath);
    }
    pruneCooldowns() {
        const now = Date.now();
        const maxTtl = Math.max(terminalStream_1.STRUCTURED_COOLDOWN_MS, terminalStream_1.LOG_LINE_COOLDOWN_MS) + 5000;
        for (const [key, at] of this.cooldowns) {
            if (now - at > maxTtl)
                this.cooldowns.delete(key);
        }
    }
}
exports.TerminalWatcher = TerminalWatcher;
//# sourceMappingURL=terminalWatcher.js.map