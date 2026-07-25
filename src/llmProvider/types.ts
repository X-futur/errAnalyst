export interface LlmRequest {
  systemPrompt: string;
  userPrompt: string;
  timeout: number;
  traceback?: import('../parser').ParsedTraceback;
  category?: import('../parser').ErrorCategory;
}

export interface LlmResponse {
  content: string;
  success: boolean;
  error?: string;
}

export interface LlmProvider {
  name: string;
  analyze(request: LlmRequest): Promise<LlmResponse>;
}
