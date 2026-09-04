import type { FetchLike, JsonMode, LLMProvider, ProviderConfig, ProviderKind } from './types';
import { OpenAICompatibleProvider } from './openaiCompatible';
import { AnthropicProvider } from './anthropic';

export type PresetId = 'deepseek' | 'qwen' | 'kimi' | 'openai' | 'anthropic';

export interface ProviderPreset {
  id: PresetId;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  contextWindow: number;
  maxOutputTokens: number;
  jsonMode: JsonMode;
  envVar?: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    kind: 'openai_compatible',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    contextWindow: 128000,
    maxOutputTokens: 8192,
    jsonMode: 'json_object',
    envVar: 'DEEPSEEK_API_KEY',
  },
  {
    id: 'qwen',
    name: '通义千问 (DashScope)',
    kind: 'openai_compatible',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    contextWindow: 131072,
    maxOutputTokens: 8192,
    jsonMode: 'json_object',
    envVar: 'DASHSCOPE_API_KEY',
  },
  {
    id: 'kimi',
    name: 'Kimi (Moonshot)',
    kind: 'openai_compatible',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'kimi-k2-0711-preview',
    contextWindow: 131072,
    maxOutputTokens: 8192,
    jsonMode: 'json_object',
    envVar: 'MOONSHOT_API_KEY',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    kind: 'openai_compatible',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4.1',
    contextWindow: 1000000,
    maxOutputTokens: 32768,
    jsonMode: 'json_schema',
    envVar: 'OPENAI_API_KEY',
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-sonnet-4-5',
    contextWindow: 200000,
    maxOutputTokens: 16000,
    jsonMode: 'tool',
    envVar: 'ANTHROPIC_API_KEY',
  },
];

export function getPreset(id: PresetId): ProviderPreset {
  const preset = PROVIDER_PRESETS.find((p) => p.id === id);
  if (!preset) throw new Error(`Unknown provider preset: ${id}`);
  return preset;
}

export function createProvider(config: ProviderConfig, apiKey: string, fetchImpl: FetchLike): LLMProvider {
  switch (config.kind) {
    case 'openai_compatible':
      return new OpenAICompatibleProvider(config, apiKey, fetchImpl);
    case 'anthropic':
      return new AnthropicProvider(config, apiKey, fetchImpl);
    default: {
      const never: never = config.kind;
      throw new Error(`Unsupported provider kind: ${String(never)}`);
    }
  }
}
