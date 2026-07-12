import * as vscode from 'vscode';
import { ErrorParser } from './errorParser';
import { ErrorAnalysisResult } from './config';

export type ErrorDetectedCallback = (result: ErrorAnalysisResult) => void;

export class TerminalWatcher {
  private disposables: vscode.Disposable[] = [];
  private onErrorDetected: ErrorDetectedCallback;
  private lastErrorKey: string = '';
  private lastErrorTime: number = 0;
  private lastTraceback: string = '';
  private readonly DEBOUNCE_MS = 3000;
  private readonly MAX_BUFFER_SIZE = 100 * 1024;

  constructor(onErrorDetected: ErrorDetectedCallback) {
    this.onErrorDetected = onErrorDetected;
  }

  activate(): void {
    this.disposables.push(
      vscode.window.onDidStartTerminalShellExecution(async (event) => {
        const execution = event.execution;
        let buffer = '';
        try {
          for await (const data of execution.read()) {
            buffer += data;
            if (buffer.length > this.MAX_BUFFER_SIZE) {
              buffer = buffer.slice(-this.MAX_BUFFER_SIZE);
            }
            const errorIndicators = ['Traceback', 'Error', 'Exception', 'Failed',
              'ERR', 'exit code', 'SyntaxError', 'command not found'];
            if (errorIndicators.some(p => data.includes(p))) {
              this.checkForError(buffer);
            }
          }
        } catch (e) {
          // Stream ended or error reading
        }
      })
    );
  }

  deactivate(): void {
    this.disposables.forEach(d => d.dispose());
    this.disposables = [];
  }

  private checkForError(buffer: string): void {
    // Step 1: findError.md pipeline (language-agnostic classification)
    const identification = ErrorParser.identify(buffer);
    
    // Step 2: Python-specific traceback parsing (for structured stack frames)
    const traceback = ErrorParser.extractErrorBlock(buffer);
    const workspaceFolders = (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath);
    const parseResult = traceback ? ErrorParser.parse(traceback, workspaceFolders) : null;
    
    // Skip if no meaningful error detected
    if (identification.category === 'UNKNOWN' && !parseResult) return;

    // Compute debounce key from identification data
    const errorKey = identification.category + '::' + identification.firstErrorLine.slice(0, 100);
    const now = Date.now();
    if (errorKey === this.lastErrorKey && now - this.lastErrorTime < this.DEBOUNCE_MS) {
      return;
    }
    
    // Merge: prefer parseResult for structured data, but always include identification
    const result: ErrorAnalysisResult = parseResult || {
      errorType: identification.category,
      errorMessage: identification.firstErrorLine,
      filePath: '',
      lineNumber: 0,
      stackFrames: [],
      fullTraceback: buffer,
      timestamp: Date.now()
    };
    
    // Fill in findError.md classification fields
    result.category = identification.category;
    result.actionPlan = identification.actionPlan;
    result.suggestion = identification.suggestion;
    result.hasExitCode = identification.hasExitCode;
    result.firstErrorLine = identification.firstErrorLine;
    
    this.lastErrorKey = errorKey;
    this.lastErrorTime = now;
    this.lastTraceback = traceback || '';
    this.onErrorDetected(result);
  }

  getLastTraceback(): string {
    return this.lastTraceback;
  }
}
