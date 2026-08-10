import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
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
  /** Terminal command that launched the run (e.g. `python main.py`). */
  commandLine?: string;

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
  private secrets?: vscode.SecretStorage;

  static getInstance(): Config {
    if (!Config.instance) {
      Config.instance = new Config();
    }
    return Config.instance;
  }

  init(secrets: vscode.SecretStorage): void {
    this.secrets = secrets;
  }

  getProviders(): LlmProviderConfig[] {
    const config = vscode.workspace.getConfiguration('errAnalyst');
    const providers = config.get<LlmProviderConfig[]>('providers', []);
    return providers;
  }

  async getActiveProvider(): Promise<LlmProviderConfig | undefined> {
    const providers = this.getProviders();
    const activeName = vscode.workspace.getConfiguration('errAnalyst')
      .get<string>('activeProvider', '');
    for (const p of providers) {
      if (p.name === activeName && p.enabled) {
        const apiKey = await this.secrets?.get(`errAnalyst:apiKey:${p.name}`);
        if (apiKey) {
          return { ...p, apiKey };
        }
        // Fallback to credentials.json for CLI-set keys
        try {
          const credFile = path.join(os.homedir(), '.errAnalyst', 'credentials.json');
          if (fs.existsSync(credFile)) {
            const creds = JSON.parse(fs.readFileSync(credFile, 'utf-8'));
            if (creds[p.name]) {
              return { ...p, apiKey: creds[p.name] };
            }
          }
        } catch { }
      }
    }
    return undefined;
  }

  async saveProviderConfig(
    provider: { name: string; baseUrl: string; model: string },
    apiKey: string,
    prefs: { autoAnalyze: boolean; enableCache: boolean }
  ): Promise<void> {
    const config = vscode.workspace.getConfiguration('errAnalyst');
    if (this.secrets) {
      await this.secrets.store(`errAnalyst:apiKey:${provider.name}`, apiKey);
    }
    let providers = config.get<LlmProviderConfig[]>('providers', []);
    const existingIdx = providers.findIndex(p => p.name === provider.name);
    const entry: LlmProviderConfig = {
      name: provider.name,
      baseUrl: provider.baseUrl,
      model: provider.model,
      apiKey: '',
      enabled: true,
    };
    if (existingIdx >= 0) {
      providers[existingIdx] = { ...providers[existingIdx], ...entry };
    } else {
      providers.push(entry);
    }
    await config.update('providers', providers, vscode.ConfigurationTarget.Global);
    await config.update('activeProvider', provider.name, vscode.ConfigurationTarget.Global);
    await config.update('autoAnalyze', prefs.autoAnalyze, vscode.ConfigurationTarget.Global);
    await config.update('enableCache', prefs.enableCache, vscode.ConfigurationTarget.Global);

    // Sync API key to ~/.errAnalyst/credentials.json for CLI access
    try {
      const credDir = path.join(os.homedir(), '.errAnalyst');
      const credFile = path.join(credDir, 'credentials.json');
      if (!fs.existsSync(credDir)) fs.mkdirSync(credDir, { recursive: true });
      let creds: Record<string, string> = {};
      if (fs.existsSync(credFile)) {
        creds = JSON.parse(fs.readFileSync(credFile, 'utf-8'));
      }
      creds[provider.name] = apiKey;
      fs.writeFileSync(credFile, JSON.stringify(creds, null, 2));
    } catch (e) {
      console.error('ErrAnalyst: Failed to write credentials file for CLI:', e);
    }
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
      .get<number>('aiTimeout', 50000);
  }

  getEnableOneClickFix(): boolean {
    return vscode.workspace.getConfiguration('errAnalyst')
      .get<boolean>('enableOneClickFix', true);
  }

  getEnableChat(): boolean {
    return vscode.workspace.getConfiguration('errAnalyst')
      .get<boolean>('enableChat', true);
  }
}
