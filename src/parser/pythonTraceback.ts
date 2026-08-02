 import * as path from 'path';
 import * as os from 'os';
 import * as fs from 'fs';
 
 import type { ParsedTraceback, StackFrame, ChainEntry } from './index';
 
 /**
  * Python traceback parser.
  *
  * Pure-text parsing — no external file access, no network.
  * Only resolvePath is called for cache-key normalization, not parsing.
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
 
     // Detect chained traceback blocks separated by chain indicators
     const blocks = this.splitChainBlocks(trimmed);
     if (blocks.length === 0) return null;
 
     // The last block is the primary (outermost exception)
     const primaryBlock = blocks[blocks.length - 1];
     const chainBlocks = blocks.slice(0, -1);
 
     // Parse primary
     const primary = this.parseSingleBlock(primaryBlock.text, workspaceFolders);
     if (!primary) return null;
 
     // Parse chain entries
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
 
     // Pass 1: find the error line (scan backwards)
     for (let i = lines.length - 1; i >= 0; i--) {
       const line = lines[i];
       if (line.length === 0) continue;
 
       if (line.trimStart().startsWith('Traceback')) {
         return this.extractFullTraceback(lines, i);
       }
 
       const colonIdx = line.indexOf(':');
       if (colonIdx > 0) {
         const beforeColon = line.substring(0, colonIdx).trimEnd();
         if (this.looksLikePythonError(beforeColon)) {
           errorEnd = i;
           break;
         }
       }
 
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
 
     // Pass 2: find the start of the error block (scan backwards)
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
 
     return lines.slice(start, errorEnd + 1).join('\n');
   }
 
   /**
    * Normalize error type for cache key matching.
    */
   static normalizeErrorKey(errorType: string, stackFrameTop?: string): string {
     const base = errorType.toLowerCase().replace(/[^a-z0-9]/g, '');
     return stackFrameTop ? `${base}:${stackFrameTop}` : base;
   }
 
   /**
    * Preprocess terminal output: strip timestamps and separator lines.
    */
   static preprocess(output: string): string {
     let clean = output.replace(/\[\d{4}-\d{2}-\d{2}\s*\d{2}:\d{2}:\d{2}(?:\.\d+)?\]/g, '');
     clean = clean.replace(/^[-=]{3,}$/gm, '');
     return clean;
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
 
   /**
    * Detect non-zero exit code in the last 10 lines.
    */
   static detectExitCode(lastTenLines: string[]): boolean {
     const pat = /exit code [1-9]\d*|terminated with status [1-9]\d*|Process exited with code [1-9]/i;
     return lastTenLines.some(l => pat.test(l));
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
     const blocks: Array<{ text: string; relationship: ChainEntry['relationship'] }> = [];
 
     // Split on chain markers
     const causeMarker =
       /The above exception was the direct cause of the following exception:\s*\n/g;
     const contextMarker =
       /During handling of the above exception, another exception occurred:\s*\n/g;
 
     let remaining = text;
     let lastEnd = 0;
 
     // We need to split preserving the relationship type.
     // Use a combined regex to find all markers.
     const combined = new RegExp(
       `(${causeMarker.source}|${contextMarker.source})`,
       'g',
     );
 
     let match: RegExpExecArray | null;
     let prevEnd = 0;
 
     while ((match = combined.exec(remaining)) !== null) {
       const blockText = remaining.slice(prevEnd, match.index).trim();
       if (blockText) {
         // Determine relationship of the NEXT block (after the marker)
         const isContext = contextMarker.test(match[0]);
         causeMarker.lastIndex = 0;
         contextMarker.lastIndex = 0;
         // We'll set relationship later since we know the marker
       }
       prevEnd = match.index + match[0].length;
     }
 
     // Simpler approach: just scan line by line for split points
     return this.splitChainBlocksSimple(text);
   }
 
   /**
    * Simpler chain-block splitting: scan lines for markers.
    */
   private static splitChainBlocksSimple(
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
    * Parse a single traceback block (no chain markers).
    * Returns only the essential fields (no fullTraceback or chain).
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
     let caretLines: number[] | undefined;
     let fileLineIndex = -1;
 
     const tracebackStart = lines.findIndex(l => l.trim().startsWith('Traceback'));
 
     if (tracebackStart === -1) {
       // No "Traceback" header — try standalone error parse
       return this.parseStandaloneInner(lines, workspaceFolders);
     }
 
     // Parse stack frames + caret lines
     const fileLinePattern = /^\s*File\s+"([^"]+)",\s+line\s+(\d+)(?:,\s+in\s+(.+))?/;
 
     for (let i = tracebackStart + 1; i < lines.length; i++) {
       const line = lines[i];
       const match = line.match(fileLinePattern);
 
       if (match) {
         const file = this.resolvePath(match[1], workspaceFolders);
         const lineNum = parseInt(match[2], 10);
         stackFrames.push({
           file,
           line: lineNum,
           function: match[3] || '<module>',
           codeLine: '',
         });
         fileLineIndex = i;
       } else {
         // Check if this line is a code line (indented)
         const trimmed = line.trim();
         if (stackFrames.length > 0 && trimmed &&
             !trimmed.startsWith('File "') && !trimmed.startsWith('Traceback')) {
           const lastFrame = stackFrames[stackFrames.length - 1];
           if (!lastFrame.codeLine) {
             lastFrame.codeLine = trimmed;
           }
         }
 
         // Capture caret lines (Python 3.11+ SyntaxError carets)
         if (trimmed.startsWith('^') || trimmed.startsWith('~')) {
           const trimmedLine = line.trimEnd();
           // The caret line is at the same position as the error
           // We store just the line number of the previous code line
           if (stackFrames.length > 0) {
             if (!caretLines) caretLines = [];
             // The caret usually follows the source line, so it's the
             // same line number as the error, but indicates a range.
             // We'll store the line index for reference.
             caretLines.push(stackFrames[stackFrames.length - 1].line);
           }
         }
       }
 
      // Check for error type at end
      const errorMatch = line.match(/^([A-Za-z0-9_.]+(?:Error|Exception|Warning|StopIteration)):\s*(.*)/);
       if (errorMatch) {
         errorType = errorMatch[1];
         errorMessage = errorMatch[2];
         break;
       }
     }
 
     // Fallback: try last non-empty line for error type
     if (!errorType) {
       for (let i = lines.length - 1; i >= 0; i--) {
         const trimmed = lines[i].trim();
         if (!trimmed) continue;
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
 
     // Try file:line:error pattern
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
       // Try File "..." line N format (SyntaxError without Traceback)
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
       // Last resort: check last non-empty line
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
    * Extract a full traceback block from the traceback line to end (or next prompt).
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
     const suffixes = ['Error', 'Exception', 'Warning', 'StopIteration'];
     for (const s of suffixes) {
       if (word.endsWith(s)) {
         const prefixLen = word.length - s.length;
         if (prefixLen >= 1) {
           const ch = word[prefixLen - 1];
           const code = ch.charCodeAt(0);
           return (code >= 65 && code <= 90) ||
                  (code >= 97 && code <= 122) ||
                  code === 46;
         }
       }
     }
     return false;
   }
 
   /**
    * Resolve a relative file path against workspace folders.
    */
   static resolvePath(file: string, workspaceFolders: string[]): string {
     if (file.startsWith('/')) return file;
     if (file.startsWith('~')) {
       return file.replace('~', os.homedir());
     }
     for (const folder of workspaceFolders) {
       const potential = path.join(folder, file);
       if (fs.existsSync(potential)) return potential;
     }

     return file;
   }

  /**
   * Check if a single line contains Python error keywords.
   * Used by TerminalLinkProvider to detect errors without shell integration.
   */
  static hasErrorLine(line: string): boolean {
    const keywords = [
      "Traceback", "Error:", "Exception:",
      "SyntaxError", "ModuleNotFoundError", "ZeroDivisionError",
      "TypeError", "ValueError", "NameError", "KeyError",
      "IndexError", "AttributeError", "PermissionError",
      "FileNotFoundError", "ImportError", "IndentationError",
      "RuntimeError", "StopIteration", "OSError", "EOFError",
      "MemoryError", "RecursionError", "FloatingPointError",
      "OverflowError", "ConnectionError", "BrokenPipeError",
      "command not found", "Permission denied",
      "No such file", "can't open file", "is not defined",
      "unexpected", "invalid syntax", "SyntaxError","failed to",
    ];
    return keywords.some(kw => line.includes(kw));
  }
}
