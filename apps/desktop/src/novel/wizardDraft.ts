import { z } from 'zod';
import { nanoid } from 'nanoid';
import { NovelRequirementsSchema } from './types';
export const WIZARD_DRAFT_KEY = 'studio:createWizardDraft';
const LegacyWizardDraftSchema = z.object({
  version: z.literal(1),
  title: z.string(), premise: z.string(), target: z.number().int().min(1000).max(300000),
  requirements: NovelRequirementsSchema, presetId: z.string(), step: z.number().int().min(0).max(2),
  providerIds: z.partialRecord(z.enum(['writing', 'planning', 'summarize', 'styleReview', 'consistency', 'extractStyle']), z.string().nullable()),
  edited: z.array(z.enum(['genre', 'pov', 'presetId', 'style', 'tone', 'audience', 'tense', 'genrePackIds'])),
  suggestedSource: z.string(), suggestionReason: z.string(),
});
const CurrentWizardDraftSchema = LegacyWizardDraftSchema.extend({ version: z.literal(2), draftId: z.string().min(1), step: z.number().int().min(0).max(3), storySelectionId: z.string().nullable(), storySkipped: z.boolean() });
export const WizardDraftSchema = z.union([LegacyWizardDraftSchema, CurrentWizardDraftSchema]);
export function upgradeWizardDraft(raw: unknown): z.infer<typeof CurrentWizardDraftSchema> {
  const draft = WizardDraftSchema.parse(raw);
  return draft.version === 2 ? draft : { ...draft, version: 2, draftId: nanoid(), step: Math.min(draft.step, 1), storySelectionId: null, storySkipped: false };
}
