import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

import type { ParsedTraceback, StackFrame, ChainEntry } from './index';

/**
 * Python traceback parser.
 *
 * Pure-text, line-scanning parsing — no external file access, no network.
 * The only filesystem touch is resolvePath(), which probes whether a
 * relative stack-frame path exists under the workspace folders.
 */
export class PythonTracebackParser {
  // ── Public API ──────────────────────────────────────────

  /**
   * Parse a Python traceback string into a structured ParsedTraceback.
   * Supports chained exceptions (`raise X from Y`, implicit context).
   */
  static parse(
    traceback: string,
    workspaceFolders: string[],
  ): ParsedTraceback | null {
    const trimmed = traceback.trim();
    if (!trimmed) return null;

    // 检测由链指示符分隔的链式回溯块
    const blocks = this.splitChainBlocks(trimmed);
    if (blocks.length === 0) return null;

    // 最后一个块是主要的（最外层异常）
    const primaryBlock = blocks[blocks.length - 1];   // 最后一个块，最外层
    const chainBlocks = blocks.slice(0, -1);  // 除最后一个块之外的其他所有块

    // 解析主项，捕获error相关的错误必要信息
    const primary = this.parseSingleBlock(primaryBlock.text, workspaceFolders);
    if (!primary) return null;

    // 解析链条目
    const chain: ChainEntry[] = chainBlocks.map((block, i) => {
      const parsed = this.parseSingleBlock(block.text, workspaceFolders);
      if (!parsed) return null;
      return {
        errorType: parsed.errorType,
        errorMessage: parsed.errorMessage,
        filePath: parsed.filePath,
        lineNumber: parsed.lineNumber,
        stackFrames: parsed.stackFrames,
        relationship: block.relationship,
        caretLines: parsed.caretLines,
      };
    }).filter(Boolean) as ChainEntry[];

    // chain[0] = root cause, chain[last] = one before primary
    // Already in causal order since Python outputs inner-first

    return {
      errorType: primary.errorType,
      errorMessage: primary.errorMessage,
      filePath: primary.filePath,
      lineNumber: primary.lineNumber,
      stackFrames: primary.stackFrames,
      fullTraceback: traceback,
      caretLines: primary.caretLines,
      chain,
    };
  }

  /**
   * Extract the error block from a terminal output buffer.
   * Returns null if no error block found.
   * 提取完整错误块
   */
  static extractErrorBlock(buffer: string): string | null {
    // Quick pre-filter: skip buffers without any error indicators
    if (!buffer.includes('Traceback') &&
      !buffer.includes('Error:') &&
      !buffer.includes('Exception:') &&
      !buffer.includes('SyntaxError') &&
      !buffer.includes('exit code') &&
      !buffer.includes('command not found') &&
      !buffer.includes('Permission denied') &&
      !buffer.includes('Module not found') &&
      !buffer.includes('Failed')) {
      return null;
    }

    const lines = buffer.split('\n');
    let errorEnd = -1;

    // 第1步：找到错误的行（向后扫描）
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (line.length === 0) continue;

      // 1.如果行以 "Traceback" 开头，说明是 Python traceback 的开始，直接提取完整 traceback
      if (line.trimStart().startsWith('Traceback')) {
        return this.extractFullTraceback(lines, i);
      }

      // 2.检查行中是否包含冒号，尝试判断是否是类似 "ErrorType: message" 的格式
      const colonIdx = line.indexOf(':');
      if (colonIdx > 0) {
        // 拿到冒号前的部分，去掉末尾空格
        const beforeColon = line.substring(0, colonIdx).trimEnd();
        // 检查冒号前的部分是否看起来像 Python 错误类型
        if (this.looksLikePythonError(beforeColon)) {
          errorEnd = i;
          break;
        }
      }

      // 3.检查行中是否包含常见的错误关键字
      const lower = line.toLowerCase();
      if (lower.includes('error:') || lower.includes('exception:') ||
        lower.includes('err!') || lower.includes('syntaxerror') ||
        lower.includes('command not found') || lower.includes('module not found') ||
        lower.includes('failed to') || lower.includes('permission denied') ||
        lower.includes('eslint')) {
        errorEnd = i;
        break;
      }
    }

    if (errorEnd === -1) return null;

    // 第2步：找到错误块的开始位置（向后扫描），从报错处往前找错误块起点
    let start = errorEnd;
    let lastFileLine = -1;

    for (let i = errorEnd - 1; i >= 0; i--) {
      const line = lines[i];
      const trimmed = line.trimStart();

      if (trimmed.startsWith('$') || trimmed.startsWith('%') || trimmed.startsWith('>')) {
        start = i + 1;
        break;
      }
      if (trimmed.startsWith('Traceback')) {
        start = i;
        break;
      }
      if (trimmed.startsWith('File "') && trimmed.includes('", line ')) {
        lastFileLine = i;
      }
      if (line.trim().length === 0) {
        start = i + 1;
        break;
      }
    }

    if (start === errorEnd && lastFileLine >= 0) {
      start = lastFileLine;
    }

    // 找到了 start 和 errorEnd，提取完整错误块
    return lines.slice(start, errorEnd + 1).join('\n');
  }

  /**
   * Extract the first line matching error patterns from output.
   */
  static extractFirstErrorLine(output: string): string {
    const lines = output.split('\n');
    for (const line of lines) {
      if (/Error|ERR|Failed|Exception/i.test(line)) {
        return line.trim();
      }
    }
    return lines[lines.length - 1]?.trim() || '';
  }

  // ── Private: chain splitting ────────────────────────────

  /**
   * Split a full traceback into constituent blocks separated by
   * chain indicators ("The above exception was the direct cause…"
   * or "During handling of the above exception…").
   */
  private static splitChainBlocks(
    text: string,
  ): Array<{ text: string; relationship: ChainEntry['relationship'] }> {
    const lines = text.split('\n');
    const blocks: Array<{ text: string; relationship: ChainEntry['relationship'] }> = [];
    let currentBlockLines: string[] = [];
    let currentRelationship: ChainEntry['relationship'] = 'implicit';

    const causeReg = /^The above exception was the direct cause of the following exception:/;
    const contextReg = /^During handling of the above exception, another exception occurred:/;

    for (const line of lines) {
      const trimmed = line.trim();
      if (causeReg.test(trimmed) || contextReg.test(trimmed)) {
        // The exception above this marker is the cause/context of the next one.
        currentRelationship = causeReg.test(trimmed) ? 'cause' : 'context';
        // Commit the current block
        const blockText = currentBlockLines.join('\n').trim();
        if (blockText) {
          blocks.push({ text: blockText, relationship: currentRelationship });
        }
        currentBlockLines = [];
        continue;
      }
      currentBlockLines.push(line);
    }

    // Commit last block
    const blockText = currentBlockLines.join('\n').trim();
    if (blockText) {
      blocks.push({ text: blockText, relationship: currentRelationship });
    }

    return blocks;
  }

  // ── Private: single traceback block parsing ─────────────

  /**
   * 解析单个回溯块（无链标记）。
   * 仅返回必要字段（无 fullTraceback 或链）。
   */
  private static parseSingleBlock(
    block: string,
    workspaceFolders: string[],
  ): {
    errorType: string;
    errorMessage: string;
    filePath: string;
    lineNumber: number;
    stackFrames: StackFrame[];
    caretLines?: number[];
  } | null {
    const lines = block.split('\n');
    const stackFrames: StackFrame[] = [];
    let errorType = '';
    let errorMessage = '';
    let caretLines: number[] | undefined;  // 代码标记行

    // 找到 traceback 的起始行
    const tracebackStart = lines.findIndex(l => l.trim().startsWith('Traceback'));

    if (tracebackStart === -1) {
      // 没有“Traceback”头 — 尝试独立错误解析
      return this.parseStandaloneInner(lines, workspaceFolders);
    }

    // 解析堆栈帧 + 插入符号行
    // 匹配 文件名、行号、函数名
    const fileLinePattern = /^\s*File\s+"([^"]+)",\s+line\s+(\d+)(?:,\s+in\s+(.+))?/;

    for (let i = tracebackStart + 1; i < lines.length; i++) {
      const line = lines[i];
      const match = line.match(fileLinePattern);

      if (match) {
        const file = this.resolvePath(match[1], workspaceFolders);  // 文件名绝对路径
        const lineNum = parseInt(match[2], 10);  // 行号转为数字
        stackFrames.push({
          file,
          line: lineNum,
          function: match[3] || '<module>',
          codeLine: '',
        });
      } else {
        // 检查这一行是否是代码行（缩进的），捕获代码行
        const trimmed = line.trim();
        if (stackFrames.length > 0 && trimmed &&
          !trimmed.startsWith('File "') && !trimmed.startsWith('Traceback')) {
          const lastFrame = stackFrames[stackFrames.length - 1];
          // 捕获存储代码行
          if (!lastFrame.codeLine) {
            lastFrame.codeLine = trimmed;
          }
        }

        // 捕获插入符号行（Python 3.11 及以上版本的 SyntaxError 插入符号）
        //  ~~^~~   这种符号行
        if (trimmed.startsWith('^') || trimmed.startsWith('~')) {
          // 插入点所在的行与错误行相同
          // 我们只存储前一行代码的行号
          if (stackFrames.length > 0) {
            if (!caretLines) caretLines = [];
            // The caret usually follows the source line, so it's the
            // same line number as the error, but indicates a range.
            // We'll store the line index for reference.
            caretLines.push(stackFrames[stackFrames.length - 1].line);
          }
        }
      }

      // 捕获  异常类型名 错误消息
      // Check for error type at end
      const errorMatch = line.match(/^([A-Za-z0-9_.]+(?:Error|Exception|Warning|StopIteration)):\s*(.*)/);
      if (errorMatch) {
        errorType = errorMatch[1];
        errorMessage = errorMatch[2];
        break;
      }
    }

    // Fallback: try last non-empty line for error type
    // 错误类型回退解析
    if (!errorType) {
      for (let i = lines.length - 1; i >= 0; i--) {
        const trimmed = lines[i].trim();
        if (!trimmed) continue;
        // 匹配并提取错误类型和消息
        const m = trimmed.match(/^([A-Za-z0-9_.]+(?:Error|Exception|Warning|StopIteration)):\s*(.*)/);
        if (m) {
          errorType = m[1];
          errorMessage = m[2];
        } else {
          errorType = 'Error';
          errorMessage = trimmed;
        }
        break;
      }
    }

    if (!errorType && stackFrames.length === 0) return null;

    // 取栈帧最后一个作为主要帧
    const primaryFrame = stackFrames.length > 0
      ? stackFrames[stackFrames.length - 1]
      : null;

    return {
      errorType,
      errorMessage,
      filePath: primaryFrame?.file || '',
      lineNumber: primaryFrame?.line || 0,
      stackFrames,
      caretLines,
    };
  }

  /**
   * 解析独立错误（没有 Traceback 头），例如 SyntaxError 或 linters/compilers 的 file:line:error 格式。
   * Parse a standalone error (no Traceback header), e.g. SyntaxError
   * or file:line:error format from linters/compilers.
   */
  private static parseStandaloneInner(
    lines: string[],
    workspaceFolders: string[],
  ): {
    errorType: string;
    errorMessage: string;
    filePath: string;
    lineNumber: number;
    stackFrames: StackFrame[];
    caretLines?: number[];
  } | null {
    let errorType = '';
    let errorMessage = '';
    let filePath = '';
    let lineNumber = 0;
    const stackFrames: StackFrame[] = [];
    let caretLines: number[] | undefined;

    // 1. Try file:line:error pattern
    for (const line of lines) {
      const match = line.match(/^([^:]+):(\d+):\s*(.+)/);
      if (match) {
        filePath = this.resolvePath(match[1], workspaceFolders);
        lineNumber = parseInt(match[2], 10);
        const rest = match[3];
        const em = rest.match(/^([A-Za-z0-9_.]+(?:Error|Exception|Warning)):\s*(.*)/);
        if (em) {
          errorType = em[1];
          errorMessage = em[2];
        } else {
          errorType = 'Error';
          errorMessage = rest;
        }
        break;
      }
    }

    if (!errorType) {
      // 2. Try File "..." line N format (SyntaxError without Traceback)
      const fileLinePattern = /^\s*File\s+"([^"]+)",\s+line\s+(\d+)/;
      for (const line of lines) {
        const fm = line.match(fileLinePattern);
        if (fm) {
          filePath = this.resolvePath(fm[1], workspaceFolders);
          lineNumber = parseInt(fm[2], 10);
        }
        const em = line.match(/^([A-Za-z0-9_.]+(?:Error|Exception|Warning|StopIteration)):\s*(.*)/);
        if (em) {
          errorType = em[1];
          errorMessage = em[2];
        }
        // Capture caret lines
        const trimmed = line.trim();
        if ((trimmed.startsWith('^') || trimmed.startsWith('~')) && lineNumber > 0) {
          if (!caretLines) caretLines = [];
          caretLines.push(lineNumber);
        }
      }
    }

    if (!errorType) {
      // 3. Last resort: check last non-empty line
      for (let i = lines.length - 1; i >= 0; i--) {
        const trimmed = lines[i].trim();
        if (!trimmed) continue;
        const em = trimmed.match(/^([A-Za-z0-9_.]+(?:Error|Exception|Warning|StopIteration)):\s*(.*)/);
        if (em) {
          errorType = em[1];
          errorMessage = em[2];
        } else if (/(?:Error|Exception|Warning|Traceback|SyntaxError|at\s|Failed|failed|Error:|Exception:)/.test(trimmed)) {
          errorType = 'Error';
          errorMessage = trimmed;
        }
        break;
      }
    }

    if (!errorType) return null;

    if (filePath) {
      stackFrames.push({
        file: filePath,
        line: lineNumber,
        function: '<module>',
      });
    }

    return {
      errorType,
      errorMessage,
      filePath,
      lineNumber,
      stackFrames,
      caretLines,
    };
  }

  /**
   * 从 traceback 行到结束（或下一个提示），以列表形式提取完整的 traceback 块。
   */
  private static extractFullTraceback(lines: string[], tracebackIdx: number): string {
    const result: string[] = [];
    for (let i = tracebackIdx; i < lines.length; i++) {
      const trimmed = lines[i].trimStart();
      if (trimmed.startsWith('$') || trimmed.startsWith('%') || trimmed.startsWith('>')) break;
      result.push(lines[i]);
    }
    return result.join('\n');
  }

  /**
   * Check if a word looks like a Python error type.
   * Pure string ops: must end with Error/Exception/Warning/StopIteration
   * and have at least one letter before the suffix.
   */
  private static looksLikePythonError(word: string): boolean {
    // 判断是否以给定后缀结尾，并且前面至少有一个字母或点号
    const suffixes = ['Error', 'Exception', 'Warning', 'StopIteration'];
    for (const s of suffixes) {
      if (word.endsWith(s)) {
        const prefixLen = word.length - s.length;
        if (prefixLen >= 1) {
          const ch = word[prefixLen - 1];
          const code = ch.charCodeAt(0);
          // . 表示支持带命名空间的错误类型，例如 module.Error
          return (code >= 65 && code <= 90) ||
            (code >= 97 && code <= 122) ||
            code === 46;
        }
      }
    }
    return false;
  }

  /**
   * 根据工作区文件夹解析文件绝对路径。
   */
  static resolvePath(file: string, workspaceFolders: string[]): string {
    // unix linux macos 如果文件路径是绝对路径，直接返回, 暂不处理 windows
    if (file.startsWith('/')) return file;
    // 将 ~ 替换为当前用户的主目录路径
    if (file.startsWith('~')) {
      return file.replace('~', os.homedir());
    }
    // 遍历工作区下的文件夹，拼接绝对路径并检查文件是否存在，存在即为该文件真实的绝对路径
    for (const folder of workspaceFolders) {
      const potential = path.join(folder, file);
      if (fs.existsSync(potential)) return potential;
    }

    return file;
  }
}
