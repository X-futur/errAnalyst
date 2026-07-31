import * as vscode from 'vscode';
import { Config } from './config';
import { PRESET_PROVIDERS } from './presets';

export class ConfigManager {
  private outputChannel: vscode.OutputChannel;

  constructor(private secrets: vscode.SecretStorage) {
    this.outputChannel = vscode.window.createOutputChannel('ErrAnalyst Config');
  }

  dispose(): void {
    this.outputChannel.dispose();
  }

  // ── Command 4: 设置 AI 提供商 ──

  async setProvider(): Promise<void> {
    const providers = Config.getInstance().getProviders();

    // Build Quick Pick items: existing providers + add-new options
    const items: vscode.QuickPickItem[] = [];

    for (const p of providers) {
      const activeName = vscode.workspace.getConfiguration('errAnalyst')
        .get<string>('activeProvider', '');
      items.push({
        label: p.name,
        description: p.model,
        detail: `${p.baseUrl}${p.name === activeName ? '  (当前使用)' : ''}`,
      });
    }

    if (providers.length > 0) {
      items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    }

    // Presets not yet added
    for (const preset of PRESET_PROVIDERS) {
      if (preset.name === '自定义') continue;
      if (providers.some(p => p.name === preset.name)) continue;
      items.push({
        label: `➕ ${preset.name}`,
        description: preset.description,
        detail: `${preset.baseUrl}  |  模型: ${preset.model}`,
      });
    }

    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    items.push({
      label: '➕ 自定义',
      description: '接入任意 OpenAI 兼容 API',
      detail: '需填写 Base URL、Model、API Key',
    });

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: '选择要配置的提供商，或添加新提供商',
      matchOnDescription: true,
    });
    if (!selected) return;

    let name: string;
    let baseUrl: string;
    let model: string;

    if (selected.label.startsWith('➕ ')) {
      const addLabel = selected.label.replace('➕ ', '');
      const preset = PRESET_PROVIDERS.find(p => p.name === addLabel);

      if (preset) {
        name = preset.name;
        baseUrl = preset.baseUrl;
        model = preset.model;
      } else {
        // Custom provider
        const inputName = await vscode.window.showInputBox({
          prompt: '输入提供商名称',
          placeHolder: '例如: MyAI',
          validateInput: (v) => v.trim() ? null : '名称不能为空',
        });
        if (!inputName) return;
        name = inputName;

        const inputUrl = await vscode.window.showInputBox({
          prompt: '输入 API Base URL',
          placeHolder: 'https://api.example.com/v1',
          validateInput: (v) => {
            try { new URL(v); return null; } catch { return 'URL 格式无效'; }
          },
        });
        if (!inputUrl) return;
        baseUrl = inputUrl;

        const inputModel = await vscode.window.showInputBox({
          prompt: '输入模型名称',
          placeHolder: 'model-name',
          validateInput: (v) => v.trim() ? null : '模型名称不能为空',
        });
        if (!inputModel) return;
        model = inputModel;
      }
    } else {
      name = selected.label;
      const existing = providers.find(p => p.name === name);
      baseUrl = existing?.baseUrl || '';
      model = existing?.model || '';
    }

    // API Key
    const existingKey = await this.secrets.get(`errAnalyst:apiKey:${name}`);
    const apiKey = await vscode.window.showInputBox({
      prompt: `输入 ${name} 的 API Key${existingKey ? '（留空则不修改）' : ''}`,
      password: !existingKey,
      placeHolder: existingKey ? '(已配置，留空保持不变)' : 'sk-...',
    });
    if (apiKey === undefined) return;
    const finalKey = apiKey.trim() || existingKey || '';
    if (!finalKey) {
      vscode.window.showWarningMessage('API Key 不能为空');
      return;
    }

    // Model override (for existing providers)
    if (!selected.label.startsWith('➕ ')) {
      const modelInput = await vscode.window.showInputBox({
        prompt: `输入 ${name} 的模型名称（留空则保持不变）`,
        value: model,
        placeHolder: 'model-name',
      });
      if (modelInput === undefined) return;
      if (modelInput.trim()) model = modelInput.trim();
    }

    await Config.getInstance().saveProviderConfig(
      { name, baseUrl, model },
      finalKey,
      { autoAnalyze: Config.getInstance().getAutoAnalyze(), enableCache: Config.getInstance().getEnableCache() },
    );

    vscode.window.showInformationMessage(`✅ 已配置提供商: ${name} (${model})`);
  }

  // ── Command 2: 切换当前使用的提供商 ──

  async setActiveProvider(): Promise<void> {
    const providers = Config.getInstance().getProviders();
    if (providers.length === 0) {
      vscode.window.showWarningMessage('还没有配置任何提供商，请先运行 "ErrAnalyst: 设置 AI 提供商"');
      return;
    }

    const activeName = vscode.workspace.getConfiguration('errAnalyst')
      .get<string>('activeProvider', '');

    const items = providers.map(p => ({
      label: p.name,
      description: `${p.model}  |  ${p.baseUrl}`,
      detail: p.name === activeName ? '当前使用' : '',
    }));

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: '选择要使用的提供商',
    });
    if (!selected) return;

    await vscode.workspace.getConfiguration('errAnalyst')
      .update('activeProvider', selected.label, vscode.ConfigurationTarget.Global);

    vscode.window.showInformationMessage(`✅ 已切换到提供商: ${selected.label}`);
  }

  // ── Command 3: 以 JSON 形式查看当前配置 ──

  async showConfig(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('errAnalyst');
    this.outputChannel.clear();

    this.outputChannel.appendLine('═══════════════════════════════════════');
    this.outputChannel.appendLine('  ErrAnalyst 配置信息');
    this.outputChannel.appendLine('═══════════════════════════════════════');
    this.outputChannel.appendLine('');

    const activeProvider   = cfg.get<string>('activeProvider', '无');
    const autoAnalyze      = cfg.get<boolean>('autoAnalyze', true);
    const enableCache      = cfg.get<boolean>('enableCache', true);
    const aiTimeout        = cfg.get<number>('aiTimeout', 15000);
    const providers        = cfg.get<any[]>('providers', []);

    const output: Record<string, any> = {
      activeProvider,
      autoAnalyze,
      enableCache,
      aiTimeout,
      totalProviders: providers.length,
      providers: [],
    };

    for (const p of providers) {
      const apiKey = await this.secrets.get(`errAnalyst:apiKey:${p.name}`);
      output.providers.push({
        name: p.name,
        baseUrl: p.baseUrl,
        model: p.model,
        apiKey: apiKey ? this.maskApiKey(apiKey) : '(未设置)',
        enabled: p.enabled,
        isActive: p.name === activeProvider,
      });
    }

    this.outputChannel.appendLine(JSON.stringify(output, null, 2));
    this.outputChannel.appendLine('');
    this.outputChannel.appendLine('═══════════════════════════════════════');
    this.outputChannel.show();

    vscode.window.showInformationMessage('配置信息已输出到 Output 面板');
  }

  // ── Command 5: 修改模型名称 ──

  async setModel(): Promise<void> {
    const providers = Config.getInstance().getProviders();
    if (providers.length === 0) {
      vscode.window.showWarningMessage('还没有配置任何提供商');
      return;
    }

    const items = providers.map(p => ({
      label: p.name,
      description: `当前模型: ${p.model}`,
    }));

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: '选择要修改模型的提供商',
    });
    if (!selected) return;

    const currentModel = providers.find(p => p.name === selected.label)?.model || '';
    const model = await vscode.window.showInputBox({
      prompt: `输入 ${selected.label} 的新模型名称`,
      value: currentModel,
      placeHolder: 'model-name',
      validateInput: (v) => v.trim() ? null : '模型名称不能为空',
    });
    if (!model) return;

    const allProviders = Config.getInstance().getProviders();
    const idx = allProviders.findIndex(p => p.name === selected.label);
    if (idx >= 0) {
      allProviders[idx] = { ...allProviders[idx], model };
      await vscode.workspace.getConfiguration('errAnalyst')
        .update('providers', allProviders, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(`✅ 已更新 ${selected.label} 的模型: ${model}`);
    }
  }

  // ── Private ──

  private maskApiKey(key: string): string {
    if (!key) return '(未设置)';
    if (key.length <= 8) return key.slice(0, 2) + '****';
    return key.slice(0, 4) + '****' + key.slice(-4);
  }
}
