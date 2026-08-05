export interface LlmRequest {
  systemPrompt: string;
  userPrompt: string;
  timeout: number;
  traceback?: import('../parser').ParsedTraceback;
  category?: import('../parser').ErrorCategory;
}

export interface ChatTurn {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  messages: ChatTurn[];
  timeout: number;
  /** When true, the provider streams the reply via onChunk instead of waiting for the full body. */
  stream?: boolean;
  /** Called once per streamed content delta (only when stream is enabled). */
  onChunk?: (delta: string) => void;
  /** Aborts the in-flight request; the provider resolves with aborted: true. */
  signal?: AbortSignal;
}

export interface LlmResponse {
  content: string;
  success: boolean;
  error?: string;
  /** True when the request was cancelled via signal before completing. */
  aborted?: boolean;
}

export interface LlmProvider {
  name: string;
  analyze(request: LlmRequest): Promise<LlmResponse>;
  chat(request: ChatRequest): Promise<LlmResponse>;
}
