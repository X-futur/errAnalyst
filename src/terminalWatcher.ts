import * as vscode from 'vscode';
import { PythonTracebackParser } from './parser/pythonTraceback';
import { ErrorAnalysisResult } from './config';
import { ErrorLinkProvider_ } from './ui/errorLinkProvider';

export type ErrorDetectedCallback = (result: ErrorAnalysisResult) => void;

export class TerminalWatcher {
  private disposables: vscode.Disposable[] = [];
  private onErrorDetected: ErrorDetectedCallback;
  private lastErrorKey: string = '';
  private lastErrorTime: number = 0;
  private lastTraceback: string = '';
  private readonly DEBOUNCE_MS = 3000;
  private readonly MAX_BUFFER_SIZE = 100 * 1024;
  private lineBuffers: Map<string, string> = new Map();

  constructor(onErrorDetected: ErrorDetectedCallback) {
    this.onErrorDetected = onErrorDetected;
  }

  activate(): void {
    console.log('TerminalWatcher: activate()');

    // ── 触发 1: onDidEndTerminalShellExecution (shell integration) ──
    this.disposables.push(
      vscode.window.onDidEndTerminalShellExecution(async (event) => {
        const exitCode = event.exitCode;
        if (exitCode === undefined) return;
        const execution = event.execution;
        let buffer = '';
        try {
          for await (const data of execution.read()) {
            buffer += data;
            if (buffer.length > this.MAX_BUFFER_SIZE) {
              buffer = buffer.slice(-this.MAX_BUFFER_SIZE);
            }
          }
        } catch { return; }
        if (!buffer) return;

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
      setTimeout(() => {
        const fullBuf = this.lineBuffers.get(termId) || '';
        this.checkForStreamData(fullBuf);
      }, 500);
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

            if (this.hasErrorKeywords(data)) {
              setTimeout(() => {
                this.checkForStreamData(buf);
              }, 300);
            }
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
        // 新命令开始时清空该终端的缓冲区，避免旧错误干扰
        const termId = event.terminal.name;
        this.lineBuffers.set(termId, '');
        console.log('TerminalWatcher: cleared buffer for', termId);
        const execution = event.execution;
        let buffer = '';
        try {
          for await (const data of execution.read()) {
            buffer += data;
            if (buffer.length > this.MAX_BUFFER_SIZE) buffer = buffer.slice(-this.MAX_BUFFER_SIZE);
            if (this.hasErrorKeywords(data)) {
              setTimeout(() => this.checkForStreamData(buffer), 200);
            }
          }
        } catch { /* ignore */ }
      })
    );
  }

  deactivate(): void {
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

  private processBuffer(buffer: string, exitCode?: number): void {
    const traceback = PythonTracebackParser.extractErrorBlock(buffer);
    const workspaceFolders = (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath);
    const parseResult = traceback ? PythonTracebackParser.parse(traceback, workspaceFolders) : null;
    if (!parseResult) return;

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
