import { ErrorAnalysisResult, StackFrame } from './config';

export type ErrorCategory = 'COMPILATION_ERROR' | 'DEPENDENCY_ERROR' | 'SYSTEM_ERROR' | 'RUNTIME_ERROR' | 'UNKNOWN';

/**
 * Python traceback parser.
 * Parses Python error output into structured data.
 */
export class ErrorParser {
  /**
   * Parse a Python traceback string into structured data.
   */
  static parse(traceback: string, workspaceFolders: string[]): ErrorAnalysisResult | null {
    const lines = traceback.split('\n');
    const stackFrames: StackFrame[] = [];
    let errorType = '';
    let errorMessage = '';
    let firstFrameIndex = -1;
    let errorLineIndex = -1;
    
    // Find the start of traceback
    const tracebackStart = lines.findIndex(l => l.trim().startsWith('Traceback'));
    if (tracebackStart === -1) {
      // Try matching standalone error patterns (no traceback)
      return this.parseStandaloneError(lines, workspaceFolders);
    }
    
    // Parse stack frames
    const fileLinePattern = /^\s*File\s+"([^"]+)",\s+line\s+(\d+)(?:,\s+in\s+(.+))?/;
    for (let i = tracebackStart + 1; i < lines.length; i++) {
      const line = lines[i];
      const match = line.match(fileLinePattern);
      if (match) {
        const file = this.resolvePath(match[1], workspaceFolders);
        stackFrames.push({
          file,
          line: parseInt(match[2]),
          function: match[3] || '<module>',
          codeLine: ''
        });
        if (firstFrameIndex === -1) firstFrameIndex = i;
      } else {
        // Check if this line is a code line (indented, no File/line prefix)
        const trimmed = line.trim();
        if (stackFrames.length > 0 && trimmed && !trimmed.startsWith('File "') && !trimmed.startsWith('Traceback')) {
          const lastFrame = stackFrames[stackFrames.length - 1];
          if (!lastFrame.codeLine) {
            lastFrame.codeLine = trimmed;
          }
        }
      }
      
      // Check for error type at end
      const errorMatch = line.match(/^([A-Za-z.]+(?:Error|Exception|Warning|StopIteration)):\s*(.*)/);
      if (errorMatch) {
        errorType = errorMatch[1];
        errorMessage = errorMatch[2];
        errorLineIndex = i;
        break;
      }
    }
    
    if (!errorType && errorLineIndex === -1) {
      // Try last non-empty line as error
      for (let i = lines.length - 1; i >= 0; i--) {
        const trimmed = lines[i].trim();
        if (trimmed) {
          const errorMatch = trimmed.match(/^([A-Za-z.]+(?:Error|Exception|Warning|StopIteration)):\s*(.*)/);
          if (errorMatch) {
            errorType = errorMatch[1];
            errorMessage = errorMatch[2];
            errorLineIndex = i;
          } else {
            errorType = 'Error';
            errorMessage = trimmed;
            errorLineIndex = i;
          }
          break;
        }
      }
    }
    
    if (!errorType && stackFrames.length === 0) return null;
    
    // Primary file/line: use the last stack frame (where error originated)
    const primaryFrame = stackFrames.length > 0 ? stackFrames[stackFrames.length - 1] : null;
    
    return {
      errorType,
      errorMessage,
      filePath: primaryFrame?.file || '',
      lineNumber: primaryFrame?.line || 0,
      stackFrames,
      fullTraceback: traceback,
      timestamp: Date.now()
    };
  }
  
  /**
   * Parse standalone error (no traceback).
   */
  private static parseStandaloneError(
    lines: string[], workspaceFolders: string[]
  ): ErrorAnalysisResult | null {
    let errorType = '';
    let errorMessage = '';
    let filePath = '';
    let lineNumber = 0;
    const stackFrames: StackFrame[] = [];
    
    // Try to find <file>:<line>: <error> pattern (common in linters/compilers)
    for (const line of lines) {
      const match = line.match(/^([^:]+):(\d+):\s*(.+)/);
      if (match) {
        filePath = this.resolvePath(match[1], workspaceFolders);
        lineNumber = parseInt(match[2]);
        const rest = match[3];
        const errorMatch = rest.match(/^([A-Za-z.]+(?:Error|Exception|Warning)):\s*(.*)/);
        if (errorMatch) {
          errorType = errorMatch[1];
          errorMessage = errorMatch[2];
        } else {
          errorType = 'Error';
          errorMessage = rest;
        }
        break;
      }
    }
    
    if (!errorType) {
      // Try parsing File "..." line N format (SyntaxError, no Traceback)
      const fileLinePattern = /^\s*File\s+"([^"]+)",\s+line\s+(\d+)/;
      for (const line of lines) {
        const fileMatch = line.match(fileLinePattern);
        if (fileMatch) {
          filePath = this.resolvePath(fileMatch[1], workspaceFolders);
          lineNumber = parseInt(fileMatch[2]);
        }
        const errorMatch = line.match(/^([A-Za-z.]+(?:Error|Exception|Warning|StopIteration)):\s*(.*)/);
        if (errorMatch) {
          errorType = errorMatch[1];
          errorMessage = errorMatch[2];
        }
      }
    }
    
    if (!errorType) {
      // Try last non-empty line
      for (let i = lines.length - 1; i >= 0; i--) {
        const trimmed = lines[i].trim();
        if (trimmed) {
          const errorMatch = trimmed.match(/^([A-Za-z.]+(?:Error|Exception|Warning|StopIteration)):\s*(.*)/);
          if (errorMatch) {
            errorType = errorMatch[1];
            errorMessage = errorMatch[2];
          } else if (/(?:Error|Exception|Warning|Traceback|SyntaxError|at\s|Failed|failed|Error:|Exception:)/.test(trimmed)) {
            errorType = 'Error';
            errorMessage = trimmed;
          }
          break;
        }
      }
    }
    
    if (!errorType) return null;
    
    return {
      errorType,
      errorMessage,
      filePath,
      lineNumber,
      stackFrames,
      fullTraceback: lines.join('\n'),
      timestamp: Date.now()
    };
  }
  
  /**
   * Resolve file path against workspace folders.
   */
  private static resolvePath(file: string, workspaceFolders: string[]): string {
    if (file.startsWith('/')) return file;
    if (file.startsWith('~')) {
      const homedir = require('os').homedir();
      return file.replace('~', homedir);
    }
    // Try to find in any workspace folder
    for (const folder of workspaceFolders) {
      const potential = require('path').join(folder, file);
      if (require('fs').existsSync(potential)) return potential;
    }
    return file;
  }
  
  /**
   * Normalize error for cache key matching.
   */
 static normalizeErrorKey(errorType: string, stackFrameTop?: string): string {
   const base = errorType.toLowerCase().replace(/[^a-z0-9]/g, '');
   return stackFrameTop ? `${base}:${stackFrameTop}` : base;
 }
 
  /**
   * Implements the findError.md workflow:
   * Step 0: Preprocess - clean noise from terminal output
   * Step 1: Check exit code in last 10 lines (symptom, not root cause)
   * Step 2: Classify by keyword priority: Compilation > Dependency > System > Runtime
   * Step 3: File path heuristic fallback
   * Step 4: Generate action plan and suggestion
   */
  static identify(terminalOutput: string): {
    category: ErrorCategory;
    hasExitCode: boolean;
    actionPlan: string;
    suggestion: string;
    firstErrorLine: string;
  } {
    // Step 0: Preprocess - clean noise
    const cleanOutput = this.preprocess(terminalOutput);
    const lines = cleanOutput.split('\n');
    const lastTenLines = lines.slice(-10);
    const firstErrorLine = this.extractFirstErrorLine(cleanOutput);
    
    // Step 1: Check exit code
    const hasExitCode = this.detectExitCode(lastTenLines);
    
    // Step 2-3: Classify by keywords with priority, fallback to file path heuristic
    const category = this.classifyByKeywords(firstErrorLine, cleanOutput);
    
    // Step 4: Generate advice
    const { actionPlan, suggestion } = this.generateAdvice(category, hasExitCode);
    
    return { category, hasExitCode, actionPlan, suggestion, firstErrorLine };
  }
  
  /**
   * Step 0: Preprocess terminal output - remove noise.
   * Strips timestamps like [2026-07-12 10:00:00] and separator lines.
   */
  private static preprocess(output: string): string {
    let clean = output.replace(/\[\d{4}-\d{2}-\d{2}\s*\d{2}:\d{2}:\d{2}(?:\.\d+)?\]/g, '');
    clean = clean.replace(/^[-=]{3,}$/gm, '');
    return clean;
  }
  
  /**
   * Step 0 helper: Extract the first line matching /Error|ERR|Failed|Exception/.
   * Falls back to last non-empty line if no match.
   */
  private static extractFirstErrorLine(output: string): string {
    const lines = output.split('\n');
    for (const line of lines) {
      if (/Error|ERR|Failed|Exception/i.test(line)) {
        return line.trim();
      }
    }
    return lines[lines.length - 1]?.trim() || '';
  }
  
  /**
   * Step 1: Check if the last 10 lines contain a non-zero exit code pattern.
   * Exit code is a symptom, not the root cause.
   */
  private static detectExitCode(lastTenLines: string[]): boolean {
    const exitCodePattern = /exit code [1-9]\d*|terminated with status [1-9]\d*|Process exited with code [1-9]/i;
    return lastTenLines.some(l => exitCodePattern.test(l));
  }
  
  /**
   * Steps 2-3: Classify error by keyword priority, then file path heuristic.
   * Priority: Compilation > Dependency > System > Runtime.
   */
  private static classifyByKeywords(firstErrorLine: string, fullOutput: string): ErrorCategory {
    const combined = firstErrorLine + '\n' + fullOutput;
    
    // 2.1 — COMPILATION_ERROR (highest priority)
    if (/TS\d{4,}|ESLint|Failed to compile|SyntaxError.*unexpected/is.test(firstErrorLine)) {
      return 'COMPILATION_ERROR';
    }
    
    // 2.2 — DEPENDENCY_ERROR
    if (/npm ERR!|pip install|yarn add|ERESOLVE|ECONNRESET/i.test(firstErrorLine) ||
        /Module not found|Cannot find module/i.test(combined)) {
      return 'DEPENDENCY_ERROR';
    }
    
    // 2.3 — SYSTEM_ERROR
    if (/command not found|EADDRINUSE|Permission denied|Cannot find module 'node'/i.test(firstErrorLine) ||
        /command not found|Permission denied/i.test(combined)) {
      return 'SYSTEM_ERROR';
    }
    
    // 2.4 — RUNTIME_ERROR
    if (/ReferenceError|TypeError|RangeError|Cannot read property|is not a function|undefined/i.test(firstErrorLine)) {
      return 'RUNTIME_ERROR';
    }
    
    // Step 3: File path heuristic fallback
    // Check firstErrorLine for file paths or generic Error: prefix with file paths in full output
    const filePathPattern = /([a-zA-Z]:\\[^\s]+\.(js|ts|py|java|go)|[^\s]+\.(js|ts|py):\d+)/i;
    const hasFilePathInError = filePathPattern.test(firstErrorLine);
    const hasFilePathInOutput = filePathPattern.test(fullOutput);
    const hasGenericError = /Error:|error:|ERR/i.test(firstErrorLine);
    if (hasFilePathInError || (hasGenericError && hasFilePathInOutput)) {
      return 'RUNTIME_ERROR';
    }
    
    return 'UNKNOWN';
  }
  
  /**
   * Step 4: Generate action plan and suggestion based on category and exit code.
   */
  private static generateAdvice(category: ErrorCategory, hasExitCode: boolean): { actionPlan: string; suggestion: string } {
    const advice: Record<string, { plan: string; exitSuggestion: string; normalSuggestion: string }> = {
      COMPILATION_ERROR: {
        plan: '检查 TypeScript 类型或 ESLint 规则，修复语法错误',
        exitSuggestion: '⚠️ 编译失败，请查看上方带行号的错误详情',
        normalSuggestion: '按 Ctrl+Shift+Y 打开问题面板查看更清晰的错误列表'
      },
      DEPENDENCY_ERROR: {
        plan: '检查 package.json / requirements.txt，重新安装依赖或清理缓存',
        exitSuggestion: '⚠️ 依赖安装失败，请检查网络或镜像源配置',
        normalSuggestion: '尝试删除 node_modules 后重新安装，或检查包名是否正确'
      },
      SYSTEM_ERROR: {
        plan: '检查环境变量、端口占用或文件权限',
        exitSuggestion: '⚠️ 系统错误导致程序退出，请检查配置和环境',
        normalSuggestion: '确认命令已安装、端口未被占用、文件可读可执行'
      },
      RUNTIME_ERROR: {
        plan: '检查变量定义、数据类型或异步逻辑',
        exitSuggestion: '⚠️ 程序以非零退出码结束，请向上滚动找到第一个红色的 Error: 行查看具体原因',
        normalSuggestion: '按 Ctrl+Shift+Y 打开问题面板，可以看更清晰的错误列表'
      },
      UNKNOWN: {
        plan: '查看第一个包含文件路径的行，按住 Ctrl 点击跳转',
        exitSuggestion: '⚠️ 程序以非零退出码结束，请向上滚动找到第一个报错行',
        normalSuggestion: '检查命令是否正确、环境变量是否配置、网络是否通畅'
      }
    };
    
    const a = advice[category];
    return {
      actionPlan: a.plan,
      suggestion: hasExitCode ? a.exitSuggestion : a.normalSuggestion
    };
  }
  
 /**
  * Extract error block from terminal output buffer.
   * Pure string operations (no regex). Scans backwards for efficiency.
   * Handles:
   * - Standard Python tracebacks ("Traceback (most recent call last)")
   * - Standalone SyntaxError without traceback
   * - Shell/compiler errors (error: / exception: patterns)
   */
  static extractErrorBlock(buffer: string): string | null {
    // Quick pre-filter: skip buffers without any error indicators
    if (!buffer.includes('Traceback') && !buffer.includes('Error:') &&
        !buffer.includes('Exception:') && !buffer.includes('Warning:') &&
        !buffer.includes('ERR!') && !buffer.includes('SyntaxError') &&
        !buffer.includes('exit code') && !buffer.includes('command not found') &&
        !buffer.includes('Permission denied') && !buffer.includes('Module not found') &&
        !buffer.includes('Failed')) {
      return null;
    }

    const lines = buffer.split('\n');

    // --- Pass 1: Find the error line (scan backwards from the end) ---
    let errorEnd = -1;

    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (line.length === 0) continue;

      // Check for Traceback (standard Python traceback)
      if (line.trimStart().startsWith('Traceback')) {
        return this.extractFullTraceback(lines, i);
      }

      // Check for Python error pattern: Type: message
      // Where Type ends with Error/Exception/Warning/StopIteration
      const colonIdx = line.indexOf(':');
      if (colonIdx > 0) {
        const beforeColon = line.substring(0, colonIdx).trimEnd();
        if (this.looksLikePythonError(beforeColon)) {
          errorEnd = i;
          break;
        }
      }

      // Check for generic shell/compiler errors
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

    // --- Pass 2: Find the start of the error block (scan backwards) ---
    let start = errorEnd;
    let lastFileLine = -1;

    for (let i = errorEnd - 1; i >= 0; i--) {
      const line = lines[i];
      const trimmed = line.trimStart();

      // Stop at shell prompts or REPL prompts
      if (trimmed.startsWith('$') || trimmed.startsWith('%') || trimmed.startsWith('>')) {
        start = i + 1;
        break;
      }

      // If we find Traceback, start from here (standard traceback)
      if (trimmed.startsWith('Traceback')) {
        start = i;
        break;
      }

      // Record File line position but keep scanning (might find Traceback above)
      if (trimmed.startsWith('File "') && trimmed.includes('", line ')) {
        lastFileLine = i;
      }

      // Stop at blank line before error content
      if (line.trim().length === 0) {
        start = i + 1;
        break;
      }
    }

    // If no Traceback found, use the last File line as start (standalone error)
    if (start === errorEnd && lastFileLine >= 0) {
      start = lastFileLine;
    }

    return lines.slice(start, errorEnd + 1).join('\n');
  }

  /**
   * Check if a word looks like a Python error type.
   * Pure string ops: must end with Error/Exception/Warning/StopIteration
   * and have at least one letter before the suffix.
   */
  private static looksLikePythonError(word: string): boolean {
    const suffixes = ['Error', 'Exception', 'Warning', 'StopIteration'];
    for (const suffix of suffixes) {
      if (word.endsWith(suffix)) {
        const prefixLen = word.length - suffix.length;
        if (prefixLen >= 1) {
          // Verify the character before the suffix is a letter or dot
          const ch = word[prefixLen - 1];
          const code = ch.charCodeAt(0);
          return (code >= 65 && code <= 90) ||
                 (code >= 97 && code <= 122) ||
                 code === 46;  // '.' for module names
        }
      }
    }
    return false;
  }

  /**
   * Extract a full traceback block from the traceback line to the end (or next prompt).
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

}
