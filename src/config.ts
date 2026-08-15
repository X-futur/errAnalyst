import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { StackFrame, ChainEntry } from './parser';
import { PRESET_PROVIDERS } from './presets';
import { getModelStatus, getPresetModelList, getRecommendedModel, getDeprecationInfo } from './shared/model-catalog';
import type { PresetModelStatus, CatalogModel } from './shared/model-catalog';
import type { CustomModelStatus } from './shared/model-validation';

export interface LlmProviderConfig {
  name: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  enabled: boolean;
  /** 自定义提供商的模型来源状态（预置提供商无需持久化）。 */
  modelStatus?: CustomModelStatus;
}

export interface WizardProviderEntry {
  name: string;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  modelStatus?: CustomModelStatus;
  /** 预置提供商按官方模型列表判定的状态。 */
  presetModelStatus?: PresetModelStatus;
}

export interface WizardPresetInfo {
  name: string;
  baseUrl: string;
  icon: string;
  description: string;
  recommendedModel: string;
  models: CatalogModel[];
}

export interface WizardExistingConfig {
  activeProvider: string | null;
  providers: WizardProviderEntry[];
  enableCache: boolean;
  /** 预置提供商及其官方模型列表，配置向导据此渲染模型下拉。 */
  presets: WizardPresetInfo[];
}

/** 错误捕获来源：命令结束时捕获 vs 服务运行中捕获。 */
export type ErrorTriggerSource = 'command-end' | 'runtime';

/** 识别档位：结构化报错 vs 纯日志行报错。 */
export type ErrorRecognitionTier = 'structured' | 'log-line';

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
  /** 是否为非零退出：仅命令结束报错有意义；运行时报错为 false。 */
  hasExitCode?: boolean;
  /** 真实退出码（命令结束报错时存在）。 */
  exitCode?: number;
  /** 触发来源：命令结束 vs 运行中。 */
  triggerSource?: ErrorTriggerSource;
  /** 识别档位：结构化 vs 日志行。 */
  recognitionTier?: ErrorRecognitionTier;
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
  private warnedModels = new Set<string>();

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

  /** 配置向导所需的现有配置：提供商列表 + 各 Key 是否存在（真实 Key 不下发到 webview）。 */
  async getWizardConfig(): Promise<WizardExistingConfig> {
    const providers = this.getProviders();
    const existence = await this.getApiKeyExistence(providers.map(p => p.name));
    return {
      activeProvider: vscode.workspace.getConfiguration('errAnalyst')
        .get<string | null>('activeProvider', null),
      providers: providers.map(p => ({
        name: p.name,
        baseUrl: p.baseUrl,
        model: p.model,
        hasApiKey: !!existence[p.name],
        modelStatus: p.modelStatus,
        presetModelStatus: getPresetModelList(p.name).length > 0
          ? getModelStatus(p.name, p.model)
          : undefined,
      })),
      enableCache: this.getEnableCache(),
      presets: PRESET_PROVIDERS
        .filter(p => p.name !== '自定义')
        .map(p => ({
          name: p.name,
          baseUrl: p.baseUrl,
          icon: p.icon,
          description: p.description,
          recommendedModel: getRecommendedModel(p.name),
          models: getPresetModelList(p.name),
        })),
    };
  }

  /** 读取某个提供商的真实 API Key（SecretStorage 优先，回退 CLI 凭据文件）；仅后端使用，不下发 webview。 */
  async getApiKey(name: string): Promise<string | undefined> {
    const key = await this.secrets?.get(`errAnalyst:apiKey:${name}`);
    if (key) return key;
    return this.readCredentialsFile()[name] || undefined;
  }

  private async getApiKeyExistence(names: string[]): Promise<Record<string, boolean>> {
    const creds = this.readCredentialsFile();
    const result: Record<string, boolean> = {};
    for (const name of names) {
      const key = (await this.secrets?.get(`errAnalyst:apiKey:${name}`)) || creds[name];
      result[name] = !!key;
    }
    return result;
  }

  async getActiveProvider(): Promise<LlmProviderConfig | undefined> {
    const providers = this.getProviders();
    const activeName = vscode.workspace.getConfiguration('errAnalyst')
      .get<string>('activeProvider', '');
    for (const p of providers) {
      if (p.name === activeName && p.enabled) {
        const apiKey = await this.getApiKey(p.name);
        if (apiKey) {
          this.warnInvalidPresetModel(p);
          return { ...p, apiKey };
        }
      }
    }
    return undefined;
  }

  /** 读取时校验：预置提供商模型不在官方列表/已下线时，警告一次但不阻断分析。 */
  private warnInvalidPresetModel(p: LlmProviderConfig): void {
    if (getPresetModelList(p.name).length === 0) return;
    const key = `${p.name}:${p.model}`;
    if (this.warnedModels.has(key)) return;
    this.warnedModels.add(key);
    const status = getModelStatus(p.name, p.model);
    if (status === 'valid') return;
    if (status === 'deprecated') {
      const info = getDeprecationInfo(p.name, p.model);
      void vscode.window.showWarningMessage(
        `ErrAnalyst: 模型 ${p.model} 已下线/即将下线${info?.deprecatedAt ? `（${info.deprecatedAt}）` : ''}` +
        `${info?.migrateTo ? `，建议迁移到 ${info.migrateTo}` : ''}。可在配置向导或 erranalyst provider set 中修改。`
      );
      return;
    }
    void vscode.window.showWarningMessage(
      `ErrAnalyst: 模型 "${p.model}" 不在 ${p.name} 官方模型列表，可能写错或已下线。` +
      `可用配置向导或 erranalyst provider set 修正，或改用自定义提供商。`
    );
  }

  async saveProviderConfig(
    provider: { name: string; baseUrl: string; model: string; modelStatus?: CustomModelStatus },
    apiKey: string | null,
    prefs: { enableCache: boolean },
    activeProvider: string
  ): Promise<void> {
    const config = vscode.workspace.getConfiguration('errAnalyst');
    // 仅在用户输入了新 Key 时覆盖；null/空字符串表示保留原 Key。
    if (this.secrets && apiKey) {
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
      modelStatus: provider.modelStatus,
    };
    if (existingIdx >= 0) {
      providers[existingIdx] = { ...providers[existingIdx], ...entry };
    } else {
      providers.push(entry);
    }
    await config.update('providers', providers, vscode.ConfigurationTarget.Global);
    await config.update('activeProvider', activeProvider, vscode.ConfigurationTarget.Global);
    await config.update('enableCache', prefs.enableCache, vscode.ConfigurationTarget.Global);

    // Sync API key to ~/.errAnalyst/credentials.json for CLI access
    if (apiKey) {
      this.writeCredentialsEntry(provider.name, apiKey);
    }
  }

  /** 批量保存自定义提供商：保留预置提供商，更新/新增/删除自定义条目，并处理各自 Key。 */
  async saveCustomProviders(
    entries: Array<{
      name: string;
      baseUrl: string;
      model: string;
      apiKey: string | null;
      modelStatus?: CustomModelStatus;
      /** 加载时的原始名称；改名且未输入新 Key 时，把旧名称下的 Key 迁移过来。 */
      originalName?: string;
    }>,
    activeProvider: string,
    prefs: { enableCache: boolean }
  ): Promise<void> {
    const config = vscode.workspace.getConfiguration('errAnalyst');
    // '自定义' 只是向导卡片名，不是真实提供商名。
    const presetNames = new Set(
      PRESET_PROVIDERS.filter(p => p.name !== '自定义').map(p => p.name)
    );
    const providers = config.get<LlmProviderConfig[]>('providers', []);
    const entriesByName = new Map(entries.map(e => [e.name, e]));

    const nextProviders: LlmProviderConfig[] = [];
    for (const p of providers) {
      if (presetNames.has(p.name)) {
        nextProviders.push(p);
        continue;
      }
      const entry = entriesByName.get(p.name);
      if (entry) {
        nextProviders.push({
          name: entry.name,
          baseUrl: entry.baseUrl,
          model: entry.model,
          apiKey: '',
          enabled: p.enabled,
          modelStatus: entry.modelStatus,
        });
      }
    }
    const existingNames = new Set(nextProviders.map(p => p.name));
    for (const entry of entries) {
      if (!existingNames.has(entry.name)) {
        nextProviders.push({
          name: entry.name,
          baseUrl: entry.baseUrl,
          model: entry.model,
          apiKey: '',
          enabled: true,
          modelStatus: entry.modelStatus,
        });
        existingNames.add(entry.name);
      }
    }

    await config.update('providers', nextProviders, vscode.ConfigurationTarget.Global);

    // 1) 写入新 Key；改名未输入新 Key 时迁移旧 Key；2) 删除被移除条目的 Key。
    const beforeNames = new Set(
      providers.filter(p => !presetNames.has(p.name)).map(p => p.name)
    );
    const afterNames = new Set(entries.map(e => e.name));
    for (const entry of entries) {
      const oldName = entry.originalName && entry.originalName !== entry.name
        ? entry.originalName
        : undefined;
      if (entry.apiKey) {
        await this.secrets?.store(`errAnalyst:apiKey:${entry.name}`, entry.apiKey);
        this.writeCredentialsEntry(entry.name, entry.apiKey);
        if (oldName) {
          await this.secrets?.delete(`errAnalyst:apiKey:${oldName}`);
          this.deleteCredentialsEntry(oldName);
        }
      } else if (oldName) {
        const key = await this.getApiKey(oldName);
        if (key) {
          await this.secrets?.store(`errAnalyst:apiKey:${entry.name}`, key);
          this.writeCredentialsEntry(entry.name, key);
        }
      }
    }
    for (const removed of beforeNames) {
      if (!afterNames.has(removed)) {
        await this.secrets?.delete(`errAnalyst:apiKey:${removed}`);
        this.deleteCredentialsEntry(removed);
      }
    }

    // 激活提供商回退：被删除的激活项不存在时，落到剩余第一个提供商。
    const finalNames = nextProviders.map(p => p.name);
    const nextActive = finalNames.includes(activeProvider)
      ? activeProvider
      : (finalNames[0] || '');
    await config.update('activeProvider', nextActive, vscode.ConfigurationTarget.Global);
    await config.update('enableCache', prefs.enableCache, vscode.ConfigurationTarget.Global);
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

  getMemoryEnabled(): boolean {
    return vscode.workspace.getConfiguration('errAnalyst')
      .get<boolean>('memory.enabled', true);
  }

  private readCredentialsFile(): Record<string, string> {
    try {
      const credFile = path.join(os.homedir(), '.errAnalyst', 'credentials.json');
      if (fs.existsSync(credFile)) {
        return JSON.parse(fs.readFileSync(credFile, 'utf-8')) as Record<string, string>;
      }
    } catch { }
    return {};
  }

  private writeCredentialsEntry(name: string, apiKey: string): void {
    try {
      const credDir = path.join(os.homedir(), '.errAnalyst');
      const credFile = path.join(credDir, 'credentials.json');
      if (!fs.existsSync(credDir)) fs.mkdirSync(credDir, { recursive: true });
      const creds = this.readCredentialsFile();
      creds[name] = apiKey;
      fs.writeFileSync(credFile, JSON.stringify(creds, null, 2));
    } catch (e) {
      console.error('ErrAnalyst: Failed to write credentials file for CLI:', e);
    }
  }

  private deleteCredentialsEntry(name: string): void {
    try {
      const credFile = path.join(os.homedir(), '.errAnalyst', 'credentials.json');
      const creds = this.readCredentialsFile();
      if (name in creds) {
        delete creds[name];
        fs.writeFileSync(credFile, JSON.stringify(creds, null, 2));
      }
    } catch (e) {
      console.error('ErrAnalyst: Failed to update credentials file for CLI:', e);
    }
  }
}
