import { canonicalJson, sha256Hex } from '@the-water/shared';
import type { WizardInput } from './service';

/** Explicit creation inputs only. Never infer author intent from generated or adopted plans. */
export function storyOptionAuthorInput(input: WizardInput) {
  return { title: input.title, premise: input.premise, requirements: input.requirements, targetChars: input.targetChars };
}
export async function storyOptionInputHash(input: WizardInput, authorMaterials = '') {
  return sha256Hex(canonicalJson({ authorInput: storyOptionAuthorInput(input), authorMaterials }));
}
export const INDEPENDENT_OPTIONS_VERSION = 2;
