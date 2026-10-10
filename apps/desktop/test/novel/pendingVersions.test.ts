import { stageTestChapter } from '../helpers/writing';
import { getDb } from '@/db/db';
import { beforeEach, describe, expect, it } from 'vitest';
import { useTestDb } from '../helpers/testDb';
import { createNovel } from '@/db/repos/novelsRepo';
import {
  beginRewriteSession, createVersion, deleteVersion, getChapter, getPendingRewrite, getVersion, listPendingRewrites,
  listVersions, previewPrune, pruneVersions, resolveAllRewrites, resolveRewrite, restoreVersion, saveSessionEdit,
  sealChapterSessions, sealVersionSession, setChapterStatus, setVersionPinned, upsertChapterPlan,
} from '@/db/repos/chaptersRepo';
import { defaultRequirements } from '@/novel/types';
import { collectExportChapters } from '@/novel/export';

const novelOf = () => createNovel({ title: 'TEST pending versions', premise: '', requirements: defaultRequirements(), targetChars: 0 });

beforeEach(() => { useTestDb(); });

describe('改写产出先落待采纳（§2.2 第 1 条）', () => {
  it('TEST export preview and output share the committed or draft chapter list', async () => {
    const n = await novelOf();
    const first = await upsertChapterPlan(n.id,{chapterNo:1});
    const second = await upsertChapterPlan(n.id,{chapterNo:2});
    const empty = await upsertChapterPlan(n.id,{chapterNo:3});
    await createVersion({chapterId:first.id,content:'TEST committed chapter',source:'imported',status:'final'});
    await beginRewriteSession([first.id]);
    await createVersion({chapterId:first.id,content:'TEST unaccepted revision',source:'rewritten'});
    await createVersion({chapterId:second.id,content:'TEST uncommitted second chapter',source:'generated'});
    await createVersion({chapterId:empty.id,content:' ',source:'generated'});
    const committed = await collectExportChapters(n.id);
    expect(committed.map(c=>c.content)).toEqual(['TEST committed chapter']);
    expect((await collectExportChapters(n.id,true)).map(c=>c.content)).toEqual(['TEST unaccepted revision','TEST uncommitted second chapter']);
  });
  it('TEST 新生成稿始终是候选，尚未提交', async () => {
    const n = await novelOf();
    const ch = await upsertChapterPlan(n.id, { chapterNo: 1 });
    const v = await createVersion({ chapterId: ch.id, content: '初稿正文', source: 'generated' });
    expect(v.state).toBe('pending');
    expect(v.baselineVersionId).toBeNull();
    expect((await getChapter(ch.id))!.currentVersionId).toBe(v.id);
  });

  it('会话开着时产出待采纳版本，但仍然置为 current（后面几步要读它）', async () => {
    const n = await novelOf();
    const ch = await upsertChapterPlan(n.id, { chapterNo: 1 });
    const base = await createVersion({ chapterId: ch.id, content: '旧正文', source: 'imported', status: 'final' });
    expect(await beginRewriteSession([ch.id], 'job1')).toBe(1);

    const rewritten = await createVersion({ chapterId: ch.id, content: '新正文', source: 'rewritten' });
    expect(rewritten.state).toBe('pending');
    expect(rewritten.baselineVersionId).toBe(base.id);
    // TEST: working pointer advances; committed pointer remains the baseline.
    expect((await getChapter(ch.id))!.committedVersionId).toBe(base.id);
    expect((await getChapter(ch.id))!.currentVersionId).toBe(rewritten.id);
    // 同一次会话里后续步骤（扩写）产出的也是待采纳，基线不变
    const topup = await createVersion({ chapterId: ch.id, content: '新正文再长一点', source: 'topup' });
    expect(topup.state).toBe('pending');
    expect(topup.baselineVersionId).toBe(base.id);
  });

  it('没有正文的章节不开会话；已经开着的不重复开', async () => {
    const n = await novelOf();
    const empty = await upsertChapterPlan(n.id, { chapterNo: 1 });
    const written = await upsertChapterPlan(n.id, { chapterNo: 2 });
    await createVersion({ chapterId: written.id, content: '正文', source: 'generated' });
    expect(await beginRewriteSession([empty.id, written.id], 'job1')).toBe(1);
    expect(await beginRewriteSession([written.id], 'job2')).toBe(0);
    expect((await getChapter(written.id))!.rewriteJobId).toBe('job1');
  });

  it('逐章采纳：产出转正，当前版本不动', async () => {
    const n = await novelOf();
    const ch = await upsertChapterPlan(n.id, { chapterNo: 1 });
    await createVersion({ chapterId: ch.id, content: '旧正文', source: 'imported', status: 'final' });
    await beginRewriteSession([ch.id]);
    const rewritten = await createVersion({ chapterId: ch.id, content: '新正文', source: 'rewritten' });

    const pending = await getPendingRewrite(ch.id);
    expect(pending!.baseline!.content).toBe('旧正文');
    expect(pending!.latest!.content).toBe('新正文');
    expect(pending!.produced).toHaveLength(1);

    await stageTestChapter(ch.id);
    await resolveRewrite(ch.id, 'accept');
    const after = await getChapter(ch.id);
    expect(after!.currentVersionId).toBe(rewritten.id);
    expect(after!.rewriteBaselineVersionId).toBeNull();
    expect((await getVersion(rewritten.id))!.state).toBe('accepted');
    expect(await getPendingRewrite(ch.id)).toBeNull();
  });

  it('逐章丢弃 = 撤销这次改写：回到改写前的正文和状态', async () => {
    const n = await novelOf();
    const ch = await upsertChapterPlan(n.id, { chapterNo: 1 });
    const base = await createVersion({ chapterId: ch.id, content: '旧正文', source: 'imported' });
    await setChapterStatus(ch.id, 'final');
    await beginRewriteSession([ch.id]);
    const a = await createVersion({ chapterId: ch.id, content: '新正文', source: 'rewritten' });
    const b = await createVersion({ chapterId: ch.id, content: '新正文加长', source: 'topup' });
    expect((await getChapter(ch.id))!.status).toBe('draft');

    await resolveRewrite(ch.id, 'discard');
    const after = await getChapter(ch.id);
    expect(after!.currentVersionId).toBe(base.id);
    expect(after!.status).toBe('final');
    expect(after!.rewriteBaselineVersionId).toBeNull();
    expect((await getVersion(a.id))!.state).toBe('discarded');
    expect((await getVersion(b.id))!.state).toBe('discarded');
    // 丢弃的稿子还留在历史里，随时能换回来
    expect(await listVersions(ch.id)).toHaveLength(3);
  });

  it('换回一稿丢弃过的版本，它就不再顶着「已丢弃」', async () => {
    const n = await novelOf();
    const ch = await upsertChapterPlan(n.id, { chapterNo: 1 });
    await createVersion({ chapterId: ch.id, content: '旧正文', source: 'imported' });
    await beginRewriteSession([ch.id]);
    const rewritten = await createVersion({ chapterId: ch.id, content: '新正文', source: 'rewritten' });
    await resolveRewrite(ch.id, 'discard');
    await restoreVersion(ch.id, rewritten.id);
    expect((await getVersion(rewritten.id))!.state).toBe('discarded');
    expect((await getChapter(ch.id))!.currentVersionId).not.toBe(rewritten.id);
    expect((await getVersion((await getChapter(ch.id))!.currentVersionId!))!.content).toBe('新正文');
  });

  it('整本书一起处理：全部采纳 / 一键撤销', async () => {
    const n = await novelOf();
    const chapters = [];
    for (const no of [1, 2, 3]) {
      const ch = await upsertChapterPlan(n.id, { chapterNo: no });
      await createVersion({ chapterId: ch.id, content: `第${no}章旧正文`, source: 'generated' });
      chapters.push(ch);
    }
    await beginRewriteSession(chapters.map((c) => c.id), 'job1');
    for (const ch of chapters) await createVersion({ chapterId: ch.id, content: '新正文', source: 'rewritten' });
    expect((await listPendingRewrites(n.id)).map((p) => p.chapter.chapterNo)).toEqual([1, 2, 3]);

    await stageTestChapter(chapters[0]!.id);
    await resolveRewrite(chapters[0]!.id, 'accept');
    expect(await listPendingRewrites(n.id)).toHaveLength(2);
    expect(await resolveAllRewrites(n.id, 'discard')).toBe(2);
    expect(await listPendingRewrites(n.id)).toHaveLength(0);
    expect((await getChapter(chapters[0]!.id))!.currentVersionId).not.toBe(null);
    expect((await getVersion((await getChapter(chapters[1]!.id))!.currentVersionId!))!.content).toBe('第2章旧正文');
  });

  it('没有待采纳时处理是空操作', async () => {
    const n = await novelOf();
    const ch = await upsertChapterPlan(n.id, { chapterNo: 1 });
    const v = await createVersion({ chapterId: ch.id, content: '正文', source: 'generated' });
    await resolveRewrite(ch.id, 'discard');
    expect((await getChapter(ch.id))!.currentVersionId).toBe(v.id);
    expect(await resolveAllRewrites(n.id, 'accept')).toBe(0);
  });
});

describe('会话级自动保存（§2.2 第 3 条）', () => {
  it('同一次会话只占一个版本行，反复覆盖', async () => {
    const n = await novelOf();
    const ch = await upsertChapterPlan(n.id, { chapterNo: 1 });
    await createVersion({ chapterId: ch.id, content: 'AI 初稿', source: 'generated' });
    const first = await saveSessionEdit({ chapterId: ch.id, sessionId: 's1', content: '改了一点' });
    for (const text of ['改了两点', '改了三点', '改了四点']) {
      await saveSessionEdit({ chapterId: ch.id, sessionId: 's1', content: text });
    }
    const versions = await listVersions(ch.id);
    expect(versions).toHaveLength(2); // AI 初稿 + 这一次会话，而不是 1 + 4
    const open = (await getVersion(first.id))!;
    expect(open.content).toBe('改了四点');
    expect(open.sessionId).toBe('s1');
    expect(open.updatedAt).toBeGreaterThanOrEqual(open.createdAt);
    expect((await getChapter(ch.id))!.currentVersionId).toBe(first.id);
  });

  it('封版之后再编辑另起一稿', async () => {
    const n = await novelOf();
    const ch = await upsertChapterPlan(n.id, { chapterNo: 1 });
    await saveSessionEdit({ chapterId: ch.id, sessionId: 's1', content: '第一次会话' });
    await sealVersionSession('s1');
    await saveSessionEdit({ chapterId: ch.id, sessionId: 's2', content: '第二次会话' });
    const versions = await listVersions(ch.id);
    expect(versions).toHaveLength(2);
    expect(versions.every((v) => v.sessionId === 's2' || v.sessionId === null)).toBe(true);
    expect(versions[0]!.content).toBe('第二次会话');
  });

  it('进编辑器先关掉上次崩溃留下的会话', async () => {
    const n = await novelOf();
    const ch = await upsertChapterPlan(n.id, { chapterNo: 1 });
    await saveSessionEdit({ chapterId: ch.id, sessionId: 's1', content: '上次没封版' });
    await sealChapterSessions(ch.id);
    expect((await listVersions(ch.id)).every((v) => v.sessionId === null)).toBe(true);
    await saveSessionEdit({ chapterId: ch.id, sessionId: 's1', content: '这次重新开' });
    expect(await listVersions(ch.id)).toHaveLength(2);
  });

  it('会话里的编辑在改写会话开着时同样是待采纳', async () => {
    const n = await novelOf();
    const ch = await upsertChapterPlan(n.id, { chapterNo: 1 });
    await createVersion({ chapterId: ch.id, content: '旧正文', source: 'imported' });
    await beginRewriteSession([ch.id]);
    const v = await saveSessionEdit({ chapterId: ch.id, sessionId: 's1', content: '边看边改' });
    expect(v.state).toBe('pending');
  });
});

describe('版本清理（§2.2 第 2 条）', () => {
  const seed = async () => {
    const n = await novelOf();
    const ch = await upsertChapterPlan(n.id, { chapterNo: 1 });
    const versions = [];
    for (let i = 0; i < 12; i++) versions.push(await createVersion({ chapterId: ch.id, content: `第${i}稿`, source: 'user_edit' }));
    // TEST: explicitly discard superseded drafts before testing pruning.
    await getDb().execute("UPDATE chapter_versions SET state='discarded' WHERE chapter_id=?", [ch.id]);
    return { novelId: n.id, chapterId: ch.id, versions };
  };

  it('保留最近 N 稿，其余清掉', async () => {
    const { chapterId } = await seed();
    expect(await previewPrune(chapterId, 3)).toBe(9);
    expect(await pruneVersions(chapterId, 3)).toBe(9);
    expect(await listVersions(chapterId)).toHaveLength(3);
  });

  it('钉住的稿子不被清理', async () => {
    const { chapterId, versions } = await seed();
    await setVersionPinned(versions[0]!.id, true);
    await pruneVersions(chapterId, 3);
    const left = await listVersions(chapterId);
    expect(left).toHaveLength(4);
    expect(left.some((v) => v.id === versions[0]!.id && v.pinned)).toBe(true);
    // 取消钉住之后就能清掉了
    await setVersionPinned(versions[0]!.id, false);
    expect(await pruneVersions(chapterId, 3)).toBe(1);
  });

  it('手动删除挡住当前版本 / 钉住的 / 待采纳的', async () => {
    const { chapterId, versions } = await seed();
    const current = versions.at(-1)!;
    await expect(deleteVersion(current.id)).rejects.toThrow('当前正文');
    await setVersionPinned(versions[0]!.id, true);
    await expect(deleteVersion(versions[0]!.id)).rejects.toThrow('钉住');
    await beginRewriteSession([chapterId]);
    const pending = await createVersion({ chapterId, content: '改写产出', source: 'rewritten' });
    await createVersion({ chapterId, content: '改写产出再扩写', source: 'topup' });
    await expect(deleteVersion(pending.id)).rejects.toThrow('采纳');
    // 改写基线也删不得，撤销要用
    await expect(deleteVersion(current.id)).rejects.toThrow('改写前的存档');
    await deleteVersion(versions[1]!.id);
    expect((await listVersions(chapterId)).some((v) => v.id === versions[1]!.id)).toBe(false);
  });

  it('清理会绕开改写基线与待采纳的稿子', async () => {
    const { chapterId } = await seed();
    await beginRewriteSession([chapterId]);
    await createVersion({ chapterId, content: '改写产出', source: 'rewritten' });
    await pruneVersions(chapterId, 1);
    const left = await listVersions(chapterId);
    // 剩下：改写产出（当前 + 待采纳）+ 改写基线
    expect(left).toHaveLength(2);
    expect(left.map((v) => v.state).sort()).toEqual(['discarded', 'pending']);
    expect(left.some((v) => v.content === '改写产出' && v.state === 'pending')).toBe(true);
  });
});
