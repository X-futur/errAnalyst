export interface ProviderPreset {
  name: string;
  baseUrl: string;
  model: string;
  icon: string;
  description: string;
}

export const PRESET_PROVIDERS: ProviderPreset[] = [
  { name: 'DeepSeek',        baseUrl: 'https://api.deepseek.com/v1',                           model: 'deepseek-v4-pro', icon: '🔵', description: '性价比高的通用模型' },
  { name: 'Kimi (Moonshot)', baseUrl: 'https://api.moonshot.cn/v1',                            model: 'moonshot-v1-8k',  icon: '🟣', description: '长上下文推理能力强' },
  { name: 'Qwen (通义千问)',  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',     model: 'qwen-turbo',      icon: '🟠', description: '阿里云通义千问大模型' },
  { name: '自定义',           baseUrl: '',                                                       model: '',               icon: '⚙️', description: '接入任意 OpenAI 兼容 API' },
];
