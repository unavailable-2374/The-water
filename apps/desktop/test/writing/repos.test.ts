import { beforeEach, describe, expect, it } from 'vitest';
import { useTestDb } from '../helpers/testDb';
import { emptyBible, emptyDerivative, emptyStyleProfile, emptyStoryline, emptyVoice } from '@the-water/shared';
import { createNovel } from '@/db/repos/novelsRepo';
import { buildStorylineDoc, getStyleExtras, listCharacters, listSettings, replaceStorylineRows, setDerivative, setStyleProfile, upsertCharacter, upsertSetting } from '@/db/repos/storylineRepo';
import { createVersion, upsertChapterPlan } from '@/db/repos/chaptersRepo';
import { latestReviewForChapter, saveReview, reviewForVersion, findReviewByStep, ChapterReviewJsonSchema } from '@/db/repos/reviewsRepo';
import { listFeedback, promotePending, recordUserEdit } from '@/db/repos/feedbackRepo';
import { createJob, listSteps } from '@/db/repos/jobsRepo';
import { defaultRequirements } from '@/novel/types';
import { planGenerate, planRewrite, planStyleCheck } from '@/jobs/planner';
import { saveBible } from '@/db/repos/bibleRepo';

beforeEach(() => { useTestDb(); });

describe('storyline rows carry voice / lore / style / derivative', () => {
  it('round-trips new character and setting fields', async () => {
    const n = await createNovel({ title: 't', premise: '', requirements: defaultRequirements(), targetChars: 0 });
    await upsertCharacter(n.id, { id: 'c1', name: '沈默', speechSamples: ['你来了。'], verbalTics: ['罢了'], addressBook: { 自称: '在下' }, redlines: ['不认错'] });
    await upsertSetting(n.id, { id: 's1', name: '递刀礼', kind: 'rule', description: 'x', triggerKeys: ['递刀'], priority: 90, constant: true });
    const [c] = await listCharacters(n.id);
    expect(c).toMatchObject({ speechSamples: ['你来了。'], verbalTics: ['罢了'], addressBook: { 自称: '在下' }, redlines: ['不认错'] });
    const [s] = await listSettings(n.id);
    expect(s).toMatchObject({ triggerKeys: ['递刀'], priority: 90, constant: true });
    // legacy rows (no voice) still get defaults
    await upsertCharacter(n.id, { id: 'c2', name: '老' });
    expect((await listCharacters(n.id))[1]).toMatchObject(emptyVoice());
  });
  it('style profile and derivative live on the novel row and flow into the StorylineDoc', async () => {
    const n = await createNovel({ title: 't', premise: 'p', requirements: defaultRequirements(), targetChars: 0 });
    expect(await getStyleExtras(n.id)).toEqual({ styleProfile: null, derivative: null });
    const p = emptyStyleProfile({ id: 'sp', name: '江湖' });
    await setStyleProfile(n.id, p);
    await setDerivative(n.id, { ...emptyDerivative(), kind: 'au' });
    const doc = await buildStorylineDoc(n.id, 'p', []);
    expect(doc.styleProfile?.name).toBe('江湖');
    expect(doc.derivative?.kind).toBe('au');
    // replaceStorylineRows from a doc (fork/import) writes them too
    const n2 = await createNovel({ title: 't2', premise: 'p', requirements: defaultRequirements(), targetChars: 0 });
    await replaceStorylineRows(n2.id, { ...emptyStoryline(), styleProfile: p, derivative: { ...emptyDerivative(), kind: 'sequel' } });
    expect((await getStyleExtras(n2.id)).derivative?.kind).toBe('sequel');
    await setStyleProfile(n.id, null);
    expect((await getStyleExtras(n.id)).styleProfile).toBeNull();
  });
});

describe('chapter reviews', () => {
  it('saves and finds reviews by chapter / version / step', async () => {
    const n = await createNovel({ title: 't', premise: '', requirements: defaultRequirements(), targetChars: 0 });
    const ch = await upsertChapterPlan(n.id, { chapterNo: 1 });
    const v = await createVersion({ chapterId: ch.id, content: '正文', source: 'generated' });
    const report = ChapterReviewJsonSchema.parse({ metricScore: 80, aiTellScore: 90 });
    const r = await saveReview({ novelId: n.id, chapterId: ch.id, chapterVersionId: v.id, styleScore: 77.6, oocCount: 1, verdict: 'revise', report, jobStepId: 'step1' });
    expect(r.styleScore).toBe(78);
    expect((await latestReviewForChapter(ch.id))!.id).toBe(r.id);
    expect((await reviewForVersion(v.id))!.verdict).toBe('revise');
    expect((await findReviewByStep('step1'))!.report.metricScore).toBe(80);
    expect(await findReviewByStep('nope')).toBeNull();
  });
});

describe('learning layer (style_feedback)', () => {
  it('accumulates deleted phrases and promotes them into the profile at the threshold', async () => {
    const n = await createNovel({ title: 't', premise: '', requirements: defaultRequirements(), targetChars: 0 });
    const ai = '他嘴角微微勾起，转身离开。';
    const first = await recordUserEdit(n.id, ai, '他笑了，转身离开。');
    expect(first).toEqual([]);
    const fb = await listFeedback(n.id);
    expect(fb.some((f) => f.phrase.includes('嘴角微微勾起') && f.count === 1)).toBe(true);
    const second = await recordUserEdit(n.id, ai, '他转身离开。');
    expect(second.some((p) => p.includes('嘴角微微勾起'))).toBe(true);
    const { styleProfile } = await getStyleExtras(n.id);
    expect(styleProfile!.negatives.avoidWordsSoft.list.some((p) => p.includes('嘴角微微勾起'))).toBe(true);
    expect((await listFeedback(n.id)).find((f) => f.phrase.includes('嘴角微微勾起'))!.promoted).toBe(true);
    expect(await promotePending(n.id)).toEqual([]);
  });
});

describe('planner style_check', () => {
  it('inserts style_check between adjust_length and summarize only when asked', async () => {
    const n = await createNovel({ title: 't', premise: '', requirements: defaultRequirements(), targetChars: 0 });
    const ch = await upsertChapterPlan(n.id, { chapterNo: 1 });
    expect(planGenerate([ch]).map((s) => s.kind)).toEqual(['write_chapter', 'adjust_length', 'summarize']);
    expect(planGenerate([ch], { styleCheck: true }).map((s) => s.kind)).toEqual(['write_chapter', 'adjust_length', 'style_check', 'summarize']);
    expect(planRewrite([{ chapter: ch, mode: 'revise', instructions: [] }], { styleCheck: true }).map((s) => s.kind)).toEqual(['rewrite_chapter', 'adjust_length', 'style_check', 'summarize']);
    expect(planStyleCheck(ch)[0]).toMatchObject({ kind: 'style_check', input: { standalone: true } });
    // the rebuilt job_steps table accepts the new kinds
    const job = await createJob({ novelId: n.id, type: 'style_check', params: {}, providerId: null, steps: planStyleCheck(ch) });
    expect((await listSteps(job.id))[0]!.kind).toBe('style_check');
    await saveBible(n.id, 0, emptyBible());
  });
});
