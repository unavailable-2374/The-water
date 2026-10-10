import { eq } from 'drizzle-orm';
import { novelVersions } from '../src/db/schema';
/** TEST data; protocol validation only, no writing-quality assertions. */
import { describe, it, expect } from 'bun:test';
import {
  createMaterials,
  validateCreationMaterials,
  type MaterialCard,
  NovelBundleSchema,
  emptyStoryGraph,
  graphMaterialCards,
  combineGraphMaterials,
  validateMaterialSources,
  sha256Hex,
} from '@the-water/shared';
import { createNovel, makeChapters, makeTestApp, manifestOf, sampleStoryline } from './helpers';

const card: MaterialCard = {
  type: 'plan',
  id: 'TEST brief',
  chapterNo: null,
  order: 0,
  card: {
    kind: 'brief',
    data: {
      premise: 'TEST premise',
      mainline: 'TEST mainline',
      ending: 'TEST ending',
      audience: 'TEST',
      constraints: [],
      rollingChapters: 5,
    },
  },
};
describe('TEST creation-material protocol', () => {
  it('validates independently hashed blocks; missing, tampered and oversized blocks fail', async () => {
    const materials = await createMaterials([card]);
    expect(await validateCreationMaterials(materials)).toEqual(materials);
    await expect(validateCreationMaterials({ ...materials, blocks: [] })).rejects.toThrow();
    const bad = structuredClone(materials);
    bad.blocks[0]!.card.id = 'TEST changed';
    await expect(validateCreationMaterials(bad)).rejects.toThrow('mismatch');
    const huge = {
      ...card,
      card: {
        kind: 'brief',
        data: {
          premise: 'TEST',
          mainline: 'TEST',
          ending: 'TEST',
          audience: 'TEST',
          constraints: Array(100).fill('TEST'.repeat(3000)),
          rollingChapters: 5,
        },
      },
    };
    await expect(createMaterials([huge as MaterialCard])).rejects.toThrow();
  });
  it('V1 stays V1, opt-in V2 round trips, sharing follows derivative and visibility permissions', async () => {
    const t = makeTestApp(),
      { token } = await t.register('test-materials@example.com');
    expect((await t.json('GET', '/api/v1/capabilities')).body.bundleVersions).toEqual([1, 2]);
    const novel = await createNovel(t, token, {
      title: 'TEST materials',
      license: 'cc-by',
      allowDerivatives: true,
    });
    const chapters = await makeChapters(1),
      materials = await createMaterials([card]);
    const draft = await t.json('POST', `/api/v1/novels/${novel.id}/versions`, {
      token,
      headers: { 'Idempotency-Key': 'TEST-v2' },
      body: {
        storyline: sampleStoryline(),
        bible: null,
        chapters: manifestOf(chapters),
        creationMaterials: materials,
      },
    });
    expect(draft.status).toBe(201);
    await t.json('POST', '/api/v1/blobs', {
      token,
      body: { blobs: chapters.map((c) => ({ hash: c.hash, content: c.content })) },
    });
    const commit = await t.json(
      'POST',
      `/api/v1/novels/${novel.id}/versions/${draft.body.version.id}/commit`,
      { token },
    );
    expect(commit.status).toBe(200);
    const path = `/api/v1/novels/${novel.id}/versions/current/bundle`;
    expect(NovelBundleSchema.parse((await t.json('GET', path)).body).bundleVersion).toBe(1);
    const v2 = NovelBundleSchema.parse((await t.json('GET', path + '?bundleVersion=2')).body);
    expect(v2.bundleVersion).toBe(2);
    if (v2.bundleVersion === 2) expect(v2.creationMaterials).toEqual(materials);
    await t.json('PATCH', `/api/v1/novels/${novel.id}`, { token, body: { allowDerivatives: false } });
    expect((await t.json('GET', path + '?bundleVersion=2')).status).toBe(403);
    expect((await t.json('GET', path + '?bundleVersion=2', { token })).status).toBe(200);
    await t.json('DELETE', `/api/v1/novels/${novel.id}`, { token });
    expect((await t.json('GET', path + '?bundleVersion=2')).status).toBe(404);
  });
  it('rejects missing material blocks before creating a draft', async () => {
    const t = makeTestApp(),
      { token } = await t.register('test-missing@example.com'),
      n = await createNovel(t, token),
      chapters = await makeChapters(1),
      materials = await createMaterials([card]);
    const r = await t.json('POST', `/api/v1/novels/${n.id}/versions`, {
      token,
      headers: { 'Idempotency-Key': 'TEST-missing' },
      body: {
        storyline: sampleStoryline(),
        chapters: manifestOf(chapters),
        creationMaterials: { ...materials, blocks: [] },
      },
    });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toContain('Duplicate or unlisted material block');
  });
});

it('TEST story graph survives server V2 publication; invalid node kinds and temporal cycles fail validation', async () => {
  const t = makeTestApp(), { token } = await t.register('test-story-graph@example.com');
  expect((await t.json('GET', '/api/v1/capabilities')).body.storyGraphVersion).toBe(1);
  const n = await createNovel(t, token, { title: 'TEST story graph' });
  const chapters = await makeChapters(1), source = chapters[0]!;
  const storyline = sampleStoryline('TEST story graph protocol');
  storyline.beats = ['TEST-first', 'TEST-flashback'].map((id, order) => ({ id, title: id, summary: 'TEST', chapterNo: 1, arcId: 'a1', characterIds: ['c1'], settingIds: [], order }));
  const graph = emptyStoryGraph();
  graph.nodes = storyline.beats.map((b, i) => ({ id: b.id, arcId: 'a1', time: { label: 'TEST relative day', start: 0 - i, end: null } }));
  graph.relations = [{ id: 'TEST-prerequisite', from: 'TEST-flashback', to: 'TEST-first', kind: 'before', reason: 'TEST explicit world order', status: 'confirmed' }];
  graph.secrets = [{ id: 'TEST-secret', fact: 'TEST fictional fact', readerAt: 'TEST-first', knowledge: [{ characterId: 'c1', at: 'TEST-flashback', state: 'believes', belief: 'TEST mistaken belief' }] }];
  graph.anchors = [{ id: 'TEST-anchor', nodeId: 'TEST-first', chapterId: 'TEST-local-chapter', versionId: 'TEST-local-version', contentHash: await sha256Hex(source.content), evidence: { from: 0, to: 10, quote: source.content.slice(0, 10) }, interpretation: 'TEST author interpretation', status: 'confirmed' }];
  const materials = await createMaterials(graphMaterialCards(graph, [{ id: 'TEST-local-chapter', chapterNo: 1 }]));
  await validateMaterialSources(materials, chapters, storyline);
  const draft = await t.json('POST', `/api/v1/novels/${n.id}/versions`, { token, headers: { 'Idempotency-Key': 'TEST-graph' }, body: { storyline, chapters: manifestOf(chapters), creationMaterials: materials } });
  expect(draft.status).toBe(201);
  expect((await t.json('POST', '/api/v1/blobs', { token, body: { blobs: [{ hash: source.hash, content: source.content }] } })).status).toBe(200);
  expect((await t.json('POST', `/api/v1/novels/${n.id}/versions/${draft.body.version.id}/commit`, { token })).status).toBe(200);
  const bundle = NovelBundleSchema.parse((await t.json('GET', `/api/v1/novels/${n.id}/versions/current/bundle?bundleVersion=2`, { token })).body);
  expect(bundle.bundleVersion).toBe(2);
  if (bundle.bundleVersion !== 2) throw new Error('TEST expected V2');
  expect(combineGraphMaterials(bundle.creationMaterials.blocks.flatMap(b => b.card.type === 'story_graph' ? [b.card] : []))).toEqual(graph);
  const bad = structuredClone(graph);
  bad.relations[0]!.to = 'c1';
  await expect(validateMaterialSources(await createMaterials(graphMaterialCards(bad, [{ id: 'TEST-local-chapter', chapterNo: 1 }])), chapters, storyline)).rejects.toThrow('场景或情节点');
  bad.relations[0] = { ...graph.relations[0]!, from: 'TEST-first', to: 'TEST-flashback' };
  await expect(validateMaterialSources(await createMaterials(graphMaterialCards(bad, [{ id: 'TEST-local-chapter', chapterNo: 1 }])), chapters, storyline)).rejects.toThrow('循环');
});

it('TEST commit rechecks stored material hashes and idempotency never drops opted-in cards', async () => {
  const t = makeTestApp(),
    { token } = await t.register('test-commit-materials@example.com'),
    n = await createNovel(t, token),
    chapters = await makeChapters(1),
    materials = await createMaterials([card]);
  const request = {
    token,
    headers: { 'Idempotency-Key': 'TEST-stable' },
    body: { storyline: sampleStoryline(), chapters: manifestOf(chapters), creationMaterials: materials },
  };
  const draft = await t.json('POST', `/api/v1/novels/${n.id}/versions`, request);
  expect(draft.status).toBe(201);
  const repeated = await t.json('POST', `/api/v1/novels/${n.id}/versions`, request);
  expect(repeated.body.version.id).toBe(draft.body.version.id);
  const changed = await t.json('POST', `/api/v1/novels/${n.id}/versions`, {
    ...request,
    body: { ...request.body, creationMaterials: undefined },
  });
  expect(changed.status).toBe(409);
  await t.json('POST', '/api/v1/blobs', {
    token,
    body: { blobs: chapters.map((c) => ({ hash: c.hash, content: c.content })) },
  });
  t.deps.db
    .update(novelVersions)
    .set({ creationMaterials: { ...materials, blocks: [] } })
    .where(eq(novelVersions.id, draft.body.version.id))
    .run();
  const commit = await t.json('POST', `/api/v1/novels/${n.id}/versions/${draft.body.version.id}/commit`, {
    token,
  });
  expect(commit.status).toBe(400);
  expect(
    (await t.json('GET', `/api/v1/novels/${n.id}/versions/current/bundle?bundleVersion=2`, { token })).status,
  ).toBe(404);
});

it('TEST canon materials preserve same-chapter dependency order and reject cycles or wrong evidence', async () => {
  const { sha256Hex, validateMaterialSources } = await import('@the-water/shared');
  const text = 'TEST cause. TEST effect.',
    hash = await sha256Hex(text);
  const event = {
    id: 'TEST-cause',
    kind: 'event' as const,
    entityId: null,
    threadId: null,
    text: 'TEST cause',
    knownBy: [],
    time: 'TEST time',
    location: 'TEST location',
    dependencyIds: [] as string[],
    evidence: { from: 0, to: 10, quote: 'TEST cause' },
  };
  const first: MaterialCard = {
    type: 'canon',
    id: event.id,
    chapterNo: 1,
    order: 0,
    sourceVersionId: 'TEST version',
    contentHash: hash,
    event,
  };
  const second: MaterialCard = {
    ...first,
    id: 'TEST-effect',
    order: 1,
    event: {
      ...event,
      id: 'TEST-effect',
      text: 'TEST effect',
      dependencyIds: [event.id],
      evidence: { from: 12, to: 23, quote: 'TEST effect' },
    },
  };
  const materials = await createMaterials([first, second]);
  await validateMaterialSources(materials, [{ index: 0, content: text }], sampleStoryline());
  const backwards = await createMaterials([first, { ...second, order: 0 }]);
  await expect(
    validateMaterialSources(backwards, [{ index: 0, content: text }], sampleStoryline()),
  ).rejects.toThrow('dependency');
  const bad = await createMaterials([
    { ...first, event: { ...event, evidence: { from: 1, to: 11, quote: 'TEST cause' } } },
  ]);
  await expect(
    validateMaterialSources(bad, [{ index: 0, content: text }], sampleStoryline()),
  ).rejects.toThrow('evidence');
});
