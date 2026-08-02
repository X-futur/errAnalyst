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
  /** Reserved for future streaming support. First version ignores this flag. */
  stream?: boolean;
}

export interface LlmResponse {
  content: string;
  success: boolean;
  error?: string;
}

export interface LlmProvider {
  name: string;
  analyze(request: LlmRequest): Promise<LlmResponse>;
  chat(request: ChatRequest): Promise<LlmResponse>;
}
