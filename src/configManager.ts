import * as vscode from 'vscode';
import { Config } from './config';
import { PRESET_PROVIDERS } from './presets';
import {
  UserMemory,
  CATEGORY_LABELS,
  CATEGORY_OPTIONS,
  SOURCE_LABELS,
} from './storage/userMemory';

export class ConfigManager {
  private outputChannel: vscode.OutputChannel;

  constructor(
    private secrets: vscode.SecretStorage,
    private readonly userMemory: UserMemory,
  ) {
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
      { enableCache: Config.getInstance().getEnableCache() },
      name,
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
    const enableCache      = cfg.get<boolean>('enableCache', true);
    const aiTimeout        = cfg.get<number>('aiTimeout', 15000);
    const providers        = cfg.get<any[]>('providers', []);

    const output: Record<string, any> = {
      activeProvider,
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

  // ── Command 6: 用户记忆管理（erranalyst memory config） ──

  async memoryConfig(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('errAnalyst');
    const enabled = cfg.get<boolean>('memory.enabled', true);
    const stats = this.userMemory.getStats();

    const choice = await vscode.window.showQuickPick([
      { label: '查看记忆条目', description: `${stats.active} 条生效 · ${stats.candidate} 条待确认 · ${stats.errorTypes} 类常犯错误` },
      { label: '新增偏好（显式声明）', description: '修复偏好 / 修复建议偏好 / 错误分析偏好' },
      { label: '编辑或删除条目', description: '修改类别或内容、删除单条' },
      { label: '确认待确认候选', description: '把仅观察 1 次的隐式条目转为生效' },
      { label: enabled ? '关闭长期记忆' : '开启长期记忆', description: enabled ? 'errAnalyst.memory.enabled = false' : 'errAnalyst.memory.enabled = true' },
      { label: '清空全部记忆', description: '删除所有偏好与常犯错误统计' },
    ], { placeHolder: 'ErrAnalyst 用户记忆管理（erranalyst memory config）' });
    if (!choice) return;

    const label = choice.label;
    if (label.startsWith('查看记忆条目')) {
      await this.memoryList();
    } else if (label.startsWith('新增偏好')) {
      await this.memoryAdd();
    } else if (label.startsWith('编辑或删除')) {
      await this.memoryEditDelete();
    } else if (label.startsWith('确认待确认')) {
      await this.memoryConfirmCandidates();
    } else if (label.startsWith('关闭长期记忆') || label.startsWith('开启长期记忆')) {
      await cfg.update('memory.enabled', !enabled, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(enabled ? '已关闭长期记忆' : '已开启长期记忆');
    } else if (label.startsWith('清空全部记忆')) {
      const confirm = await vscode.window.showWarningMessage(
        '确定清空全部长期记忆？此操作不可撤销。',
        { modal: true },
        '清空',
      );
      if (confirm === '清空') {
        this.userMemory.clearAll();
        vscode.window.showInformationMessage('已清空全部长期记忆');
      }
    }
  }

  private async memoryList(): Promise<void> {
    const all = this.userMemory.getAll();
    if (all.length === 0) {
      vscode.window.showInformationMessage('当前没有记忆条目');
      return;
    }
    const items = all.map(p => ({
      label: `${CATEGORY_LABELS[p.category]} · ${p.statement}`,
      description: p.status === 'candidate' ? '待确认' : SOURCE_LABELS[p.source],
      detail: p.source === 'implicit' ? `置信 ${p.confidence.toFixed(1)} · 观察 ${p.hitCount} 次` : '用户声明',
    }));
    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: '记忆条目（选择后返回）',
    });
    if (!selected) return;
    await this.memoryList();
  }

  private async memoryAdd(): Promise<void> {
    const categoryPick = await vscode.window.showQuickPick(
      CATEGORY_OPTIONS.map(o => ({ label: o.label })),
      { placeHolder: '选择偏好类别' },
    );
    if (!categoryPick) return;
    const category = CATEGORY_OPTIONS.find(o => o.label === categoryPick.label)!.value;
    const statement = await vscode.window.showInputBox({
      prompt: `输入${categoryPick.label}内容（一句话）`,
      placeHolder: '例如：倾向于最小改动，不做无关重构',
      validateInput: v => v.trim() ? null : '内容不能为空',
    });
    if (!statement) return;
    this.userMemory.addExplicit(category, statement);
    vscode.window.showInformationMessage('已添加记忆条目（用户声明，立即生效）');
  }

  private async memoryEditDelete(): Promise<void> {
    const all = this.userMemory.getAll();
    if (all.length === 0) {
      vscode.window.showInformationMessage('当前没有可编辑的条目');
      return;
    }
    const items = all.map(p => ({
      label: `${CATEGORY_LABELS[p.category]} · ${p.statement}`,
      description: p.status === 'candidate' ? '待确认' : SOURCE_LABELS[p.source],
      id: p.id,
    }));
    const selected = await vscode.window.showQuickPick(items, { placeHolder: '选择要操作的条目' });
    if (!selected) return;
    const pref = all.find(p => p.id === selected.id)!;
    const action = await vscode.window.showQuickPick([
      { label: '编辑内容', description: pref.statement },
      { label: '修改类别', description: CATEGORY_LABELS[pref.category] },
      { label: '删除该条目', description: '' },
    ], { placeHolder: '选择操作' });
    if (!action) return;
    if (action.label === '删除该条目') {
      this.userMemory.deleteEntry(pref.id);
      vscode.window.showInformationMessage('已删除条目');
    } else if (action.label === '修改类别') {
      const catPick = await vscode.window.showQuickPick(
        CATEGORY_OPTIONS.filter(o => o.value !== pref.category).map(o => ({ label: o.label })),
        { placeHolder: '选择新类别' },
      );
      if (!catPick) return;
      const next = CATEGORY_OPTIONS.find(o => o.label === catPick.label)!.value;
      this.userMemory.updateEntry(pref.id, { category: next });
      vscode.window.showInformationMessage('已更新类别');
    } else {
      const text = await vscode.window.showInputBox({
        prompt: '新的偏好内容',
        value: pref.statement,
        validateInput: v => v.trim() ? null : '内容不能为空',
      });
      if (!text) return;
      this.userMemory.updateEntry(pref.id, { statement: text });
      vscode.window.showInformationMessage('已更新内容');
    }
  }

  private async memoryConfirmCandidates(): Promise<void> {
    const candidates = this.userMemory.getAll().filter(p => p.status === 'candidate');
    if (candidates.length === 0) {
      vscode.window.showInformationMessage('当前没有待确认候选');
      return;
    }
    const items = candidates.map(p => ({
      label: `${CATEGORY_LABELS[p.category]} · ${p.statement}`,
      description: `观察 ${p.hitCount} 次`,
      id: p.id,
    }));
    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: '选择要确认的候选（确认后生效并注入提示词）',
    });
    if (!selected) return;
    this.userMemory.confirmCandidate(selected.id);
    vscode.window.showInformationMessage('候选已确认，开始生效');
  }

  // ── Private ──

  private maskApiKey(key: string): string {
    if (!key) return '(未设置)';
    if (key.length <= 8) return key.slice(0, 2) + '****';
    return key.slice(0, 4) + '****' + key.slice(-4);
  }
}
