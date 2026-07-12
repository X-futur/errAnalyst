export interface LlmRequest {
  systemPrompt: string;
  userPrompt: string;
  timeout: number;
}

export interface LlmResponse {
  content: string;
  success: boolean;
  error?: string;
}

export interface LlmProvider {
  name: string;
  analyze(request: LlmRequest): Promise<LlmResponse>;
}

// === FixAction types for multi-action fix capability ===

export interface FileEdit {
  file: string;          // absolute path
  startLine: number;     // 1-based, start line to replace
  endLine: number;       // 1-based, end line to replace (inclusive)
  newText: string;       // replacement code
  oldText?: string;      // optional, for diff verification
}

export interface CommandAction {
  cmd: string;              // shell command to execute
  cwd?: string;             // working directory
  description: string;      // Chinese description
  autoApprove: boolean;     // safe to execute without confirmation
}

export type FixActionType = 'edit_file' | 'run_command' | 'info_only';

export interface FixAction {
  type: FixActionType;
  title: string;             // short title
  description: string;       // detailed Chinese description
  priority?: number;         // 0=primary, higher=alternative
  edits?: FileEdit[];        // for edit_file type
  commands?: CommandAction[]; // for run_command type
}

export interface ParsedAiResponse {
  errorType: string;
  errorMessage: string;
  translation: string;
  keywords: Array<{ cn: string; en: string }>;
  analysis: string;
  fixSuggestion: string;
  fixCode: string;
  fixFile: string;
  fixImports: string[];
  fixLine: number;
  actions?: FixAction[];
}
