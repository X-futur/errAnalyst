 import { PythonTracebackParser } from './pythonTraceback';
 
 // ── Core type definitions ──
 
 export interface StackFrame {
   file: string;
   line: number;
   function: string;
   codeLine?: string;
 }
 
 export interface ChainEntry {
   errorType: string;
   errorMessage: string;
   filePath: string;
   lineNumber: number;
   stackFrames: StackFrame[];
   relationship: 'cause' | 'context' | 'implicit';
   caretLines?: number[];
 }
 
export interface ParsedTraceback {
  errorType: string;
  errorMessage: string;
  filePath: string;
  lineNumber: number;
  stackFrames: StackFrame[];
  fullTraceback: string;
  /** Terminal command that launched the run (e.g. `python main.py`), when known. */
  commandLine?: string;
  caretLines?: number[];
  chain: ChainEntry[];
}
 
 export type ErrorCategory =
   | 'COMPILATION_ERROR'
   | 'DEPENDENCY_ERROR'
   | 'SYSTEM_ERROR'
   | 'RUNTIME_ERROR'
   | 'UNKNOWN';
 
 // ── Public API ──
 
 export { PythonTracebackParser };
 export const ErrorParser = PythonTracebackParser;
 
 export type ParsedTracebackResult = ParsedTraceback | null;
