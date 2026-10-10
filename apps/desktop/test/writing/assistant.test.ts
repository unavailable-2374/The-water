/** TEST fixtures and scripted responses only; these do not establish writing quality. */
import { beforeEach, expect, it } from 'vitest';
import { useTestDb } from '../helpers/testDb';
import { sseBody, sseResponse } from '../llm/helpers';
import { setSecretStore } from '@/secrets/keychain';
import { setFetchImpl } from '@/llm/registry';
import { createProvider } from '@/db/repos/providersRepo';
import { createNovel } from '@/db/repos/novelsRepo';
import {
  createVersion,
  getChapter,
  getVersion,
  upsertChapterPlan,
  deleteVersion,
  pruneVersions,
} from '@/db/repos/chaptersRepo';
import { createDocument, upsertPageText } from '@/db/repos/documentsRepo';
import { listConversations, listMessages } from '@/db/repos/conversationsRepo';
import { getDb } from '@/db/db';
import { defaultRequirements } from '@/novel/types';
import { assistantRequest, acceptTextProposal, listTextProposals } from '@/novel/assistant';
import { providersForPurposes } from '@/jobs/runner';

const calls: Record<string, unknown>[] = [];
beforeEach(() => {
  useTestDb();
  calls.length = 0;
  setSecretStore({ get: async () => 'TEST-only', set: async () => undefined, delete: async () => undefined });
  setFetchImpl(async (_url, init) => {
    calls.push(JSON.parse(String(init?.body)));
    return sseResponse([
      sseBody([
        {
          data: {
            choices: [{ delta: { content: 'TEST candidate' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 3 },
          },
        },
        { data: '[DONE]' },
      ]),
    ]);
  });
});
async function fixture(maxOutputTokens = 8000) {
  await createProvider({
    name: 'TEST provider',
    kind: 'openai_compatible',
    baseUrl: 'https://test.invalid/v1',
    model: 'TEST',
    contextWindow: 128000,
    maxOutputTokens,
    jsonMode: 'json_object',
    temperature: 0.1,
    extraHeaders: {},
    secretRef: 'TEST',
  });
  const novel = await createNovel({
    title: 'TEST assistant',
    premise: 'TEST fictional premise',
    requirements: defaultRequirements(),
    targetChars: 250,
  });
  const chapter = await upsertChapterPlan(novel.id, {
    chapterNo: 1,
    title: 'TEST chapter',
    goal: 'TEST goal',
    targetChars: 250,
  });
  const version = await createVersion({
    chapterId: chapter.id,
    source: 'user_edit',
    content: 'TEST original text',
  });
  return {
    novel,
    chapter,
    version,
    input: {
      novelId: novel.id,
      chapterId: chapter.id,
      versionId: version.id,
      text: version.content,
      from: 5,
      to: 13,
      operation: 'rewrite' as const,
      instruction: 'TEST replace selection',
      sourceIds: [] as string[],
      signal: new AbortController().signal,
      onDelta: () => {},
    },
  };
}
it('TEST discussion records a novel_assist conversation without changing prose or plans', async () => {
  const { input, chapter, version, novel } = await fixture();
  const before = await getChapter(chapter.id);
  const result = await assistantRequest({ ...input, operation: 'discuss' });
  expect(result.proposal).toBeUndefined();
  expect(await getChapter(chapter.id)).toEqual(before);
  expect(await listTextProposals(chapter.id)).toEqual([]);
  const conversations = await listConversations({ novelId: novel.id, kind: 'novel_assist' });
  expect(conversations).toHaveLength(1);
  expect(await listMessages(conversations[0]!.id)).toHaveLength(2);
  expect((await getVersion(version.id))!.content).toBe(input.text);
});
it('TEST selection candidate leaves working prose untouched and rebases only a non-overlapping edit', async () => {
  const { input, chapter, version } = await fixture();
  const result = await assistantRequest(input);
  expect((await getChapter(chapter.id))!.currentVersionId).toBe(version.id);
  expect((await getVersion(version.id))!.content).toBe(input.text);
  expect(await acceptTextProposal(result.proposal!, input.text + ' TEST tail')).toBe(
    'TEST TEST candidate text TEST tail',
  );
  await expect(acceptTextProposal(result.proposal!, 'TEST changed text')).rejects.toThrow();
  expect(
    (
      await getDb().select<{ state: string }>('SELECT state FROM writing_proposals WHERE id=?', [
        result.proposal!.id,
      ])
    )[0]!.state,
  ).toBe('conflict');
});
it('TEST explicit PDF page citation is included and changed source prevents adoption', async () => {
  const { input } = await fixture();
  const doc = await createDocument({
    title: 'TEST reference',
    fileRelPath: 'TEST.pdf',
    fileSha256: 'TEST-hash',
    pageCount: 2,
  });
  await upsertPageText(doc.id, 2, 'TEST cited evidence');
  const result = await assistantRequest({ ...input, sourceIds: [`pdf:${doc.id}:2`] });
  expect(JSON.stringify(calls)).toContain('TEST cited evidence');
  expect(result.proposal!.sourceHashes).toHaveLength(1);
  await upsertPageText(doc.id, 2, 'TEST revised evidence');
  await expect(acceptTextProposal(result.proposal!, input.text)).rejects.toThrow('引用资料已变化');
});
it('TEST pending proposal keeps its discarded base version through pruning', async () => {
  const { input, chapter, version } = await fixture();
  await assistantRequest(input);
  await createVersion({ chapterId: chapter.id, source: 'user_edit', content: 'TEST new working' });
  await getDb().execute("UPDATE chapter_versions SET state='discarded' WHERE id=?", [version.id]);
  await expect(deleteVersion(version.id)).rejects.toThrow('未处理修订建议');
  await pruneVersions(chapter.id, 1);
  expect(await getVersion(version.id)).not.toBeNull();
});
it('TEST an explicitly unavailable provider cannot silently use the default', async () => {
  await fixture();
  await expect(
    providersForPurposes(
      { params: { providerIds: { writing: 'TEST-deleted-provider' } }, providerId: null },
      ['writing'],
    ),
  ).rejects.toThrow();
  expect(calls).toHaveLength(0);
});
it('TEST truncated assistant output records usage and never creates an adoptable candidate', async () => {
  const { input, chapter } = await fixture(4096);
  setFetchImpl(async () =>
    sseResponse([
      sseBody([
        {
          data: {
            choices: [{ delta: { content: 'TEST truncated' }, finish_reason: 'length' }],
            usage: { prompt_tokens: 17, completion_tokens: 19 },
          },
        },
        { data: '[DONE]' },
      ]),
    ]),
  );
  await expect(assistantRequest(input)).rejects.toThrow('预算耗尽');
  expect(await listTextProposals(chapter.id)).toEqual([]);
  expect(await getDb().select('SELECT input_tokens,output_tokens FROM usage_events')).toEqual([
    { input_tokens: 17, output_tokens: 19 },
  ]);
});
