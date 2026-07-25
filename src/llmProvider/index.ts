export { LlmRequest, LlmResponse, LlmProvider } from './types';
export { OpenAICompatibleProvider, buildAnalysisPrompts, parseAiResponse } from './openaiCompatible';
export type { AiAnalysisResult } from './openaiCompatible';

import { LlmProviderConfig } from '../config';
import { LlmProvider } from './types';
import { OpenAICompatibleProvider } from './openaiCompatible';

/**
 * Create the appropriate LLM provider for a given config.
 * Currently all providers use OpenAI-compatible API format.
 */
export function createProvider(config: LlmProviderConfig): LlmProvider | null {
  if (!config.apiKey) return null;
  return new OpenAICompatibleProvider(config);
}
