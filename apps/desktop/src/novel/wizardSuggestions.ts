import { z } from 'zod';
import { stylePresets } from './stylePresets';
import { packIdsForGenre } from './genrePacks';
import type { NovelRequirements } from './types';

export const WIZARD_GENRES = ['都市', '玄幻', '仙侠', '科幻', '悬疑', '历史', '言情', '武侠', '奇幻', '现实', '其他'] as const;
export const WIZARD_POVS = ['第三人称有限', '第一人称', '第三人称全知'] as const;
export const WizardSuggestionSchema = z.object({
  genre: z.enum(WIZARD_GENRES),
  pov: z.enum(WIZARD_POVS),
  presetId: z.string().refine(id => id === '' || stylePresets().some(p => p.id === id), '未知文风预设'),
  style: z.string().trim().min(1).max(500),
  tone: z.string().trim().min(1).max(200),
  audience: z.string().trim().min(1).max(200),
  tense: z.string().trim().min(1).max(100),
  reason: z.string().trim().min(1).max(1000),
});
export type WizardSuggestion = z.infer<typeof WizardSuggestionSchema>;
export type SuggestedField = 'genre' | 'pov' | 'presetId' | 'style' | 'tone' | 'audience' | 'tense' | 'genrePackIds';
export interface WizardSource { title: string; premise: string; requirements: NovelRequirements; targetChars: number }
/** Only author inputs affect freshness; generated defaults never feed back into their own prompt. */
export function wizardSourceKey(source: WizardSource): string {
  const { docType, extra, taboos, mustHave, language } = source.requirements;
  return JSON.stringify({ title: source.title.trim(), premise: source.premise.trim(), docType, extra, taboos, mustHave, language, targetChars: source.targetChars });
}
export function applyWizardSuggestion(req: NovelRequirements, presetId: string, suggestion: WizardSuggestion, edited: ReadonlySet<SuggestedField>) {
  const next = { ...req };
  for (const field of ['genre', 'pov', 'style', 'tone', 'audience', 'tense'] as const) {
    if (!edited.has(field)) next[field] = suggestion[field];
  }
  if (!edited.has('genrePackIds')) next.genrePackIds = packIdsForGenre(next.genre);
  return { requirements: next, presetId: edited.has('presetId') ? presetId : suggestion.presetId };
}
