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
            if (data.includes('Traceback') || data.includes('Error') || data.includes('Exception')) {
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
    const traceback = ErrorParser.extractErrorBlock(buffer);
    if (!traceback) return;

    const errorKey = traceback.slice(0, 200);
    const now = Date.now();
    if (errorKey === this.lastErrorKey && now - this.lastErrorTime < this.DEBOUNCE_MS) {
      return;
    }

    const workspaceFolders = (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath);
    const result = ErrorParser.parse(traceback, workspaceFolders);
    if (!result) return;

    this.lastErrorKey = errorKey;
    this.lastErrorTime = now;
    this.lastTraceback = traceback;
    this.onErrorDetected(result);
  }

  getLastTraceback(): string {
    return this.lastTraceback;
  }
}
