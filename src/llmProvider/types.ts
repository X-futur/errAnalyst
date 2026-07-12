export interface LlmRequest {
  systemPrompt: string;
  userPrompt: string;
  timeout: number;
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

export interface ParsedAiResponse {
  errorType: string;
  errorMessage: string;
  translation: string;
  keywords: Array<{ cn: string; en: string }>;
  analysis: string;
  fixSuggestion: string;
  fixCode: string;
  fixFile: string;
  fixImports: string[];
  fixLine: number;
}
