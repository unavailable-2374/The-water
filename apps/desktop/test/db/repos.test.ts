import { beforeEach, describe, expect, it } from 'vitest';
import { useTestDb } from '../helpers/testDb';
import { getSetting, setSetting, loadAppSettings } from '@/db/repos/settingsRepo';
import { createProvider, listProviders, setDefaultProvider, updateProvider, deleteProvider } from '@/db/repos/providersRepo';
import { createDocument, listDocuments, upsertPageText, searchPages, findDocumentBySha } from '@/db/repos/documentsRepo';
import { createHighlight, listHighlights, updateHighlight, deleteHighlight } from '@/db/repos/highlightsRepo';
import { createConversation, appendMessage, listMessages, listConversations } from '@/db/repos/conversationsRepo';
import { createJob, nextPendingStep, stepStarted, stepDone, stepCounts, markInterrupted, getJob, setJobStatus, listSteps } from '@/db/repos/jobsRepo';
import { getDb } from '@/db/db';
import { clearSyncAccount, getSyncAccount, saveSyncAccount } from '@/db/repos/syncAccountRepo';

beforeEach(() => { useTestDb(); });

describe('settings & providers', () => {
  it('round-trips settings', async () => {
    expect(await getSetting('x', 1)).toBe(1);
    await setSetting('x', { a: 1 });
    expect(await getSetting('x', null)).toEqual({ a: 1 });
    await setSetting('autoResumeJobs', false);
    expect((await loadAppSettings()).autoResumeJobs).toBe(false);
  });
  it('first provider becomes default; setDefault switches', async () => {
    const a = await createProvider({ name: 'A', kind: 'openai_compatible', baseUrl: 'https://x/', model: 'm', contextWindow: 1, maxOutputTokens: 1, jsonMode: 'none', temperature: 0.5, extraHeaders: {}, secretRef: 'env:X_API_KEY' });
    const b = await createProvider({ name: 'B', kind: 'anthropic', baseUrl: 'https://y', model: 'm2', contextWindow: 1, maxOutputTokens: 1, jsonMode: 'tool', temperature: 0.5, extraHeaders: { h: '1' }, secretRef: 'provider:b' });
    expect(a.isDefault).toBe(true);
    expect(a.baseUrl).toBe('https://x');
    expect(b.isDefault).toBe(false);
    expect(b.extraHeaders).toEqual({ h: '1' });
    await setDefaultProvider(b.id);
    const list = await listProviders();
    expect(list[0]!.id).toBe(b.id);
    expect(list.filter((p) => p.isDefault)).toHaveLength(1);
    await updateProvider(a.id, { model: 'm3' });
    expect((await listProviders()).find((p) => p.id === a.id)!.model).toBe('m3');
    await deleteProvider(a.id);
    expect(await listProviders()).toHaveLength(1);
  });
});

describe('documents & highlights', () => {
  it('creates, searches page text, highlights', async () => {
    const d = await createDocument({ title: 'T', fileRelPath: 'pdfs/a.pdf', fileSha256: 'abc', pageCount: 2 });
    expect((await listDocuments())[0]!.id).toBe(d.id);
    expect(await findDocumentBySha('abc')).not.toBeNull();
    await upsertPageText(d.id, 1, '天地玄黄，宇宙洪荒。');
    await upsertPageText(d.id, 2, '日月盈昃，辰宿列张。');
    const hits = await searchPages(d.id, '宇宙');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.pageNo).toBe(1);
    const h = await createHighlight({ documentId: d.id, pageNo: 1, kind: 'note', anchor: { exact: '宇宙', prefix: '玄黄，', suffix: '洪荒', start: 5, end: 7, rects: [{ x: 0.1, y: 0.2, w: 0.1, h: 0.02 }] }, noteText: 'n' });
    expect(h.anchor.rects[0]!.w).toBe(0.1);
    await updateHighlight(h.id, { noteText: 'n2', color: 'green' });
    const list = await listHighlights(d.id);
    expect(list[0]!.noteText).toBe('n2');
    expect(list[0]!.color).toBe('green');
    await deleteHighlight(h.id);
    expect(await listHighlights(d.id)).toHaveLength(0);
    // cascade
    await getDb().execute('DELETE FROM documents WHERE id = ?', [d.id]);
    expect(await getDb().select('SELECT * FROM document_pages')).toHaveLength(0);
  });
});

describe('conversations', () => {
  it('appends messages with increasing seq', async () => {
    const c = await createConversation({ kind: 'scratch', title: 'x' });
    await appendMessage({ conversationId: c.id, role: 'user', content: 'a', context: { pageNo: 3, selectedText: 's' } });
    await appendMessage({ conversationId: c.id, role: 'assistant', content: 'b', usage: { inputTokens: 1, outputTokens: 2 } });
    const m = await listMessages(c.id);
    expect(m.map((x) => x.seq)).toEqual([1, 2]);
    expect(m[0]!.context?.pageNo).toBe(3);
    expect(m[1]!.usage?.outputTokens).toBe(2);
    expect((await listConversations({ kind: 'scratch' }))[0]!.id).toBe(c.id);
  });
});

describe('jobs', () => {
  it('creates steps, walks them, and recovers interrupted jobs', async () => {
    await getDb().execute("INSERT INTO novels(id, title, created_at, updated_at) VALUES ('n1','t',0,0)");
    const job = await createJob({ novelId: 'n1', type: 'generate_novel', params: {}, providerId: null, steps: [{ kind: 'outline' }, { kind: 'chapter_table' }, { kind: 'write_chapter', chapterId: null, input: { chapterNo: 1 } }] });
    expect(job.progress.total).toBe(3);
    await setJobStatus(job.id, 'running');
    const s1 = await nextPendingStep(job.id);
    expect(s1!.kind).toBe('outline');
    await stepStarted(s1!.id);
    await stepDone(s1!.id, 'snap1');
    const s2 = await nextPendingStep(job.id);
    expect(s2!.seq).toBe(1);
    await stepStarted(s2!.id);
    expect(await stepCounts(job.id)).toEqual({ done: 1, total: 3 });
    // simulate crash while step 2 running
    const recovered = await markInterrupted();
    expect(recovered).toHaveLength(1);
    const j = await getJob(job.id);
    expect(j!.status).toBe('paused');
    expect(j!.interrupted).toBe(true);
    const steps = await listSteps(job.id);
    expect(steps[1]!.status).toBe('pending');
    expect(steps[1]!.attempts).toBe(1);
    expect(steps[0]!.status).toBe('done');
    await setJobStatus(job.id, 'completed');
    expect((await getJob(job.id))!.finishedAt).not.toBeNull();
  });
});

describe('sync account', () => {
  it('stores the cloud account with its @handle and upserts in place', async () => {
    expect(await getSyncAccount()).toBeNull();
    await saveSyncAccount({ serverUrl: 'http://localhost:8787/', userId: 'u1', displayName: '林晚', handle: 'linwan', tokenSecretRef: 'account:token' });
    const a = await getSyncAccount();
    expect(a).toMatchObject({ serverUrl: 'http://localhost:8787', userId: 'u1', handle: 'linwan' });

    await saveSyncAccount({ serverUrl: 'http://localhost:8787', userId: 'u1', displayName: '林晚', handle: 'wan', tokenSecretRef: 'account:token' });
    expect((await getSyncAccount())!.handle).toBe('wan');

    await clearSyncAccount();
    expect(await getSyncAccount()).toBeNull();
  });

  it('has the handle column from migration 0003', async () => {
    const cols = await getDb().select<{ name: string }>('PRAGMA table_info(sync_account)');
    expect(cols.map((c) => c.name)).toContain('handle');
  });
});
