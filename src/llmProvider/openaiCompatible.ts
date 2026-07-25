import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';
import { LlmRequest, LlmResponse, LlmProvider } from './types';
import { LlmProviderConfig } from '../config';
import type { ParsedTraceback, ErrorCategory } from '../parser';
import type { BuiltContext } from '../context/contextBuilder';

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
            console.log('=== ErrAnalyst LLM 完整返回 ===');
            console.log(content);
            console.log('=== End ===');
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

// ── Prompt construction ──

export function buildAnalysisPrompts(
  traceback: ParsedTraceback,
  category?: ErrorCategory,
  context?: BuiltContext,
): { systemPrompt: string; userPrompt: string } {
  const categoryVal = category || 'UNKNOWN';
  return {
    systemPrompt: buildSystemPrompt(categoryVal),
    userPrompt: buildUserPrompt(traceback, categoryVal, context),
  };
}

function buildSystemPrompt(category: ErrorCategory): string {
  const roleText = category === 'UNKNOWN'
    ? '你是通用 Python 错误分析专家。根据终端输出和项目配置文件推断错误根因。'
    : '你是 Python 错误分析专家。精通 Python 异常处理、调试和修复。';

  return `你是 ErrAnalyst 错误分析助手。分类：${category}。${roleText}
输出 JSON 格式，字段：
- errorType: string（原始错误类型，与输入一致）
- errorMessage: string（原始错误消息，与输入一致）
- translation: string（中文翻译，用 {{keyword}} 包裹英文术语）
- keywords: [{cn: string, en: string}]（中英术语对照表）
- analysis: string（中文根因分析，必须引用具体行号，格式为 "文件:行号"）
- fixSuggestion: string（中文修复建议，纯文字描述，不需要代码）
${category === 'UNKNOWN' ? '- category: string（你判断的错误类别，可选值：COMPILATION_ERROR/DEPENDENCY_ERROR/SYSTEM_ERROR/RUNTIME_ERROR/UNKNOWN）\n' : ''}
注意：只返回 JSON，不要包含其他文字。`;
}

function buildUserPrompt(
  traceback: ParsedTraceback,
  category: ErrorCategory,
  context?: BuiltContext,
): string {
  const lines: string[] = [];

  // ═══ Part 1: 结构化报错数据 ═══
  lines.push('## Error Details');
  lines.push('');
  lines.push(`Type: ${traceback.errorType}`);
  lines.push(`Message: ${traceback.errorMessage}`);
  lines.push('');

  if (traceback.chain.length > 0) {
    lines.push('Error chain:');
    for (const entry of traceback.chain) {
      const rel = entry.relationship === 'cause' ? 'cause' : 'context';
      lines.push(`  [${rel}] ${entry.filePath}:${entry.lineNumber} — ${entry.errorType}: ${entry.errorMessage.slice(0, 100)}`);
    }
    lines.push(`  [primary] ${traceback.filePath}:${traceback.lineNumber} — ${traceback.errorType}: ${traceback.errorMessage.slice(0, 100)}`);
    lines.push('');
  }

  // ═══ Part 2: 相关源代码（按优先级排序） ═══
  if (context) {
    lines.push('## Source Context');
    lines.push('');

    if (context.mainFile) {
      lines.push(`### ${context.mainFile.path}:${context.mainFile.startLine}-${context.mainFile.endLine} (error location)`);
      lines.push('```');
      lines.push(context.mainFile.content);
      lines.push('```');
      lines.push('');
    }

    for (const f of context.stackFiles) {
      lines.push(`### ${f.path}:${f.startLine}-${f.endLine}`);
      lines.push('```');
      lines.push(f.content);
      lines.push('```');
      lines.push('');
    }

    for (const f of context.configFiles.slice(0, 3)) {
      lines.push(`### ${f.path}:${f.startLine}-${f.endLine}`);
      lines.push('```');
      lines.push(f.content);
      lines.push('```');
      lines.push('');
    }

    for (const f of context.siblingFiles.slice(0, 2)) {
      lines.push(`### ${f.path}:${f.startLine}-${f.endLine}`);
      lines.push('```');
      lines.push(f.content);
      lines.push('```');
      lines.push('');
    }
  } else {
    // 保底：直接从终端输出提供信息
    lines.push('## Terminal Output');
    lines.push('```');
    lines.push(traceback.fullTraceback.slice(0, 2000));
    lines.push('```');
    lines.push('');
  }

  // ═══ Part 3: 调用栈 ═══
  if (traceback.stackFrames.length > 0) {
    lines.push('## Call Stack');
    for (const frame of traceback.stackFrames.slice(0, 10)) {
      lines.push(`  ${frame.file}:${frame.line} ${frame.function}`);
    }
    lines.push('');
  }

  if (traceback.chain.length > 0) {
    lines.push('## Chained Exceptions Call Stack');
    for (const entry of traceback.chain) {
      lines.push(`  [${entry.relationship}] ${entry.errorType}:`);
      for (const frame of entry.stackFrames.slice(0, 5)) {
        lines.push(`    ${frame.file}:${frame.line} ${frame.function}`);
      }
    }
    lines.push('');
  }

  // ═══ Part 4: 分析指令 ═══
  lines.push('## Instructions');
  lines.push('');
  lines.push('Analyze the error above and provide:');
  lines.push('');
  lines.push('1. translation: Chinese translation of the error message, wrap English terms with {{keyword}} markers');
  lines.push('2. keywords: Chinese-English term mapping table');
  lines.push('3. analysis: Root cause analysis in Chinese, MUST reference specific file:line numbers');
  lines.push('4. fixSuggestion: Fix suggestion in Chinese, text description only, no code');
  if (category === 'UNKNOWN') {
    lines.push('5. category: Your best guess for the error category');
  }
  lines.push('');
  lines.push('Return JSON only.');

  return lines.join('\n');
}

// ── Response parsing ──

export interface AiAnalysisResult {
  errorType: string;
  errorMessage: string;
  translation: string;
  keywords: Array<{ cn: string; en: string }>;
  analysis: string;
  fixSuggestion: string;
  category?: string;
}

export function parseAiResponse(content: string): AiAnalysisResult | null {
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
      category: data.category,
    };
  } catch (e) {
    console.error('ErrAnalyst: Failed to parse AI response', e);
    return null;
  }
}
