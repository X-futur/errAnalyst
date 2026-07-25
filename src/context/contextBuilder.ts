 import * as fs from 'fs';
 import * as path from 'path';
 import type { ParsedTraceback } from '../parser';
 import {
   collectCandidates,
   sortCandidates,
   type FileCandidate,
   type ScoringParams,
   DEFAULT_SCORING_PARAMS,
 } from './scorer';
 
 // ── Public types ──
 
 export interface FileContext {
   path: string;
   source: string;         // unique label for this candidate's origin
   startLine: number;
   endLine: number;
   content: string;
 }
 
 export interface BuiltContext {
   mainFile?: FileContext;
   stackFiles: FileContext[];
   configFiles: FileContext[];
   siblingFiles: FileContext[];
   workspaceRoot?: string;
 }
 
 // ── Config file candidates ──
 
 const CONFIG_CANDIDATES = [
   'package.json', 'tsconfig.json', 'requirements.txt',
   'pyproject.toml', '.env', 'Makefile', 'Pipfile',
   'setup.py', 'setup.cfg', 'tox.ini',
 ];
 
 // ── Directories to skip ──
 
 const EXCLUDE_DIRS = new Set([
   'node_modules', '.git', 'out', '.vscode', '.vscode-test',
   '__pycache__', 'dist', 'build', '.next', 'coverage',
   '.cache', 'target', 'bin', 'obj', 'venv', '.env',
 ]);
 
 // ── ContextBuilder ──
 
 export class ContextBuilder {
   private params: ScoringParams;
 
   constructor(params: Partial<ScoringParams> = {}) {
     this.params = { ...DEFAULT_SCORING_PARAMS, ...params };
   }
 
   /**
    * Build context from a parsed traceback and workspace folders.
    * Uses priority scoring to select the most relevant files
    * within the total char budget.
    */
   build(
     traceback: ParsedTraceback,
     workspaceFolders: string[],
   ): BuiltContext {
     const ctx: BuiltContext = {
       stackFiles: [],
       configFiles: [],
       siblingFiles: [],
       workspaceRoot: workspaceFolders[0],
     };
 
     // ── Step 1: Collect scored candidates from stack frames ──
     const candidates = sortCandidates(collectCandidates(traceback, this.params));
 
     // ── Step 2: Add config file candidates ──
     const root = workspaceFolders[0];
     if (root) {
       for (const cf of CONFIG_CANDIDATES) {
         const fullPath = path.join(root, cf);
         if (fs.existsSync(fullPath)) {
           candidates.push({
             filePath: fullPath,
             priority: this.params.configFilePriority,
             startLine: 1,
             endLine: this.params.configFileLines,
             source: 'config_file',
           });
         }
       }
     }
 
     // ── Step 3: Add sibling file candidates ──
     if (traceback.stackFrames.length > 0) {
       const lastFrame = traceback.stackFrames[traceback.stackFrames.length - 1];
       const dir = path.dirname(lastFrame.file);
       const ext = path.extname(lastFrame.file);
       const seenFiles = new Set(candidates.map(c => c.filePath));
       seenFiles.add(lastFrame.file);
 
       try {
         const entries = fs.readdirSync(dir);
         for (const entry of entries) {
           if (candidates.length >= 20) break;  // safety cap
           const fullPath = path.join(dir, entry);
           if (seenFiles.has(fullPath)) continue;
           if (entry.endsWith(ext) && !EXCLUDE_DIRS.has(entry)) {
             candidates.push({
               filePath: fullPath,
               priority: this.params.siblingFilePriority,
               startLine: 1,
               endLine: this.params.siblingFileLines,
               source: 'sibling_file',
             });
             seenFiles.add(fullPath);
           }
         }
       } catch { /* directory not found — skip */ }
     }
 
     // ── Step 4: Greedy selection within char budget ──
     const sorted = sortCandidates(candidates);
     let totalChars = 0;
     const maxChars = this.params.maxTotalChars;
     const selected: Array<{ candidate: FileCandidate; content: string }> = [];
 
     for (const cand of sorted) {
       if (totalChars >= maxChars) break;
 
       const fileContent = this.readFile(cand.filePath, cand.startLine, cand.endLine);
       if (!fileContent) continue;
 
       const contentLen = fileContent.content.length;
       if (totalChars + contentLen > maxChars) {
         // Budget exceeded — skip this file
         continue;
       }
 
       selected.push({ candidate: cand, content: fileContent.content });
       totalChars += contentLen;
 
       // Track the full read range for reporting
 
     }
 
     // ── Step 5: Classify into output buckets ──
     for (const s of selected) {
       const src = s.candidate.source;
       const fc: FileContext = {
         path: s.candidate.filePath,
         source: src,
         startLine: s.candidate.startLine,
         endLine: s.candidate.endLine,
         content: s.content,
       };
 
       if (src === 'primary_last_frame') {
         ctx.mainFile = fc;
       } else if (src === 'config_file') {
         ctx.configFiles.push(fc);
       } else if (src === 'sibling_file') {
         ctx.siblingFiles.push(fc);
       } else {
         ctx.stackFiles.push(fc);
       }
     }
 
     return ctx;
   }
 
   // ── Private helpers ──
 
   private readFile(
     filePath: string,
     startLine: number,
     endLine: number,
   ): { content: string; startLine: number; endLine: number } | null {
     try {
       const content = fs.readFileSync(filePath, 'utf-8');
       const lines = content.split('\n');
       const actualStart = Math.max(0, startLine - 1);
       const actualEnd = Math.min(lines.length, endLine);
       return {
         startLine: actualStart + 1,
         endLine: actualEnd,
         content: lines.slice(actualStart, actualEnd).join('\n'),
       };
     } catch {
       return null;
     }
   }
 }
