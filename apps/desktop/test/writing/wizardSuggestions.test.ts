/** TEST synthetic suggestions exercise validation and author ownership, not AI quality. */
import { describe, expect, it } from 'vitest';
import { defaultRequirements } from '@/novel/types';
import { applyWizardSuggestion, WizardSuggestionSchema, wizardSourceKey, type SuggestedField } from '@/novel/wizardSuggestions';

const suggestion = { genre: '科幻', pov: '第一人称', presetId: 'preset_hardboiled-scifi', style: 'TEST 冷静记录', tone: 'TEST 紧张', audience: 'TEST 成年读者', tense: '现在时', reason: 'TEST 编辑意见' };
describe('TEST wizard suggestions', () => {
  it('fills all seven defaults and derives genre packs without changing author constraints', () => {
    const req = { ...defaultRequirements(), extra: 'TEST 保留结局', mustHave: ['TEST 信件'], taboos: ['TEST 不杀人'] };
    const result = applyWizardSuggestion(req, '', WizardSuggestionSchema.parse(suggestion), new Set());
    for (const field of ['genre', 'pov', 'style', 'tone', 'audience', 'tense'] as const) expect(result.requirements[field]).toBe(suggestion[field]);
    expect(result.presetId).toBe(suggestion.presetId);
    expect(result.requirements.genrePackIds.length).toBeGreaterThan(0);
    expect(result.requirements.extra).toBe(req.extra);
    expect(result.requirements.mustHave).toEqual(req.mustHave);
    expect(req.genre).toBe('');
  });
  it('preserves every author edited field, including cleared values and explicit packs', () => {
    const req = { ...defaultRequirements(), genre: '现实', style: '', tone: '', audience: 'TEST 儿童', genrePackIds: [] };
    const edited = new Set<SuggestedField>(['genre', 'pov', 'style', 'tone', 'audience', 'tense', 'presetId', 'genrePackIds']);
    expect(applyWizardSuggestion(req, '', WizardSuggestionSchema.parse(suggestion), edited)).toEqual({ requirements: req, presetId: '' });
  });
  it('does not invalidate suggestions when generated values change but does when the framework changes', () => {
    const source = { title: 'TEST', premise: 'TEST 框架', requirements: defaultRequirements(), targetChars: 30000 };
    const applied = applyWizardSuggestion(source.requirements, '', WizardSuggestionSchema.parse(suggestion), new Set());
    expect(wizardSourceKey({ ...source, requirements: applied.requirements })).toBe(wizardSourceKey(source));
    for (const changed of [{ ...source, premise: 'TEST 新框架' }, { ...source, targetChars: 10000 }, { ...source, requirements: { ...source.requirements, mustHave: ['TEST 新要求'] } }]) expect(wizardSourceKey(changed)).not.toBe(wizardSourceKey(source));
  });
  it('rejects nonexistent presets, empty answers and invalid controlled options', () => {
    for (const change of [{ presetId: 'FAKE nonexistent' }, { tone: '  ' }, { genre: 'FAKE genre' }, { pov: 'FAKE pov' }]) expect(WizardSuggestionSchema.safeParse({ ...suggestion, ...change }).success).toBe(false);
    expect(WizardSuggestionSchema.safeParse({ ...suggestion, presetId: '' }).success).toBe(true);
  });
});
