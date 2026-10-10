/** TEST / SIMULATED: isolated SQLite fixtures; no claim about real model writing quality. */
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
vi.mock('@/jobs/runner', () => ({
  kick: vi.fn(),
  pauseJob: vi.fn(),
  resumeJob: vi.fn(),
  cancelJob: vi.fn(),
  providersForPurposes: vi.fn(),
}));
import { useTestDb } from '../helpers/testDb';
import { AssistantContextSchema, type AssistantOperation } from '@the-water/shared';
import { createNovel, getNovel, purgeNovel } from '@/db/repos/novelsRepo';
import {
  createVersion,
  getChapter,
  getVersion,
  saveSessionEdit,
  upsertChapterPlan,
  listChapters,
} from '@/db/repos/chaptersRepo';
import { defaultRequirements } from '@/novel/types';
import { getDb } from '@/db/db';
import {
  createRun,
  getRun,
  sessionFor,
  revision,
  getOperation,
  changesFor,
  undoOperation,
  beginOperation,
  operationWriter,
} from '@/assistant/repository';
import { executeOperation } from '@/assistant/operations';
import { importTextContent } from '@/novel/importText';
import { emptyVoice } from '@the-water/shared';
import { upsertCharacter, listCharacters } from '@/db/repos/storylineRepo';
import { getStoryGraph, saveStoryGraph } from '@/db/repos/storyGraphRepo';
import { saveAuthorNote, loadAuthorNote } from '@/llm/prompts/authorNote';

let db: ReturnType<typeof useTestDb>;
beforeEach(() => {
  db = useTestDb();
});
afterEach(() => db.raw.close());
async function work() {
  return createNovel({
    title: 'TEST work',
    premise: 'TEST premise',
    requirements: defaultRequirements(),
    targetChars: 300,
  });
}
async function run(novelId: string | null = null) {
  const context = AssistantContextSchema.parse({ novelId });
  return createRun(
    `TEST-${crypto.randomUUID()}`,
    await sessionFor(context),
    context,
    'TEST explicit instruction',
  );
}
async function execute(
  r: Awaited<ReturnType<typeof run>>,
  operation: AssistantOperation,
  sequence = 0,
) {
  if (operation.name === 'edit_text') {
    const v = await getVersion(
      (await getChapter(operation.parameters.chapterId))?.currentVersionId ?? null,
    );
    operation.parameters.baseVersionId = v?.id ?? null;
    operation.parameters.baseHash = v?.contentHash ?? null;
  }
  return executeOperation(
    r,
    operation,
    await revision(r.novelId),
    sequence,
    new AbortController().signal,
  );
}
it('TEST v12 preserves legacy conversations and enrolls only a new assistant session', async () => {
  await getDb().execute(
    "INSERT INTO ai_conversations(id,kind,title,created_at,updated_at) VALUES ('TEST-old','scratch','TEST old',1,1)",
  );
  const r = await run();
  expect(r.conversationId).not.toBe('TEST-old');
  expect(await getDb().select('SELECT * FROM assistant_sessions')).toHaveLength(1);
  expect(await getDb().select("SELECT * FROM ai_conversations WHERE id='TEST-old'")).toHaveLength(
    1,
  );
});
it('TEST creation, journal and conversation binding commit once on repeated request', async () => {
  const r = await run();
  const op: AssistantOperation = {
    name: 'create_work',
    parameters: {
      title: 'TEST created',
      premise: 'TEST premise',
      targetChars: 500,
      requirements: {},
    },
  };
  const result = await execute(r, op);
  expect(result.state).toBe('completed');
  expect((await getRun(r.id))?.novelId).toBe(result.novelId);
  expect(await execute(r, op)).toEqual(result);
  expect(await getDb().select('SELECT id FROM novels')).toHaveLength(1);
  expect(await changesFor(`${r.id}:0`)).toHaveLength(1);
  expect(await getDb().select('SELECT * FROM assistant_mutation_context')).toEqual([]);
  expect(await sessionFor(AssistantContextSchema.parse({ novelId: result.novelId }))).toBe(
    r.conversationId,
  );
  expect(await sessionFor(AssistantContextSchema.parse({}))).not.toBe(r.conversationId);
});
it('TEST simultaneous delivery of one request shares a single durable turn and message', async () => {
  const context = AssistantContextSchema.parse({});
  const session = await sessionFor(context);
  const turns = await Promise.all([
    createRun('TEST-concurrent', session, context, 'TEST create once'),
    createRun('TEST-concurrent', session, context, 'TEST create once'),
  ]);
  expect(turns[0]).toEqual(turns[1]);
  expect(await getDb().select('SELECT id FROM assistant_runs')).toHaveLength(1);
  expect(await getDb().select('SELECT id FROM ai_messages')).toHaveLength(1);
  await expect(
    createRun('TEST-concurrent', session, context, 'TEST changed request'),
  ).rejects.toThrow('different content');
});
it('TEST a failing SQL statement rolls back both content and row history', async () => {
  const n = await work(),
    r = await run(n.id),
    op = await beginOperation(r, 'edit_work', {}, await revision(n.id), 0);
  const writer = operationWriter(op, {
    state: 'completed',
    summary: 'TEST atomic failure',
    novelId: n.id,
    objectIds: [n.id],
  });
  await expect(
    writer([
      { sql: "UPDATE novels SET title='TEST should roll back' WHERE id=?", params: [n.id] },
      { sql: 'UPDATE TEST_nonexistent SET id=1' },
    ]),
  ).rejects.toThrow('no such table');
  expect((await getNovel(n.id))?.title).toBe('TEST work');
  expect(await changesFor(op.id)).toEqual([]);
  expect((await getOperation(op.id))?.state).toBe('running');
  expect(await getDb().select('SELECT * FROM assistant_mutation_context')).toEqual([]);
});
it('TEST revisions reject concurrent content edits without overwriting the author', async () => {
  const n = await work(),
    c = await upsertChapterPlan(n.id, { chapterNo: 1 }),
    r = await run(n.id);
  await createVersion({ chapterId: c.id, content: 'TEST old', source: 'user_edit' });
  const base = await revision(n.id);
  await createVersion({ chapterId: c.id, content: 'TEST author new', source: 'user_edit' });
  await expect(
    executeOperation(
      r,
      {
        name: 'edit_text',
        parameters: {
          baseVersionId: null,
          baseHash: null,
          chapterId: c.id,
          from: 0,
          to: 8,
          replacement: 'TEST assistant',
        },
      },
      base,
      0,
      new AbortController().signal,
    ),
  ).rejects.toThrow('Concurrent modification');
  expect((await getVersion((await getChapter(c.id))!.currentVersionId))?.content).toBe(
    'TEST author new',
  );
});
it('TEST text undo restores prose and invalidates memory, then rejects in-place author edits', async () => {
  const n = await work(),
    c = await upsertChapterPlan(n.id, { chapterNo: 1 }),
    r = await run(n.id);
  const v = await createVersion({ chapterId: c.id, content: 'TEST original', source: 'user_edit' });
  await execute(r, {
    name: 'edit_text',
    parameters: {
      baseVersionId: null,
      baseHash: null,
      chapterId: c.id,
      from: 5,
      to: 13,
      replacement: 'changed',
    },
  });
  expect((await getVersion((await getChapter(c.id))!.currentVersionId))?.content).toBe(
    'TEST changed',
  );
  await undoOperation(`${r.id}:0`, n.id);
  expect((await getChapter(c.id))?.currentVersionId).toBe(v.id);
  expect((await getChapter(c.id))?.memoryStatus).toBe('stale');
  await execute(r, { name: 'edit_work', parameters: { title: 'TEST edited' } }, 1);
  await saveSessionEdit({ chapterId: c.id, sessionId: 'TEST-session', content: 'TEST typing' });
  await expect(undoOperation(`${r.id}:1`, n.id)).rejects.toThrow('Undo conflict');
});
it('TEST sequential undo checks dependencies in reverse order', async () => {
  const n = await work(),
    r = await run(n.id);
  await execute(r, { name: 'edit_work', parameters: { title: 'TEST one' } }, 0);
  await execute(r, { name: 'edit_work', parameters: { premise: 'TEST two' } }, 1);
  await expect(undoOperation(`${r.id}:0`, n.id)).rejects.toThrow('Undo conflict');
  await undoOperation(`${r.id}:1`, n.id);
  await undoOperation(`${r.id}:0`, n.id);
  expect((await getNovel(n.id))?.title).toBe('TEST work');
  expect((await getNovel(n.id))?.premise).toBe('TEST premise');
});
it('TEST cross-work chapter IDs and selected-range expansion fail closed', async () => {
  const n = await work(),
    other = await work(),
    c = await upsertChapterPlan(other.id, { chapterNo: 1 }),
    r = await run(n.id);
  await expect(
    execute(r, {
      name: 'edit_text',
      parameters: {
        baseVersionId: null,
        baseHash: null,
        chapterId: c.id,
        from: 0,
        to: 0,
        replacement: 'TEST wrong work',
      },
    }),
  ).rejects.toThrow('does not belong');
  const own = await upsertChapterPlan(n.id, { chapterNo: 1 }),
    v = await createVersion({ chapterId: own.id, content: 'TEST selection', source: 'user_edit' });
  r.context.chapterId = own.id;
  r.context.selection = { from: 5, to: 14, versionId: v.id, contentHash: v.contentHash };
  await expect(
    execute(
      r,
      {
        name: 'edit_text',
        parameters: {
          baseVersionId: null,
          baseHash: null,
          chapterId: own.id,
          from: 0,
          to: 14,
          replacement: 'TEST forbidden',
        },
      },
      1,
    ),
  ).rejects.toThrow('Selection scope');
});
it('TEST imported manuscripts use an atomic batch and retain legacy facts as legacy', async () => {
  const novel = await importTextContent({
    title: 'TEST import',
    text: '第一章 TEST\nTEST original manuscript',
    requirements: defaultRequirements(),
  });
  const chapters = await listChapters(novel.id);
  expect(chapters).toHaveLength(1);
  expect(chapters[0]?.memoryStatus).toBe('legacy');
  expect((await getVersion(chapters[0]!.currentVersionId))?.content).toContain(
    'TEST original manuscript',
  );
});
it('TEST character locks are enforced by the same database guard as manual edits', async () => {
  const n = await work(),
    r = await run(n.id),
    character = await upsertCharacter(n.id, {
      id: 'TEST-locked',
      name: 'TEST',
      aliases: [],
      role: 'TEST',
      description: 'TEST original',
      arc: '',
      relationships: [],
      ...emptyVoice(),
    });
  const graph = await getStoryGraph(n.id);
  await saveStoryGraph(
    n.id,
    graph.revision,
    { ...graph.graph, lockedNodeIds: [character.id] },
    'TEST lock',
  );
  await expect(
    execute(r, {
      name: 'character',
      parameters: { value: { ...character, description: 'TEST forbidden' } },
    }),
  ).rejects.toThrow();
  expect((await listCharacters(n.id))[0]?.description).toBe('TEST original');
  expect(await changesFor(`${r.id}:0`)).toEqual([]);
});
it('TEST selected text cannot be expanded through a whole-chapter operation', async () => {
  const n = await work(),
    c = await upsertChapterPlan(n.id, { chapterNo: 1 }),
    r = await run(n.id),
    v = await createVersion({ chapterId: c.id, content: 'TEST original', source: 'user_edit' });
  r.context.chapterId = c.id;
  r.context.selection = { from: 0, to: 4, versionId: v.id, contentHash: v.contentHash };
  await expect(
    execute(r, {
      name: 'rewrite',
      parameters: { chapterIds: [c.id], instruction: 'TEST rewrite' },
    }),
  ).rejects.toThrow('selected range');
  expect(await getDb().select('SELECT id FROM generation_jobs')).toEqual([]);
});
it('TEST author note changes have reversible history and invalidate prior evidence', async () => {
  const n = await work(),
    r = await run(n.id);
  await saveAuthorNote(n.id, 'TEST original');
  await execute(r, { name: 'author_note', parameters: { value: 'TEST changed' } });
  expect(await loadAuthorNote(n.id)).toBe('TEST changed');
  await undoOperation(`${r.id}:0`, n.id);
  expect(await loadAuthorNote(n.id)).toBe('TEST original');
});
it('TEST automatic adoption refuses a candidate from an earlier task', async () => {
  const n = await work(),
    r = await run(n.id);
  await getDb().execute(
    "INSERT INTO writing_proposals(id,novel_id,kind,json,created_at) VALUES ('TEST-old-candidate',?,'text','{}',1)",
    [n.id],
  );
  await expect(
    executeOperation(
      r,
      { name: 'candidate', parameters: { id: 'TEST-old-candidate', action: 'accept' } },
      await revision(n.id),
      0,
      new AbortController().signal,
      'authorized_continuation',
    ),
  ).rejects.toThrow('Historical candidates');
  expect(
    (
      await getDb().select<{ state: string }>(
        "SELECT state FROM writing_proposals WHERE id='TEST-old-candidate'",
      )
    )[0]?.state,
  ).toBe('pending');
});

it('TEST a permanent work deletion does not become blocked by assistant history', async () => {
  const n = await work(),
    r = await run(n.id);
  await execute(r, { name: 'edit_work', parameters: { title: 'TEST removable work' } });
  await purgeNovel(n.id);
  expect(await getNovel(n.id)).toBeNull();
  expect((await getRun(r.id))?.novelId).toBeNull();
  expect((await getOperation(`${r.id}:0`))?.novelId).toBeNull();
});

it('TEST a persisted stop prevents an already prepared operation from writing', async () => {
  const n = await work(),
    r = await run(n.id),
    op = await beginOperation(r, 'edit_work', { title: 'TEST forbidden' }, await revision(n.id), 0);
  const writer = operationWriter(op, {
    state: 'completed',
    summary: 'TEST late write',
    novelId: n.id,
    objectIds: [n.id],
  });
  await getDb().execute("UPDATE assistant_runs SET state='cancelled' WHERE id=?", [r.id]);
  await expect(
    writer([{ sql: "UPDATE novels SET title='TEST forbidden' WHERE id=?", params: [n.id] }]),
  ).rejects.toThrow('Concurrent modification');
  expect((await getNovel(n.id))?.title).toBe('TEST work');
  expect(await changesFor(op.id)).toEqual([]);
});
