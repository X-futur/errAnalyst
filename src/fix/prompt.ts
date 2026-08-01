import * as path from 'path';
import type { ParsedTraceback } from '../parser';
import type { BuiltContext } from '../context/contextBuilder';
import type { FixHunkInput } from './types';
import { normalizeLine } from './validator';

export const MAX_FIX_HUNKS = 20;

export interface FixPrompts {
  systemPrompt: string;
  userPrompt: string;
}

export function buildFixPrompts(
  traceback: ParsedTraceback,
  context?: BuiltContext,
  analysisText?: string,
): FixPrompts {
  return {
    systemPrompt: buildFixSystemPrompt(),
    userPrompt: buildFixUserPrompt(traceback, context, analysisText),
  };
}

function buildFixSystemPrompt(): string {
  return `你是 ErrAnalyst 的修复补丁生成助手，基于终端报错和相关源代码生成最小、精确的代码修改补丁。
只输出 JSON，不要包含任何其他文字。
JSON 结构：
{
  "changes": [
    {
      "file": "源代码文件中出现的完整路径",
      "reason": "一句中文说明为什么这样修改",
      "oldLines": ["当前文件中的原代码行"],
      "newLines": ["修改后的代码行"]
    }
  ]
}
规则：
1. 只修改出现在 ## Source Context 中的文件，file 路径必须与 Source Context 中的路径完全一致。
2. oldLines 必须逐字复制当前文件内容，并且必须包含被替换的行；新增代码时，把插入位置前的一行同时放入 oldLines 和 newLines 作为锚点。
3. 只修复与本次报错直接相关的根因，禁止无关重构、格式调整、注释修改。
4. 最多 ${MAX_FIX_HUNKS} 处修改；多个不连续位置必须拆成多个 changes 元素。
5. newLines 为空数组表示删除 oldLines 中的代码。`;
}

function buildFixUserPrompt(
  traceback: ParsedTraceback,
  context?: BuiltContext,
  analysisText?: string,
): string {
  const lines: string[] = [];
  const fullTraceback = traceback.fullTraceback || '';

  lines.push('## Original Traceback');
  lines.push('');
  lines.push('```');
  lines.push(fullTraceback);
  lines.push('```');
  lines.push('');

  lines.push('## Parsed Error Data');
  lines.push('');
  lines.push('Type: ' + (traceback.errorType || ''));
  lines.push('Message: ' + (traceback.errorMessage || ''));
  if (traceback.filePath) {
    lines.push('File: ' + traceback.filePath + ':' + traceback.lineNumber);
  }
  lines.push('');

  const serialized = serializeSourceContext(context);
  lines.push('## Source Context');
  lines.push('');
  lines.push(serialized || '_（contextBuilder 未找到任何相关源代码）_');
  lines.push('');

  if (analysisText) {
    lines.push('## Previous Analysis');
    lines.push('');
    lines.push(analysisText);
    lines.push('');
  }

  lines.push('## Instructions');
  lines.push('');
  lines.push('根据上面的报错和相关代码生成修复补丁。');
  lines.push('- 只改根因，不做无关修改；');
  lines.push('- oldLines 必须与 ## Source Context 中的代码逐字一致；');
  lines.push('- 只修改 ## Source Context 中列出的文件；');
  lines.push('- 返回 JSON only。');

  return lines.join('\n');
}

function serializeSourceContext(context?: BuiltContext): string {
  if (!context) return '';
  const parts: string[] = [];
  const pushFile = (file: { path: string; startLine: number; endLine: number; content: string }, label: string): void => {
    parts.push(`### ${file.path}:${file.startLine}-${file.endLine} (${label})`);
    parts.push('```');
    parts.push(file.content);
    parts.push('```');
    parts.push('');
  };

  if (context.mainFile) pushFile(context.mainFile, 'error location, P0');
  for (const f of (context.stackFiles || []).slice(0, 5)) pushFile(f, 'stack frame');
  for (const f of (context.configFiles || []).slice(0, 2)) pushFile(f, 'config');
  for (const f of (context.siblingFiles || []).slice(0, 1)) pushFile(f, 'sibling');
  return parts.join('\n');
}

/**
 * Parse and validate the AI fix response.
 * Invalid entries (bad fields, missing anchors, out-of-whitelist files) are skipped.
 */
export function parseFixResponse(content: string, allowedFiles: string[]): FixHunkInput[] {
  let data: { changes?: unknown };
  try {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return [];
    data = JSON.parse(jsonMatch[0]);
  } catch {
    return [];
  }

  if (!Array.isArray(data.changes)) return [];

  const seen = new Set<string>();
  const result: FixHunkInput[] = [];
  for (const raw of data.changes) {
    if (result.length >= MAX_FIX_HUNKS) break;
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    if (typeof item.file !== 'string' || typeof item.reason !== 'string') continue;
    if (!Array.isArray(item.oldLines) || !Array.isArray(item.newLines)) continue;
    if (item.oldLines.length === 0) continue;

    const oldLines = item.oldLines.filter((l): l is string => typeof l === 'string').map(normalizeLine);
    const newLines = item.newLines.filter((l): l is string => typeof l === 'string').map(normalizeLine);
    if (oldLines.length === 0) continue;

    const file = resolveAllowedFile(item.file, allowedFiles);
    if (!file) continue;

    const key = file + '\u0000' + oldLines.join('\n') + '\u0000' + newLines.join('\n');
    if (seen.has(key)) continue;
    seen.add(key);

    result.push({ file, reason: item.reason, oldLines, newLines });
  }
  return result;
}

function resolveAllowedFile(candidate: string, allowedFiles: string[]): string | null {
  const normalized = path.normalize(candidate);
  const exact = allowedFiles.find(f => path.normalize(f) === normalized);
  if (exact) return exact;

  // Accept a suffix match so the model can use relative paths like src/app.py.
  for (const allowed of allowedFiles) {
    if (allowed.endsWith('/' + normalized) || allowed.endsWith('\\' + normalized)) return allowed;
  }
  return null;
}
