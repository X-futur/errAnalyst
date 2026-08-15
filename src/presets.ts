import { getPresetProviders, getRecommendedModel } from './shared/model-catalog';

export interface ProviderPreset {
  name: string;
  baseUrl: string;
  model: string;
  icon: string;
  description: string;
}

const PRESET_META: Record<string, { icon: string; description: string }> = {
  'DeepSeek': { icon: '🔵', description: '性价比高的通用模型' },
  'Kimi (Moonshot)': { icon: '🟣', description: '长上下文推理能力强' },
  'Qwen (通义千问)': { icon: '🟠', description: '阿里云通义千问大模型' },
};

export const PRESET_PROVIDERS: ProviderPreset[] = [
  ...getPresetProviders().map((p) => ({
    name: p.name,
    baseUrl: p.baseUrl,
    model: getRecommendedModel(p.name),
    icon: PRESET_META[p.name]?.icon || '🔮',
    description: PRESET_META[p.name]?.description || '',
  })),
  { name: '自定义', baseUrl: '', model: '', icon: '⚙️', description: '接入任意 OpenAI 兼容 API' },
];
