import { requestJson, schemaReserveTokens } from '@/llm/json';
import { estimateMessagesTokens } from '@/llm/tokens';
import { UNTRUSTED_GUARD_RULE, wrapUntrusted } from '@/llm/prompts/untrusted';
import { providersForPurposes } from '@/jobs/runner';
import { recordUsage } from '@/db/repos/usageRepo';
import { LLMError } from '@/llm/types';
import type { StepProviderMap } from '@/jobs/purposes';
import { stylePresets } from './stylePresets';
import { WizardSuggestionSchema, wizardSourceKey, WIZARD_GENRES, WIZARD_POVS, type WizardSource } from './wizardSuggestions';

/** Before a novel exists: resolve the planning model and account for the real call. */
export async function suggestWizardRequirements(source: WizardSource, providerIds: StepProviderMap, signal: AbortSignal) {
  if (!source.premise.trim()) throw new Error('请先填写故事前提 / 框架');
  const provider = (await providersForPurposes({ params: { providerIds }, providerId: null }, ['planning'])).planning!;
  const messages = [
    { role: 'system' as const, content: `你是小说创作编辑。根据作者的故事前提、框架和明确要求，建议题材、视角、文风预设、补充风格、基调、受众和时态的默认值。这些是可修改的编辑建议，不是故事事实。不得增添情节、结局或改变作者要求；未指定受众时建议适合内容的读者。style 只补充预设，不重复或冲突；预设不适合时 presetId 留空。reason 简短说明选择依据，使用作者要求的语言。只返回 JSON。${UNTRUSTED_GUARD_RULE}` },
    { role: 'user' as const, content: `${wrapUntrusted('作者材料', wizardSourceKey(source))}\n可用题材：${JSON.stringify(WIZARD_GENRES)}\n可用视角：${JSON.stringify(WIZARD_POVS)}\n可用预设：${JSON.stringify(stylePresets().map(p => ({ id: p.id, name: p.name, narrator: p.voice.narrator.text, constraints: p.injection.humanReadableConstraints })))}` },
  ];
  const maxTokens = Math.min(2500, provider.caps.maxOutputTokens - (provider.caps.reasoningTokens ?? 0));
  if (estimateMessagesTokens(messages, provider.caps.cjkTokenRatio) + schemaReserveTokens(WizardSuggestionSchema, provider.caps) + maxTokens + (provider.caps.reasoningTokens ?? 0) + 1500 > provider.caps.contextWindow) throw new Error('故事框架超出模型窗口，请缩短材料或选择更大窗口的规划模型');
  const account = (usage: { inputTokens: number; outputTokens: number }) => recordUsage({ usage, purpose: 'planning', model: provider.model, providerKind: provider.kind, providerId: provider.id });
  try {
    const result = await requestJson(provider, { messages, schema: WizardSuggestionSchema, temperature: 0.3, maxTokens, label: '创作参数建议' }, { signal });
    await account(result.usage);
    return result.value;
  } catch (error) {
    if (error instanceof LLMError && error.usage) await account(error.usage);
    throw error;
  }
}
