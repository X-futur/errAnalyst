import * as vscode from 'vscode';
import { Config } from './config';
import { PRESET_PROVIDERS } from './presets';
import {
  getActiveModels,
  getModelStatus,
  getPresetModelList,
  getRecommendedModel,
} from './shared/model-catalog';
import { validateCustomModel, modelStatusLabel } from './shared/model-validation';
import type { CustomModelStatus } from './shared/model-validation';
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
        model = getRecommendedModel(name);
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

    // Model 选择：预置提供商从官方列表选（推荐置顶）；自定义提供商手动输入后校验。
    let modelStatus: CustomModelStatus | undefined;
    const isPreset = getPresetModelList(name).length > 0;
    if (isPreset) {
      const picked = await this.pickPresetModel(name, model);
      if (picked === null) {
        if (!this.isValidPresetModel(name, model)) return;
      } else {
        model = picked;
      }
    } else {
      const validation = await this.validateCustomModelInput(name, baseUrl, model, finalKey);
      if (!validation) return;
      modelStatus = validation.status;
    }

    await Config.getInstance().saveProviderConfig(
      { name, baseUrl, model, modelStatus },
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
      const isPreset = getPresetModelList(p.name).length > 0;
      const presetStatus = isPreset ? getModelStatus(p.name, p.model) : null;
      const statusLabel = isPreset
        ? (presetStatus === 'valid'
            ? '官方模型'
            : presetStatus === 'deprecated'
              ? '已下线/即将下线'
              : '无效模型（不在官方列表）')
        : (p.modelStatus ? modelStatusLabel(p.modelStatus) : '未校验');
      output.providers.push({
        name: p.name,
        baseUrl: p.baseUrl,
        model: p.model,
        apiKey: apiKey ? this.maskApiKey(apiKey) : '(未设置)',
        enabled: p.enabled,
        isActive: p.name === activeProvider,
        modelStatus: statusLabel,
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

    const provider = providers.find(p => p.name === selected.label);
    if (!provider) return;
    const currentModel = provider.model || '';
    const isPreset = getPresetModelList(provider.name).length > 0;
    let model: string;
    let modelStatus: CustomModelStatus | undefined;

    if (isPreset) {
      const picked = await this.pickPresetModel(provider.name, currentModel);
      if (picked === null) {
        if (!this.isValidPresetModel(provider.name, currentModel)) return;
        model = currentModel;
      } else {
        model = picked;
      }
    } else {
      const input = await vscode.window.showInputBox({
        prompt: `输入 ${provider.name} 的新模型名称`,
        value: currentModel,
        placeHolder: 'model-name',
        validateInput: (v) => v.trim() ? null : '模型名称不能为空',
      });
      if (!input) return;
      model = input.trim();
      const apiKey = await Config.getInstance().getApiKey(provider.name);
      const validation = await this.validateCustomModelInput(provider.name, provider.baseUrl, model, apiKey);
      if (!validation) return;
      modelStatus = validation.status;
    }

    const allProviders = Config.getInstance().getProviders();
    const idx = allProviders.findIndex(p => p.name === selected.label);
    if (idx >= 0) {
      allProviders[idx] = {
        ...allProviders[idx],
        model,
        ...(modelStatus ? { modelStatus } : {}),
      };
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

  // ── Private: 模型选择与校验 ──

  private isValidPresetModel(providerName: string, model: string): boolean {
    return getModelStatus(providerName, model) === 'valid';
  }

  /** 预置提供商模型选择：官方列表内 QuickPick，推荐模型置顶；返回 null 表示取消。 */
  private async pickPresetModel(
    providerName: string,
    currentModel: string
  ): Promise<string | null> {
    const models = getActiveModels(providerName);
    if (models.length === 0) return null;
    const currentValid = models.some(m => m.id === currentModel);
    const tierLabels: Record<string, string> = { fast: '⚡ 快速', balanced: '均衡', strong: '更强' };
    const choices = models
      .slice()
      .sort((a, b) => Number(b.recommended) - Number(a.recommended))
      .map(m => {
        const label = (m.recommended ? '⚡ 推荐 · ' : '') + m.id + (m.id === currentModel ? '  (当前)' : '');
        return {
          id: m.id,
          item: {
            label,
            description: tierLabels[m.tier] || '',
            detail: m.description,
            picked: m.id === currentModel,
          } as vscode.QuickPickItem,
        };
      });
    const picked = await vscode.window.showQuickPick(choices.map(c => c.item), {
      placeHolder: currentValid
        ? `为 ${providerName} 选择模型（推荐：${getRecommendedModel(providerName)}）`
        : `当前模型 ${currentModel} 不在官方模型列表，请重新选择`,
      matchOnDescription: true,
    });
    if (!picked) return null;
    return choices.find(c => c.item === picked)?.id ?? null;
  }

  /** 自定义提供商模型校验：抓取 /models，失败回退连接测试；非官方模型需用户确认。返回 null 表示取消/失败。 */
  private async validateCustomModelInput(
    name: string,
    baseUrl: string,
    model: string,
    apiKey: string | undefined
  ): Promise<{ status: CustomModelStatus } | null> {
    if (!apiKey) {
      vscode.window.showErrorMessage(`无法校验 ${name} 的模型：缺少 API Key`);
      return null;
    }
    const result = await validateCustomModel(baseUrl, model, apiKey);
    if (!result.ok) {
      vscode.window.showErrorMessage(`模型校验失败：${result.error}`);
      return null;
    }
    if (result.status === 'unofficial') {
      const confirm = await vscode.window.showWarningMessage(
        `模型 "${model}" 不在 ${name} 的官方模型列表，仍要保存？将标记为非官方模型。`,
        { modal: true },
        '仍要保存'
      );
      if (confirm !== '仍要保存') return null;
    } else if (result.status === 'unverified') {
      vscode.window.showWarningMessage(
        `无法获取 ${name} 的官方模型列表，已通过连接测试；模型将标记为"未通过官方列表校验"。`
      );
    }
    return { status: result.status };
  }

  // ── Private ──

  private maskApiKey(key: string): string {
    if (!key) return '(未设置)';
    if (key.length <= 8) return key.slice(0, 2) + '****';
    return key.slice(0, 4) + '****' + key.slice(-4);
  }
}
