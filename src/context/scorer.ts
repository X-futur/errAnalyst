 import type { ParsedTraceback, StackFrame } from '../parser';
 
 // ── Scored candidate ──
 
 export interface FileCandidate {
   filePath: string;
   priority: number;    // higher = more important
   startLine: number;
   endLine: number;
   source: CandidateSource;
 }
 
 export type CandidateSource =
   | 'primary_last_frame'    // primary 栈帧最后一帧
   | 'primary_other_frame'   // primary 栈帧其他帧
   | 'chain_root_frame'      // chain 根因的栈帧
   | 'chain_mid_frame'       // chain 中间层的栈帧
   | 'config_file'           // 配置文件
   | 'sibling_file';         // 同级文件
 
 // ── Default scoring parameters ──
 
 export interface ScoringParams {
   primaryLastFramePriority: number;
   primaryLastFrameLines: number;       // ± lines for read
   chainRootFramePriority: number;
   chainRootFrameLines: number;
   primaryOtherFramePriority: number;
   primaryOtherFrameLines: number;
   chainMidFramePriority: number;
   chainMidFrameLines: number;
   configFilePriority: number;
   configFileLines: number;
   siblingFilePriority: number;
   siblingFileLines: number;
   maxTotalChars: number;
 }
 
 export const DEFAULT_SCORING_PARAMS: ScoringParams = {
   primaryLastFramePriority: 100,
   primaryLastFrameLines: 60,
   chainRootFramePriority: 90,
   chainRootFrameLines: 40,
   primaryOtherFramePriority: 80,
   primaryOtherFrameLines: 30,
   chainMidFramePriority: 60,
   chainMidFrameLines: 20,
   configFilePriority: 40,
   configFileLines: 30,
   siblingFilePriority: 20,
   siblingFileLines: 20,
   maxTotalChars: 7000,
 };
 
 // ── Scoring functions ──
 
 export function collectCandidates(
   traceback: ParsedTraceback,
   params: ScoringParams = DEFAULT_SCORING_PARAMS,
 ): FileCandidate[] {
   const candidates: FileCandidate[] = [];
   const seenPaths = new Set<string>();
 
   // ── Primary 栈帧 ──
   const primaryFrames = traceback.stackFrames;
   for (let i = 0; i < primaryFrames.length; i++) {
     const frame = primaryFrames[i];
     if (seenPaths.has(frame.file)) continue;
     seenPaths.add(frame.file);
 
     const isLast = i === primaryFrames.length - 1;
     candidates.push({
       filePath: frame.file,
       priority: isLast ? params.primaryLastFramePriority : params.primaryOtherFramePriority,
       startLine: Math.max(1, frame.line - (isLast ? params.primaryLastFrameLines : params.primaryOtherFrameLines)),
       endLine: frame.line + (isLast ? params.primaryLastFrameLines : params.primaryOtherFrameLines),
       source: isLast ? 'primary_last_frame' : 'primary_other_frame',
     });
   }
 
   // ── Chain 栈帧 ──
   for (let ci = 0; ci < traceback.chain.length; ci++) {
     const entry = traceback.chain[ci];
     const isRoot = ci === 0;
     const priority = isRoot ? params.chainRootFramePriority : params.chainMidFramePriority;
     const lines = isRoot ? params.chainRootFrameLines : params.chainMidFrameLines;
 
     for (const frame of entry.stackFrames) {
       if (seenPaths.has(frame.file)) continue;
       seenPaths.add(frame.file);
       candidates.push({
         filePath: frame.file,
         priority,
         startLine: Math.max(1, frame.line - lines),
         endLine: frame.line + lines,
         source: isRoot ? 'chain_root_frame' : 'chain_mid_frame',
       });
     }
   }
 
   return candidates;
 }
 
 /**
  * Sort candidates by priority descending, then by file path for determinism.
  */
 export function sortCandidates(candidates: FileCandidate[]): FileCandidate[] {
   return [...candidates].sort((a, b) => {
     if (b.priority !== a.priority) return b.priority - a.priority;
     return a.filePath.localeCompare(b.filePath);
   });
 }
