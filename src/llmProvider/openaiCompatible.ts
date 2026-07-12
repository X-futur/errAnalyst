import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';
import { LlmRequest, LlmResponse, LlmProvider } from './types';
import * as fs from 'fs';
import { LlmProviderConfig } from '../config';

export class OpenAICompatibleProvider implements LlmProvider {
  readonly name: string;
  private config: LlmProviderConfig;

  constructor(config: LlmProviderConfig) {
    this.name = config.name;
    this.config = config;
  }

  async analyze(request: LlmRequest): Promise<LlmResponse> {
    const { systemPrompt, userPrompt, timeout } = request;
    const baseUrl = this.config.baseUrl.replace(/\/+$/, '');
    const url = new URL(`${baseUrl}/chat/completions`);

    const body = JSON.stringify({
      model: this.config.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.1,
      max_tokens: 4096
    });

    return new Promise<LlmResponse>((resolve) => {
      const options = {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`,
          'Content-Length': Buffer.byteLength(body)
        },
        timeout
      };

      const client = url.protocol === 'https:' ? https : http;
      const req = client.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) {
              resolve({ content: '', success: false, error: parsed.error.message });
              return;
            }
            const content = parsed.choices?.[0]?.message?.content || '';
            resolve({ content, success: true });
          } catch (e) {
            resolve({ content: '', success: false, error: `JSON parse error: ${e}` });
          }
        });
      });

      req.on('error', (e) => {
        resolve({ content: '', success: false, error: `Request failed: ${e.message}` });
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({ content: '', success: false, error: 'Request timeout' });
      });

      req.write(body);
      req.end();
    });
  }
}

export function buildAnalysisPrompts(
  result: { errorType: string; errorMessage: string; fullTraceback: string; stackFrames: Array<{ file: string; line: number; function: string; codeLine?: string }> }
): { systemPrompt: string; userPrompt: string } {
  const systemPrompt = `You are a Python error analysis expert. Analyze the Python error and return JSON.

Return ONLY valid JSON (no markdown code block markers):

{
  "errorType": "original error type",
  "errorMessage": "original error message",
  "translation": "Chinese translation, wrap key terms with {{keyword}} markers",
  "keywords": [{"cn": "Chinese term", "en": "English term"}],
  "analysis": "Root cause analysis in Chinese",
  "fixSuggestion": "Fix suggestion in Chinese",
  "fixCode": "The fix code (the corrected Python code snippet) - REQUIRED, provide actual Python code that fixes the error. If the fix involves multiple lines, include all of them.",
  "fixFile": "The EXACT full file path that needs to be fixed - use the absolute path from the error traceback file context below"
}

Rules:
1. Use {{keyword}} in translation for highlightable terms
2. Each {{keyword}} must have a matching entry in keywords array
3. Provide detailed, accurate analysis
4. fixFile must be the exact file path (absolute path) of the file that needs to be modified`;

  let contextCode = '';
  for (const frame of result.stackFrames) {
    if (frame.codeLine) {
      contextCode += `File "${frame.file}", line ${frame.line}, in ${frame.function}\n  ${frame.codeLine}\n`;
    } else {
      contextCode += `File "${frame.file}", line ${frame.line}, in ${frame.function}\n`;
    }
  }

  // Read source code context from traceback files
  let sourceContext = '';
  const seen = new Set<string>();
  for (const frame of result.stackFrames) {
    if (!frame.file || seen.has(frame.file)) continue;
    seen.add(frame.file);
    try {
      const fileContent = fs.readFileSync(frame.file, 'utf-8');
      const fileLines = fileContent.split('\n');
      const start = Math.max(0, frame.line - 15);
      const end = Math.min(fileLines.length, frame.line + 5);
      sourceContext += `=== ${frame.file} (lines ${start + 1}-${end}) ===\n`;
      for (let i = start; i < end; i++) {
        const marker = (i === frame.line - 1) ? '>>>' : '   ';
        sourceContext += marker + ' ' + (i + 1) + ': ' + fileLines[i] + '\n';
      }
      sourceContext += '\n';
    } catch {
      // File not accessible, skip
    }
  }

  const userPrompt = `Error:
${result.fullTraceback}

Stack context:
${contextCode || '(no context code)'}

${sourceContext ? 'Source code context (>>> marks the error line):\n' + sourceContext : ''}

Analyze this error and return JSON with the EXACT fixFile path.`;

  return { systemPrompt, userPrompt };
}

export function parseAiResponse(content: string): {
  errorType: string;
  errorMessage: string;
  translation: string;
  keywords: Array<{ cn: string; en: string }>;
  analysis: string;
  fixSuggestion: string;
  fixCode: string;
  fixFile: string;
} | null {
  try {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const data = JSON.parse(jsonMatch[0]);
    return {
      errorType: data.errorType || '',
      errorMessage: data.errorMessage || '',
      translation: data.translation || '',
      keywords: data.keywords || [],
      analysis: data.analysis || '',
      fixSuggestion: data.fixSuggestion || '',
      fixCode: typeof data.fixCode === 'string' ? data.fixCode : '',
      fixFile: typeof data.fixFile === 'string' ? data.fixFile : ''
    };
  } catch (e) {
    console.error('ErrAnalyst: Failed to parse AI response', e);
    return null;
  }
}
