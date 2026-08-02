import type { ChatAutoFileInput, ChatMessage, ChatViewSnapshot } from './types';
import { ChatContextManager, type ContextPayload } from './contextFiles';

export const MAX_HISTORY_MESSAGES = 20;
export const MAX_HISTORY_CHARS = 12000;

/**
 * Owns one chat conversation for the current error: message history and
 * the context file set. History is in-memory only and resets per error.
 */
export class ChatSessionManager {
  private messages: ChatMessage[] = [];
  private context = new ChatContextManager();
  private sending = false;
  private generatingPatch = false;
  private error: string | null = null;
  private idCounter = 0;

  constructor(private readonly onStateChanged: (snapshot: ChatViewSnapshot) => void) {}

  startForError(autoFiles: ChatAutoFileInput[]): void {
    this.messages = [];
    this.context.setAutoFiles(autoFiles);
    this.sending = false;
    this.generatingPatch = false;
    this.error = null;
    this.emit();
  }

  /** Re-analyzing the same error keeps the conversation but refreshes auto files. */
  updateAutoFiles(autoFiles: ChatAutoFileInput[]): void {
    this.context.setAutoFiles(autoFiles);
    this.emit();
  }

  newSession(): void {
    this.messages = [];
    this.sending = false;
    this.generatingPatch = false;
    this.error = null;
    this.emit();
  }

  addUserMessage(content: string): void {
    this.messages.push(this.makeMessage('user', content));
    this.emit();
  }

  appendAssistantMessage(content: string): void {
    this.messages.push(this.makeMessage('assistant', content));
    this.emit();
  }

  addNotice(content: string): void {
    this.messages.push(this.makeMessage('notice', content));
    this.emit();
  }

  setSending(value: boolean): void {
    this.sending = value;
    this.emit();
  }

  setGeneratingPatch(value: boolean): void {
    this.generatingPatch = value;
    this.emit();
  }

  setError(message: string | null): void {
    this.error = message;
    this.emit();
  }

  isBusy(): boolean {
    return this.sending || this.generatingPatch;
  }

  async addUserFiles(paths: string[]): Promise<import('./contextFiles').AddFileResult[]> {
    const results = await this.context.addUserFiles(paths);
    this.emit();
    return results;
  }

  removeFile(id: string): void {
    this.context.removeFile(id);
    this.emit();
  }

  restoreDefaults(): void {
    this.context.restoreDefaults();
    this.emit();
  }

  /**
   * LLM-visible history, trimmed to the recent window. With excludeLastUser,
   * the just-typed question is left out so it can be appended once by the prompt builder.
   */
  getLlmHistory(excludeLastUser = false): ChatMessage[] {
    const eligible = this.messages.filter(m => m.role !== 'notice');
    const list = excludeLastUser && eligible.length > 0 && eligible[eligible.length - 1].role === 'user'
      ? eligible.slice(0, -1)
      : [...eligible];
    let trimmed = [...list];
    let dropped = false;
    while (trimmed.length > MAX_HISTORY_MESSAGES) {
      trimmed.shift();
      dropped = true;
    }
    let chars = trimmed.reduce((n, m) => n + m.content.length, 0);
    while (chars > MAX_HISTORY_CHARS && trimmed.length > 0) {
      const removed = trimmed.shift();
      if (removed) {
        chars -= removed.content.length;
        dropped = true;
      }
    }
    if (dropped && !this.messages.some(m => m.role === 'notice' && m.content === '更早消息已截断')) {
      this.messages.push(this.makeMessage('notice', '更早消息已截断'));
      this.emit();
    }
    return trimmed;
  }

  buildContextPayload(): ContextPayload {
    return this.context.buildPayload();
  }

  getAllowedFilePaths(): string[] {
    return this.context.getAllowedFilePaths();
  }

  snapshot(): ChatViewSnapshot {
    return {
      messages: [...this.messages],
      contextFiles: this.context.getViews(),
      sending: this.sending,
      generatingPatch: this.generatingPatch,
      error: this.error,
    };
  }

  private makeMessage(role: ChatMessage['role'], content: string): ChatMessage {
    return {
      id: `chat-${Date.now()}-${this.idCounter++}`,
      role,
      content,
      createdAt: Date.now(),
    };
  }

  private emit(): void {
    this.onStateChanged(this.snapshot());
  }
}
