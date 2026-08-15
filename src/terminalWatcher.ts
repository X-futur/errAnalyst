import * as vscode from 'vscode';
import { PythonTracebackParser } from './parser/pythonTraceback';
import type { ChainEntry, ParsedTraceback, StackFrame } from './parser';
import {
  ErrorAnalysisResult,
  ErrorRecognitionTier,
  ErrorTriggerSource,
} from './config';
import { ErrorLinkProvider_ } from './ui/errorLinkProvider';
import {
  STREAM_GRACE_MS,
  STREAM_HARD_CAP_MS,
  STRUCTURED_COOLDOWN_MS,
  LOG_LINE_COOLDOWN_MS,
  UPGRADE_WINDOW_MS,
  getCooldownMs,
  detectStreamTier,
  isStreamStructuredEligible,
  extractLogError,
  normalizeLogMessage,
} from './terminalStream';

const MAX_BUFFER_SIZE = 100 * 1024;

/**
 * Strip ANSI escape sequences and OSC sequences from terminal output.
 * Keeps only visible text content.
 */
function stripAnsi(text: string): string {
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
function commandLineToString(
  cl: vscode.TerminalShellExecutionCommandLine | undefined,
): string | undefined {
  return cl?.value;
}

export type ErrorDetectedCallback = (
  result: ErrorAnalysisResult,
  options?: { upgrade?: boolean },
) => void;

/** 冷却期内重复出现同一报错时的回调（只累计统计，不重复 AI 分析）。 */
export type ErrorOccurrenceCallback = (result: ErrorAnalysisResult) => void;

/**
 * True when the parsed error is a KeyboardInterrupt caused by a manual stop
 * (e.g. Ctrl+C). The parser may fall back to errorType "Error" with
 * "KeyboardInterrupt" as the message, so both forms are checked.
 */
export function isKeyboardInterruptError(parseResult: ParsedTraceback): boolean {
  return parseResult.errorType === 'KeyboardInterrupt' ||
    /^KeyboardInterrupt(?:\s*:|\s|$)/m.test(parseResult.errorMessage);
}

// ── 流式状态 ──

interface PendingStreamAnalysis {
  timer: NodeJS.Timeout;
  tier: ErrorRecognitionTier;
  firstHitAt: number;
}

interface TerminalStreamState {
  buffer: string;
  commandLine?: string;
  pending: PendingStreamAnalysis | null;
}

export class TerminalWatcher {
  private disposables: vscode.Disposable[] = [];
  private onErrorDetected: ErrorDetectedCallback;
  private onOccurrence?: ErrorOccurrenceCallback;
  private streamStates = new Map<vscode.Terminal, TerminalStreamState>();
  /** 分档冷却：`结构化key` 或 `log::内容` -> 最近一次分析时间。 */
  private cooldowns = new Map<string, number>();
  private lastErrorKey: string = '';
  private lastErrorTime: number = 0;
  private lastErrorTriggerSource?: ErrorTriggerSource;
  private lastTraceback: string = '';
  private readonly DEBOUNCE_MS = 3000;

  constructor(
    onErrorDetected: ErrorDetectedCallback,
    onOccurrence?: ErrorOccurrenceCallback,
  ) {
    this.onErrorDetected = onErrorDetected;
    this.onOccurrence = onOccurrence;
  }

  activate(): void {
    console.log('TerminalWatcher: activate()');

    // ── 触发 1: onDidEndTerminalShellExecution（命令结束） ──
    this.disposables.push(
      vscode.window.onDidEndTerminalShellExecution(async (event) => {
        const exitCode = event.exitCode;
        console.log('TerminalWatcher: onDidEndTerminalShellExecution fire, exitCode=' + exitCode);
        if (exitCode === undefined) return;
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
        } catch (e: any) {
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
        const traceback = PythonTracebackParser.extractErrorBlock(stripped);
        const parseResult = traceback
          ? PythonTracebackParser.parse(traceback, workspaceFolders)
          : null;
        if (parseResult) {
          const key = parseResult.errorType + '::' + parseResult.errorMessage.slice(0, 100);
          const now = Date.now();
          if (
            key === this.lastErrorKey &&
            now - this.lastErrorTime < UPGRADE_WINDOW_MS &&
            this.lastErrorTriggerSource === 'runtime'
          ) {
            console.log('TerminalWatcher: upgrade runtime -> command-end:', parseResult.errorType);
            this.lastErrorTriggerSource = 'command-end';
            this.lastErrorTime = now;
            const upgraded: ErrorAnalysisResult = {
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
              firstErrorLine: PythonTracebackParser.extractFirstErrorLine(stripped),
              timestamp: now,
            };
            this.lastTraceback = traceback || '';
            this.onErrorDetected(upgraded, { upgrade: true });
            return;
          }
        }

        if (exitCode !== 0) {
          this.checkForError(stripped, exitCode, commandLine);
        } else {
          this.checkForSupplementaryError(stripped, commandLine);
        }
      })
    );

    // ── 触发 2: TerminalLinkProvider（稳定兜底数据通道） ──
    const linkProvider = new ErrorLinkProvider_((line, terminal) => {
      this.appendData(terminal, line + '\n');
    });
    this.disposables.push(vscode.window.registerTerminalLinkProvider(linkProvider));
    console.log('TerminalWatcher: linkProvider registered');

    // ── 触发 3: onDidWriteTerminalData（提案 API，完整数据通道） ──
    try {
      const win = vscode.window as any;
      if (typeof win.onDidWriteTerminalData === 'function') {
        console.log('TerminalWatcher: onDidWriteTerminalData IS available');
        this.disposables.push(
          win.onDidWriteTerminalData((event: any) => {
            const data = event.data as string;
            const terminal = event.terminal as vscode.Terminal | undefined;
            if (!terminal || typeof data !== 'string') return;
            this.appendData(terminal, data);
          })
        );
      } else {
        console.log('TerminalWatcher: onDidWriteTerminalData NOT available');
      }
    } catch (e: any) {
      console.log('TerminalWatcher: onDidWriteTerminalData error:', e.message);
    }

    // ── 触发 4: onDidStartTerminalShellExecution（清空缓冲 + 记录命令） ──
    this.disposables.push(
      vscode.window.onDidStartTerminalShellExecution((event) => {
        const state = this.getState(event.terminal);
        this.cancelPending(event.terminal);
        state.buffer = '';
        state.commandLine = commandLineToString(event.execution.commandLine);
        console.log('TerminalWatcher: cleared stream buffer for', event.terminal.name);
      })
    );
  }

  deactivate(): void {
    for (const state of this.streamStates.values()) {
      if (state.pending) clearTimeout(state.pending.timer);
    }
    this.streamStates.clear();
    this.cooldowns.clear();
    this.disposables.forEach(d => d.dispose());
    this.disposables = [];
  }

  getLastTraceback(): string {
    return this.lastTraceback;
  }

  // ── 流式数据通道 ──

  private getState(terminal: vscode.Terminal): TerminalStreamState {
    let state = this.streamStates.get(terminal);
    if (!state) {
      state = { buffer: '', pending: null };
      this.streamStates.set(terminal, state);
    }
    return state;
  }

  private appendData(terminal: vscode.Terminal, data: string): void {
    const clean = stripAnsi(data).replace(/\r\n/g, '\n');
    if (!clean) return;
    const state = this.getState(terminal);
    state.buffer += clean;
    if (state.buffer.length > MAX_BUFFER_SIZE) {
      state.buffer = state.buffer.slice(-MAX_BUFFER_SIZE);
    }
    this.feedStreamDetector(terminal, state, clean);
  }

  /** 命中报错特征后进入/延续等待窗口；输出稳定后触发分析。 */
  private feedStreamDetector(
    terminal: vscode.Terminal,
    state: TerminalStreamState,
    chunk: string,
  ): void {
    const tier = detectStreamTier(chunk);
    if (!tier) return;
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
      timer: setTimeout(() => this.fireStreamAnalysis(terminal), STREAM_GRACE_MS),
    };
  }

  private reschedulePending(terminal: vscode.Terminal, pending: PendingStreamAnalysis): void {
    clearTimeout(pending.timer);
    const elapsed = Date.now() - pending.firstHitAt;
    const delay = Math.max(0, Math.min(STREAM_GRACE_MS, STREAM_HARD_CAP_MS - elapsed));
    pending.timer = setTimeout(() => this.fireStreamAnalysis(terminal), delay);
  }

  private cancelPending(terminal: vscode.Terminal): void {
    const state = this.streamStates.get(terminal);
    if (state?.pending) {
      clearTimeout(state.pending.timer);
      state.pending = null;
    }
  }

  private fireStreamAnalysis(terminal: vscode.Terminal): void {
    const state = this.streamStates.get(terminal);
    if (!state?.pending) return;
    const pending = state.pending;
    state.pending = null;
    this.analyzeStream(terminal, state, pending.tier);
  }

  private analyzeStream(
    terminal: vscode.Terminal,
    state: TerminalStreamState,
    tier: ErrorRecognitionTier,
  ): void {
    const buffer = state.buffer;
    if (!buffer) return;
    const workspaceFolders = this.workspaceFolders();

    // 先尝试结构化解析（日志档等待期间可能跟进了完整 traceback）
    const traceback = PythonTracebackParser.extractErrorBlock(buffer);
    if (traceback) {
      const parseResult = PythonTracebackParser.parse(traceback, workspaceFolders);
      if (parseResult && isStreamStructuredEligible(parseResult)) {
        if (isKeyboardInterruptError(parseResult)) return;
        this.emitStreamResult(terminal, parseResult, 'structured', traceback, buffer);
        return;
      }
    }

    // 结构化档要求解析成功；失败则静默丢弃
    if (tier === 'structured') return;

    const log = extractLogError(buffer);
    if (!log) return;
    const pseudo: ParsedTraceback = {
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

  private emitStreamResult(
    terminal: vscode.Terminal,
    source: {
      errorType: string;
      errorMessage: string;
      filePath: string;
      lineNumber: number;
      stackFrames: StackFrame[];
      fullTraceback: string;
      chain: ChainEntry[];
    },
    tier: ErrorRecognitionTier,
    tracebackText: string,
    buffer: string,
  ): void {
    const key = tier === 'log-line'
      ? 'log::' + normalizeLogMessage(source.errorMessage)
      : source.errorType + '::' + source.errorMessage.slice(0, 100);
    const now = Date.now();
    const lastAt = this.cooldowns.get(key) || 0;
    if (now - lastAt < getCooldownMs(tier)) {
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
    if (this.cooldowns.size > 200) this.pruneCooldowns();

    const state = this.streamStates.get(terminal);
    const result: ErrorAnalysisResult = {
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
      firstErrorLine: PythonTracebackParser.extractFirstErrorLine(buffer),
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

  private checkForError(buffer: string, exitCode: number, commandLine?: string): void {
    this.processBuffer(buffer, { exitCode, triggerSource: 'command-end' }, commandLine);
  }

  private checkForSupplementaryError(buffer: string, commandLine?: string): void {
    if (!buffer.includes('Traceback')) return;
    this.processBuffer(buffer, { triggerSource: 'command-end' }, commandLine);
  }

  /**
   * 解析命令结束缓冲并触发分析（结构化档）。
   * hasExitCode 语义：仅命令结束报错有意义；运行时报错恒为 false。
   */
  private processBuffer(
    buffer: string,
    opts: { exitCode?: number; triggerSource: ErrorTriggerSource },
    commandLine?: string,
  ): void {
    buffer = stripAnsi(buffer).replace(/\r\n/g, '\n');
    const traceback = PythonTracebackParser.extractErrorBlock(buffer);
    const workspaceFolders = this.workspaceFolders();
    const parseResult = traceback ? PythonTracebackParser.parse(traceback, workspaceFolders) : null;
    if (!parseResult) return;
    if (isKeyboardInterruptError(parseResult)) {
      console.log('TerminalWatcher: ignoring KeyboardInterrupt (manual stop)');
      return;
    }

    const errorKey = parseResult.errorType + '::' + parseResult.errorMessage.slice(0, 100);
    const now = Date.now();
    if (errorKey === this.lastErrorKey && now - this.lastErrorTime < this.DEBOUNCE_MS) return;
    // 写入冷却，供流式路径跨通道去重
    this.cooldowns.set(errorKey, now);
    if (this.cooldowns.size > 200) this.pruneCooldowns();

    const result: ErrorAnalysisResult = {
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
      firstErrorLine: PythonTracebackParser.extractFirstErrorLine(buffer),
      timestamp: now,
    };

    this.lastErrorKey = errorKey;
    this.lastErrorTime = now;
    this.lastErrorTriggerSource = opts.triggerSource;
    this.lastTraceback = traceback || '';
    console.log('TerminalWatcher: ERROR DETECTED:', result.errorType);
    this.onErrorDetected(result);
  }

  private workspaceFolders(): string[] {
    return (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath);
  }

  private pruneCooldowns(): void {
    const now = Date.now();
    const maxTtl = Math.max(STRUCTURED_COOLDOWN_MS, LOG_LINE_COOLDOWN_MS) + 5000;
    for (const [key, at] of this.cooldowns) {
      if (now - at > maxTtl) this.cooldowns.delete(key);
    }
  }
}
