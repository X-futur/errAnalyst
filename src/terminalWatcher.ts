import * as vscode from 'vscode';
import { PythonTracebackParser } from './parser/pythonTraceback';
import type { ParsedTraceback } from './parser';
import { ErrorAnalysisResult } from './config';
import { ErrorLinkProvider_ } from './ui/errorLinkProvider';


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

export type ErrorDetectedCallback = (result: ErrorAnalysisResult) => void;

/**
 * True when the parsed error is a KeyboardInterrupt caused by a manual stop
 * (e.g. Ctrl+C). The parser may fall back to errorType "Error" with
 * "KeyboardInterrupt" as the message, so both forms are checked.
 */
export function isKeyboardInterruptError(parseResult: ParsedTraceback): boolean {
  return parseResult.errorType === 'KeyboardInterrupt' ||
    /^KeyboardInterrupt(?:\s*:|\s|$)/m.test(parseResult.errorMessage);
}

export class TerminalWatcher {
  private disposables: vscode.Disposable[] = [];
  private onErrorDetected: ErrorDetectedCallback;
  private lastErrorKey: string = '';
  private lastErrorTime: number = 0;
  private lastTraceback: string = '';
  private readonly DEBOUNCE_MS = 3000;
  private readonly MAX_BUFFER_SIZE = 100 * 1024;
  private lineBuffers: Map<string, string> = new Map();
  private dataDebounceTimers: Map<string, NodeJS.Timeout> = new Map();

  constructor(onErrorDetected: ErrorDetectedCallback) {
    this.onErrorDetected = onErrorDetected;
  }

  activate(): void {
    console.log('TerminalWatcher: activate()');

    // ── 触发 1: onDidEndTerminalShellExecution (shell integration) ──
    this.disposables.push(
      vscode.window.onDidEndTerminalShellExecution(async (event) => {
        const exitCode = event.exitCode;
        console.log('TerminalWatcher: onDidEndTerminalShellExecution fire, exitCode=' + exitCode);
        if (exitCode === undefined) return;
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
        } catch (e: any) {
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
        } else {
          this.checkForSupplementaryError(buffer);
        }
      })
    );

    // ── 触发 2: TerminalLinkProvider ──
    const linkProvider = new ErrorLinkProvider_((line, terminal) => {
      const termId = terminal.name;
      let buf = this.lineBuffers.get(termId) || '';
      buf += line + '\n';
      if (buf.length > this.MAX_BUFFER_SIZE) buf = buf.slice(-this.MAX_BUFFER_SIZE);
      this.lineBuffers.set(termId, buf);
      // 仅追加到缓冲区，不主动触发分析（由触发 4 统一处理）
    });
    this.disposables.push(vscode.window.registerTerminalLinkProvider(linkProvider));
    console.log('TerminalWatcher: linkProvider registered');

    // ── 触发 3: onDidWriteTerminalData (直接尝试，不用 typeof 检查) ──
    try {
      const win = vscode.window as any;
      if (typeof win.onDidWriteTerminalData === 'function') {
        console.log('TerminalWatcher: onDidWriteTerminalData IS available');
        this.disposables.push(
          win.onDidWriteTerminalData((event: any) => {
            const data = event.data as string;
            console.log('TerminalWatcher: onDidWriteTerminalData got data:', data.slice(0, 100));
            const terminalId = event.terminal?.name || 'unknown';
            let buf = this.lineBuffers.get(terminalId) || '';
            buf += data;
            if (buf.length > this.MAX_BUFFER_SIZE) buf = buf.slice(-this.MAX_BUFFER_SIZE);
            this.lineBuffers.set(terminalId, buf);

            // 仅追加到缓冲区，不主动触发分析（由触发 4 统一处理）
          })
        );
      } else {
        console.log('TerminalWatcher: onDidWriteTerminalData NOT available');
      }
    } catch (e: any) {
      console.log('TerminalWatcher: onDidWriteTerminalData error:', e.message);
    }

    // ── 触发 4: onDidStartTerminalShellExecution ──
    this.disposables.push(
      vscode.window.onDidStartTerminalShellExecution(async (event) => {
        const termId = event.terminal.name;
        this.lineBuffers.set(termId, '');
        console.log('TerminalWatcher: cleared buffer for', termId);
        // 从 execution.read() 获取数据（可能被截断，作为备用）
        const execution = event.execution;
        let execBuffer = '';
        try {
          for await (const data of execution.read()) {
            execBuffer += data;
            if (execBuffer.length > this.MAX_BUFFER_SIZE) execBuffer = execBuffer.slice(-this.MAX_BUFFER_SIZE);
          }
        } catch { /* ignore */ }
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
      })
    );  }

  deactivate(): void {
    // Clean up all pending debounce timers
    for (const timer of this.dataDebounceTimers.values()) {
      clearTimeout(timer);
    }
    this.dataDebounceTimers.clear();
    this.disposables.forEach(d => d.dispose());
    this.disposables = [];
  }

  private hasErrorKeywords(data: string): boolean {
    const kw = [
      'Traceback', 'Error:', 'Exception:',
      'SyntaxError', 'ModuleNotFoundError', 'ZeroDivisionError',
      'TypeError', 'ValueError', 'NameError', 'KeyError',
    ];
    return kw.some(k => data.includes(k));
  }

  private checkForError(buffer: string, exitCode: number): void {
    this.processBuffer(buffer, exitCode);
  }

  private checkForSupplementaryError(buffer: string): void {
    if (!buffer.includes('Traceback')) return;
    this.processBuffer(buffer);
  }

  private checkForStreamData(buffer: string): void {
    if (!buffer) return;
    this.processBuffer(buffer);
  }

  /**
   * Strip ANSI escape sequences from terminal output.
   * Handles CSI sequences (\x1b[...m) and OSC sequences (\x1b]...;...\x07).
   */
  private processBuffer(buffer: string, exitCode?: number): void {
    buffer = stripAnsi(buffer).replace(/\r\n/g, '\n');
    const traceback = PythonTracebackParser.extractErrorBlock(buffer);
    const workspaceFolders = (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath);
    const parseResult = traceback ? PythonTracebackParser.parse(traceback, workspaceFolders) : null;
    if (!parseResult) return;
    if (isKeyboardInterruptError(parseResult)) {
      console.log('TerminalWatcher: ignoring KeyboardInterrupt (manual stop)');
      return;
    }

    const errorKey = parseResult.errorType + '::' + parseResult.errorMessage.slice(0, 100);
    const now = Date.now();
    if (errorKey === this.lastErrorKey && now - this.lastErrorTime < this.DEBOUNCE_MS) return;

    const result: ErrorAnalysisResult = {
      errorType: parseResult.errorType,
      errorMessage: parseResult.errorMessage,
      filePath: parseResult.filePath,
      lineNumber: parseResult.lineNumber,
      stackFrames: parseResult.stackFrames,
      fullTraceback: parseResult.fullTraceback,
      chain: parseResult.chain,
      hasExitCode: exitCode !== undefined ? exitCode !== 0 : true,
      firstErrorLine: PythonTracebackParser.extractFirstErrorLine(buffer),
      timestamp: Date.now(),
    };

    this.lastErrorKey = errorKey;
    this.lastErrorTime = now;
    this.lastTraceback = traceback || '';
    console.log('TerminalWatcher: ERROR DETECTED:', result.errorType);
    this.onErrorDetected(result);
  }

  getLastTraceback(): string {
    return this.lastTraceback;
  }
}
