import { afterEach, describe, expect, it } from 'vitest';
import { emptyStoryline } from '@the-water/shared';
import { documentChanges, milestoneText } from '@/features/studio/documentPlanPreview';
import { acceptDocumentPlan, documentPlanIssue, listDocumentPlans, proposeDocumentPlan, type DocumentPlanProposal } from '@/db/repos/planProposalsRepo';
import { OutlineDocSchema, defaultRequirements } from '@/novel/types';
import { useTestDb } from '../helpers/testDb';
import { createNovel } from '@/db/repos/novelsRepo';

// TEST fixtures only. These are not real generated outlines or writing-quality results.
const proposal = (): DocumentPlanProposal => ({ id: 'TEST-proposal', label: 'TEST', before: emptyStoryline(), after: emptyStoryline(), meta: {}, baseHash: 'TEST' });
let db: ReturnType<typeof useTestDb> | undefined;
afterEach(() => { db?.raw.close(); db = undefined; });
describe('TEST readable planning preview and empty-outline protection', () => {
  it('TEST renders chapter and localized stage names for author review',()=>{
    const text=milestoneText({chapterNo:45,kind:'progress',detail:'TEST clue'});
    expect(text).toContain('45');expect(text).toContain('TEST clue');expect(text).not.toContain('progress');
    expect(milestoneText({chapterNo:45,kind:'unknown',detail:'TEST clue'})).toBeNull();
  });
  it('shows logline, themes, and named story changes instead of raw identifiers', () => {
    const p = proposal();
    p.meta.logline = 'TEST-new-logline';
    p.after.themes = ['TEST-theme'];
    p.after.characters = [{ id: 'TEST-hidden-id', name: 'TEST-name', aliases: [], role: 'TEST-role', description: 'TEST-description', arc: '', relationships: [], speechSamples: [], verbalTics: [], addressBook: {}, redlines: [] }];
    const changes = documentChanges(p, { title: 'TEST-title', logline: 'TEST-old-logline' });
    expect(changes.find(c => c.after === 'TEST-new-logline')?.before).toBe('TEST-old-logline');
    expect(changes.some(c => c.after === 'TEST-theme')).toBe(true);
    expect(changes.some(c => c.after.includes('TEST-name'))).toBe(true);
    expect(JSON.stringify(changes)).not.toContain('TEST-hidden-id');
  });
  it('marks an empty brief honestly instead of presenting JSON defaults as generated content', () => {
    const p = proposal();
    p.cards = [{ id: 'TEST-brief', revision: 0, before: null, after: { kind: 'brief', data: { premise: '', mainline: '', ending: '', audience: '', constraints: [], rollingChapters: 5 } } }];
    const changes = documentChanges(p, { title: 'TEST', logline: '' });
    expect(changes).toHaveLength(1);
    expect(changes[0]?.empty).toBe(true);
    expect(changes[0]?.after).not.toContain('rollingChapters');
    expect(changes[0]?.after).not.toContain('{');
    p.meta = { outlineDone: true, logline: 'TEST logline' };
    expect(documentPlanIssue(p)).toContain('创作简报为空');
    expect(OutlineDocSchema.safeParse({ logline: 'TEST logline', writing: { brief: p.cards[0]!.after.data, volumes: [], intents: [] } }).success).toBe(false);
  });
  it('rejects empty generated outlines before persistence, including missing loglines', () => {
    expect(OutlineDocSchema.safeParse({ title: '', logline: '   ', themes: [], characters: [], settings: [], arcs: [], beats: [] }).success).toBe(false);
    expect(OutlineDocSchema.safeParse({}).success).toBe(false);
  });
  it('keeps legacy empty proposals pending and refuses adoption without altering data', async () => {
    db = useTestDb();
    const novel = await createNovel({ title: 'TEST protected novel', premise: 'TEST premise', requirements: defaultRequirements(), targetChars: 1000, status: 'planning' });
    const id = await proposeDocumentPlan(novel.id, emptyStoryline(), 'TEST empty outline', { outlineDone: true, logline: '' });
    const p = (await listDocumentPlans(novel.id))[0]!;
    expect(documentPlanIssue(p)).not.toBeNull();
    await expect(acceptDocumentPlan(novel.id, id)).rejects.toThrow('生成的大纲缺少全书主线');
    expect(await listDocumentPlans(novel.id)).toHaveLength(1);
  });
});

it('TEST shows retired materials as a readable removal without losing their original data',()=>{
  const p=proposal();p.retiredCards=[{id:'TEST private id',revision:1,before:{kind:'volume',data:{title:'TEST obsolete volume',summary:'TEST obsolete motive',startChapterNo:1,endChapterNo:1,arcIds:[]}}}];
  const changes=documentChanges(p,{title:'TEST',logline:''});expect(changes).toHaveLength(1);expect(changes[0]?.before).toContain('TEST obsolete motive');expect(changes[0]?.after).toBe('');expect(JSON.stringify(changes)).not.toContain('TEST private id');
});
