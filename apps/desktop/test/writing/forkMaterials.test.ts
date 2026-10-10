/** TEST in-memory public bundle; no network calls or real author data. */
import { beforeEach, expect, it } from 'vitest';
import { useTestDb } from '../helpers/testDb';
import {
  createMaterials,
  emptyBible,
  emptyStoryline,
  emptyStyleProfile,
  emptyVoice,
  hashChapterContent,
  hashStoryline,
  sha256Hex,
  type NovelBundle,
  type MaterialCard,
} from '@the-water/shared';
import { forkToLocal, verifyBundle } from '@/sync/fork';
import type { PublicApi } from '@/sync/api';
import { listWritingCards, listCanonEvents } from '@/db/repos/writingRepo';
import { buildStorylineDoc } from '@/db/repos/storylineRepo';
import { listChapters, listCurrentVersions } from '@/db/repos/chaptersRepo';
import { latestBible } from '@/db/repos/bibleRepo';
import { listNovels } from '@/db/repos/novelsRepo';
import { getDb } from '@/db/db';

beforeEach(() => useTestDb());
async function bundle(v2: boolean): Promise<NovelBundle> {
  const text = 'TEST witnessed event';
  const storyline = {
    ...emptyStoryline(),
    premise: 'TEST fiction',
    styleProfile: emptyStyleProfile({ id: 'TEST-style', name: 'TEST' }),
    characters: [
      {
        ...emptyVoice(),
        id: 'TEST-character',
        name: 'TEST person',
        aliases: [],
        role: 'TEST',
        description: 'TEST',
        arc: '',
        relationships: [],
      },
    ],
    chapters: [
      {
        chapterNo: 1,
        title: 'TEST chapter',
        goal: 'TEST goal',
        povCharacterId: 'TEST-character',
        beatIds: [],
        targetChars: 500,
        endHook: 'TEST',
      },
    ],
  };
  const base = {
    exportedAt: 'TEST export time',
    server: { baseUrl: 'https://test.invalid' },
    novel: {
      id: 'TEST-novel',
      title: 'TEST remote',
      summary: 'TEST',
      tags: [],
      language: 'zh',
      writingStatus: 'completed' as const,
      license: 'cc-by' as const,
      allowDerivatives: true,
      author: { id: 'TEST-author', displayName: 'TEST author' },
    },
    version: {
      id: 'TEST-version',
      versionNumber: 1,
      committedAt: null,
      storylineHash: await hashStoryline(storyline),
      chapterCount: 1,
      charCount: text.length,
    },
    storyline,
    bible: { ...emptyBible(), facts: ['TEST unverified imported summary'] },
    chapters: [{ index: 0, title: 'TEST chapter', hash: await hashChapterContent(text), content: text }],
    lineage: { sourceNovelId: null, sourceVersionId: null, rootNovelId: 'TEST-novel', depth: 0 },
    fork: { id: 'TEST-fork' },
  };
  if (!v2) return { ...base, bundleVersion: 1 };
  const cards: MaterialCard[] = [
    {type:'plan',id:'TEST-thread',chapterNo:null,order:1,card:{kind:'thread',data:{title:'TEST shared thread',setup:'TEST setup',progression:'TEST progress',payoff:'TEST payoff',plannedChapterNo:90,characterIds:['TEST-character'],milestones:[{chapterNo:1,kind:'setup',detail:'TEST question'},{chapterNo:45,kind:'progress',detail:'TEST clue'},{chapterNo:90,kind:'payoff',detail:'TEST answer'}]}}},
    {
      type: 'canon',
      id: 'TEST-event',
      order: 0,
      chapterNo: 1,
      sourceVersionId: 'TEST-source-prose',
      contentHash: await sha256Hex(text),
      event: {
        id: 'TEST-event',
        kind: 'event',
        entityId: 'TEST-character',
        threadId: null,
        text,
        knownBy: ['TEST-character'],
        time: 'TEST time',
        location: 'TEST place',
        dependencyIds: [],
        evidence: { from: 0, to: text.length, quote: text },
      },
    },
    {
      type: 'plan',
      id: 'TEST-scene',
      chapterNo: 1,
      order: 0,
      card: {
        kind: 'scene',
        data: {
          title: 'TEST scene',
          volumeId: null,
          povCharacterId: 'TEST-character',
          time: 'TEST time',
          location: 'TEST place',
          characterIds: ['TEST-character'],
          goal: 'TEST',
          obstacle: 'TEST',
          turn: 'TEST',
          outcome: 'TEST',
          targetChars: 500,
          threadIds: [],
          dependencyIds: [],
        },
      },
    },
  ];
  return { ...base, bundleVersion: 2, creationMaterials: await createMaterials(cards) };
}
function client(value: NovelBundle) {
  return {
    baseUrl: 'https://test.invalid',
    createFork: async () => ({
      fork: { id: 'TEST-fork', sourceVersionId: value.version.id, createdAt: 'TEST time' },
    }),
    getBundle: async () => value,
  } as unknown as PublicApi;
}
it.each([false, true])(
  'TEST V2=%s imports immutable prose, remaps IDs and preserves provenance without certifying imported memory',
  async (v2) => {
    const source = await bundle(v2),
      novel = await forkToLocal(client(source), source.novel.id);
    const doc = await buildStorylineDoc(novel.id, novel.premise, []);
    expect(doc.characters[0]!.id).not.toBe('TEST-character');
    expect(doc.chapters[0]!.povCharacterId).toBe(doc.characters[0]!.id);
    expect((await listCurrentVersions(novel.id))[0]!.version!.content).toBe(source.chapters[0]!.content);
    expect((await listChapters(novel.id))[0]!.memoryStatus).not.toBe('valid');
    expect(await latestBible(novel.id)).toBeNull();
    expect(await listCanonEvents(novel.id, 501)).toEqual([]);
    if (v2) {
      const cards = await listWritingCards(novel.id),
        scene = cards.find((c) => c.kind === 'scene')!;
      expect(scene.id).not.toBe('TEST-scene');
      expect(scene.confirmed).toBe(false);
      if (scene.kind === 'scene') expect(scene.data.characterIds).toEqual([doc.characters[0]!.id]);
      const thread=cards.find(c=>c.kind==='thread')!;
      // Imported planning intent may be inherited; it is still not witnessed canon.
      expect(thread.id).not.toBe('TEST-thread'); expect(thread.confirmed).toBe(true);
      if(thread.kind==='thread') {
        expect(thread.data.characterIds).toEqual([doc.characters[0]!.id]);
        expect(thread.data.milestones?.map(m=>m.chapterNo)).toEqual([1,45,90]);
      }
      const raw = await getDb().select<{ source_version_id: string; json: string }>(
        'SELECT source_version_id,json FROM writing_imports WHERE source_id=?',
        ['TEST-event'],
      );
      expect(raw[0]!.source_version_id).toBe('TEST-version');
      expect(JSON.parse(raw[0]!.json).event.evidence.quote).toBe(source.chapters[0]!.content);
    }
  },
);
it('TEST a corrupted V2 bundle is rejected before creating a local novel', async () => {
  const source = await bundle(true);
  source.chapters[0]!.content += ' TEST tampered';
  await expect(verifyBundle(source)).rejects.toThrow();
  await expect(forkToLocal(client(source), source.novel.id)).rejects.toThrow();
  expect(await listNovels()).toEqual([]);
});
