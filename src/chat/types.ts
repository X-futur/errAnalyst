export type ChatMessageRole = 'user' | 'assistant' | 'notice';

export interface ChatMessage {
  id: string;
  role: ChatMessageRole;
  content: string;
  createdAt: number;
}

export interface ChatContextFileView {
  id: string;
  path: string;
  source: 'auto' | 'user';
  startLine: number;
  endLine: number;
  truncated: boolean;
  skipped: boolean;
  changed: boolean;
  unavailable: boolean;
}

export interface ChatViewSnapshot {
  messages: ChatMessage[];
  contextFiles: ChatContextFileView[];
  sending: boolean;
  generatingPatch: boolean;
  error: string | null;
}

/** Auto-loaded files from the analysis user prompt (path + line range + snapshot). */
export interface ChatAutoFileInput {
  path: string;
  startLine: number;
  endLine: number;
  content: string;
}
