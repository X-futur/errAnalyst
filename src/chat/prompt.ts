import type { ChatTurn } from '../llmProvider/types';
import type { ParsedTraceback } from '../parser';
import type { ChatMessage } from './types';

export interface ChatPromptInput {
  traceback: ParsedTraceback;
  analysisText: string;
  contextPayload: string;
  history: ChatMessage[];
  question: string;
}

export function buildChatSystemPrompt(): string {
  return `你是 ErrAnalyst 的错误分析对话助手，围绕当前这次 Python 报错回答用户的追问。
规则：
1. 只基于提供的 Traceback、最新分析结果和对话上下文文件作答；引用具体位置时必须使用“文件:行号”。
2. 如果根因无法确定，或问题属于代码之外（环境、服务、配置未就绪等，例如数据库没有配置好），必须明确说明“无法确定”或“这不是代码内问题”，然后只给出用户操作建议（检查哪个配置、查看哪个服务、如何验证），不要编造行号或代码结论。
3. 回答用中文，简洁，可以使用 Markdown 列表和代码块。
4. 不要输出 JSON，不要直接给出完整修复补丁；如需修改代码，请提示用户点击“生成修复补丁”。`;
}

export function buildChatMessages(input: ChatPromptInput): ChatTurn[] {
  const history = input.history
    .filter(m => m.role !== 'notice')
    .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }));
  return [
    { role: 'system', content: buildChatSystemPrompt() },
    { role: 'user', content: buildContextMessage(input) },
    ...history,
    { role: 'user', content: input.question },
  ];
}

function buildContextMessage(input: ChatPromptInput): string {
  const t = input.traceback;
  const lines: string[] = [];
  lines.push('## 当前报错');
  lines.push('');
  lines.push('Type: ' + (t.errorType || ''));
  lines.push('Message: ' + (t.errorMessage || ''));
  if (t.filePath) {
    lines.push('File: ' + t.filePath + ':' + t.lineNumber);
  }
  lines.push('');
  lines.push('## 原始 Traceback');
  lines.push('');
  lines.push('```');
  lines.push(t.fullTraceback || '');
  lines.push('```');
  lines.push('');
  lines.push('## 最新分析结果');
  lines.push('');
  lines.push(input.analysisText || '_（暂无，可先点击“重新 AI 分析”）_');
  lines.push('');
  lines.push('## 对话上下文文件');
  lines.push('');
  lines.push(input.contextPayload || '_（当前没有可用文件）_');
  return lines.join('\n');
}
