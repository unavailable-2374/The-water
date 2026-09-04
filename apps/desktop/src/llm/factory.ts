import type { FetchLike, JsonMode, LLMProvider, ProviderConfig, ProviderKind } from './types';
import { OpenAICompatibleProvider } from './openaiCompatible';
import { AnthropicProvider } from './anthropic';

export type PresetId = 'deepseek' | 'qwen' | 'kimi' | 'openai' | 'anthropic';

/** 预设里某个模型的权威参数：上下文窗口与单次输出上限由模型决定，不该让用户手填。 */
export interface PresetModel {
  model: string;
  /** 下拉里展示的名字，缺省用 model。 */
  label?: string;
  contextWindow: number;
  maxOutputTokens: number;
}

export interface ProviderPreset {
  id: PresetId;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  /** 默认模型，等于 `models[0].model`。 */
  model: string;
  /** 默认模型的上下文窗口，等于 `models[0].contextWindow`。 */
  contextWindow: number;
  /** 默认模型的输出上限，等于 `models[0].maxOutputTokens`。 */
  maxOutputTokens: number;
  jsonMode: JsonMode;
  envVar?: string;
  /** 该供应商可选模型的权威参数表，第一项为默认。 */
  models: PresetModel[];
  /**
   * true 表示 contextWindow / maxOutputTokens 由所选模型决定：
   * UI 应自动填入并禁用手填，标注「按模型自动」。
   * 自定义（非预设）供应商没有权威值，仍然手填。
   */
  lockContextWindow: boolean;
  /** 获取 API Key 的页面，首启向导里给「去申请」链接用。 */
  apiKeyUrl?: string;
}

/** 预设条目的声明形式：只写 models，默认值从第一项推出来。 */
type PresetSpec = Omit<ProviderPreset, 'model' | 'contextWindow' | 'maxOutputTokens' | 'lockContextWindow'> & {
  lockContextWindow?: boolean;
};

function preset(spec: PresetSpec): ProviderPreset {
  const first = spec.models[0]!;
  return {
    ...spec,
    model: first.model,
    contextWindow: first.contextWindow,
    maxOutputTokens: first.maxOutputTokens,
    lockContextWindow: spec.lockContextWindow ?? true,
  };
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  preset({
    id: 'deepseek',
    name: 'DeepSeek',
    kind: 'openai_compatible',
    baseUrl: 'https://api.deepseek.com',
    jsonMode: 'json_object',
    envVar: 'DEEPSEEK_API_KEY',
    apiKeyUrl: 'https://platform.deepseek.com/api_keys',
    models: [
      { model: 'deepseek-chat', label: 'deepseek-chat（V3）', contextWindow: 128000, maxOutputTokens: 8192 },
      { model: 'deepseek-reasoner', label: 'deepseek-reasoner（R1）', contextWindow: 128000, maxOutputTokens: 32768 },
    ],
  }),
  preset({
    id: 'qwen',
    name: '通义千问 (DashScope)',
    kind: 'openai_compatible',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    jsonMode: 'json_object',
    envVar: 'DASHSCOPE_API_KEY',
    apiKeyUrl: 'https://bailian.console.aliyun.com/?apiKey=1',
    models: [
      { model: 'qwen-plus', contextWindow: 131072, maxOutputTokens: 8192 },
      { model: 'qwen-max', contextWindow: 32768, maxOutputTokens: 8192 },
      { model: 'qwen-turbo', contextWindow: 1000000, maxOutputTokens: 8192 },
    ],
  }),
  preset({
    id: 'kimi',
    name: 'Kimi (Moonshot)',
    kind: 'openai_compatible',
    baseUrl: 'https://api.moonshot.cn/v1',
    jsonMode: 'json_object',
    envVar: 'MOONSHOT_API_KEY',
    apiKeyUrl: 'https://platform.moonshot.cn/console/api-keys',
    models: [
      { model: 'kimi-k2-0711-preview', label: 'kimi-k2', contextWindow: 131072, maxOutputTokens: 8192 },
      { model: 'moonshot-v1-128k', contextWindow: 131072, maxOutputTokens: 8192 },
      { model: 'moonshot-v1-32k', contextWindow: 32768, maxOutputTokens: 8192 },
    ],
  }),
  preset({
    id: 'openai',
    name: 'OpenAI',
    kind: 'openai_compatible',
    baseUrl: 'https://api.openai.com/v1',
    jsonMode: 'json_schema',
    envVar: 'OPENAI_API_KEY',
    apiKeyUrl: 'https://platform.openai.com/api-keys',
    models: [
      { model: 'gpt-4.1', contextWindow: 1000000, maxOutputTokens: 32768 },
      { model: 'gpt-4.1-mini', contextWindow: 1000000, maxOutputTokens: 32768 },
      { model: 'gpt-4o', contextWindow: 128000, maxOutputTokens: 16384 },
    ],
  }),
  preset({
    id: 'anthropic',
    name: 'Anthropic',
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    jsonMode: 'tool',
    envVar: 'ANTHROPIC_API_KEY',
    apiKeyUrl: 'https://console.anthropic.com/settings/keys',
    models: [
      { model: 'claude-sonnet-4-5', contextWindow: 200000, maxOutputTokens: 16000 },
      { model: 'claude-haiku-4-5', contextWindow: 200000, maxOutputTokens: 16000 },
    ],
  }),
];

export function getPreset(id: PresetId): ProviderPreset {
  const preset = PROVIDER_PRESETS.find((p) => p.id === id);
  if (!preset) throw new Error(`Unknown provider preset: ${id}`);
  return preset;
}

/** 按模型名找回它所属的预设（编辑已有供应商时用来判断能否锁定 contextWindow）。 */
export function findPresetForModel(model: string): ProviderPreset | undefined {
  const m = model.trim();
  return PROVIDER_PRESETS.find((p) => p.models.some((x) => x.model === m));
}

/**
 * 某个模型的权威上下文参数；不认识的模型返回 null，UI 此时回落到手填。
 * `presetId` 省略时在所有预设里找。
 */
export function modelParams(model: string, presetId?: PresetId): PresetModel | null {
  const m = model.trim();
  const scope = presetId ? [getPreset(presetId)] : PROVIDER_PRESETS;
  for (const p of scope) {
    const hit = p.models.find((x) => x.model === m);
    if (hit) return hit;
  }
  return null;
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
