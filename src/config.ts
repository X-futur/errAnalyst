import * as vscode from 'vscode';
import type { StackFrame, ChainEntry } from './parser';

export interface LlmProviderConfig {
  name: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  enabled: boolean;
}

export interface ErrorAnalysisResult {
  // ── From parser ──
  errorType: string;
  errorMessage: string;
  filePath: string;
  lineNumber: number;
  stackFrames: StackFrame[];
  fullTraceback: string;
  chain: ChainEntry[];

  // ── From categoryClassifier ──
  category?: string;
  firstErrorLine?: string;
  hasExitCode?: boolean;

  // ── From AI ──
  translation?: string;
  keywords?: KeywordPair[];
  analysis?: string;
  fixSuggestion?: string;

  // ── Metadata ──
  timestamp?: number;
}

export interface KeywordPair {
  cn: string;
  en: string;
}

export class Config {
  private static instance: Config;

  static getInstance(): Config {
    if (!Config.instance) {
      Config.instance = new Config();
    }
    return Config.instance;
  }

  getProviders(): LlmProviderConfig[] {
    const config = vscode.workspace.getConfiguration('errAnalyst');
    const providers = config.get<LlmProviderConfig[]>('providers', []);
    console.log('ErrAnalyst: raw providers =', JSON.stringify(providers));
    return providers;
  }

  getActiveProvider(): LlmProviderConfig | undefined {
    const providers = this.getProviders();
    const activeName = vscode.workspace.getConfiguration('errAnalyst')
      .get<string>('activeProvider', '');
    return providers.find(p => p.name === activeName && p.enabled && p.apiKey);
  }

  getAutoAnalyze(): boolean {
    return vscode.workspace.getConfiguration('errAnalyst')
      .get<boolean>('autoAnalyze', true);
  }

  getEnableCache(): boolean {
    return vscode.workspace.getConfiguration('errAnalyst')
      .get<boolean>('enableCache', true);
  }

  getAiTimeout(): number {
    return vscode.workspace.getConfiguration('errAnalyst')
      .get<number>('aiTimeout', 15000);
  }
}
