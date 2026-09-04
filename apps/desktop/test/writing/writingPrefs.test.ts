/**
 * §2.3 第 1 条（学习层可见可改）与第 6 条后半（作者附加指令）的纯逻辑与仓储行为。
 * 桌面 UI 没有测试框架，这里只测面板背后的数据动作。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useTestDb } from '../helpers/testDb';
import { emptyStyleProfile } from '@the-water/shared';
import { createNovel } from '@/db/repos/novelsRepo';
import { getStyleExtras, setStyleProfile } from '@/db/repos/storylineRepo';
import { clearFeedback, dismissFeedback, listFeedback, promoteFeedback, recordUserEdit } from '@/db/repos/feedbackRepo';
import { demoteFromProfile, promoteIntoProfile } from '@/novel/learning';
import { AUTHOR_NOTE_MAX_CHARS, authorNoteOf, clearAuthorNoteCache, loadAuthorNote, primeAuthorNote, renderAuthorNote, saveAuthorNote } from '@/llm/prompts/authorNote';
import { systemBase } from '@/llm/prompts/base';
import { defaultRequirements } from '@/novel/types';

beforeEach(() => { useTestDb(); clearAuthorNoteCache(); });

const newNovel = () => createNovel({ title: 't', premise: '', requirements: defaultRequirements(), targetChars: 0 });
const softList = async (novelId: string) => (await getStyleExtras(novelId)).styleProfile?.negatives.avoidWordsSoft.list ?? [];

describe('demoteFromProfile', () => {
  it('removes phrases and returns the same object when nothing matched', () => {
    const p = promoteIntoProfile(emptyStyleProfile({}), ['嘴角勾起', '眼底闪过']);
    const after = demoteFromProfile(p, [' 嘴角勾起 ']);
    expect(after.negatives.avoidWordsSoft.list).toEqual(['眼底闪过']);
    expect(demoteFromProfile(p, [])).toBe(p);
    expect(demoteFromProfile(p, ['没学过的词'])).toBe(p);
    // 不改原对象
    expect(p.negatives.avoidWordsSoft.list).toEqual(['嘴角勾起', '眼底闪过']);
  });
});

describe('「我的写作偏好」面板的三个动作', () => {
  it('promoteFeedback 手动晋升：不看次数，直接进少用词', async () => {
    const n = await newNovel();
    await promoteFeedback(n.id, ' 嘴角微微勾起 ');
    expect(await softList(n.id)).toEqual(['嘴角微微勾起']);
    const rows = await listFeedback(n.id);
    expect(rows).toEqual([{ phrase: '嘴角微微勾起', count: 1, promoted: true }]);
    // 幂等：再点一次不会重复写入
    await promoteFeedback(n.id, '嘴角微微勾起');
    expect(await softList(n.id)).toEqual(['嘴角微微勾起']);
    expect(await listFeedback(n.id)).toHaveLength(1);
    // 空串什么也不做
    await promoteFeedback(n.id, '  ');
    expect(await listFeedback(n.id)).toHaveLength(1);
  });

  it('promoteFeedback 在还没有文风档案时也能建一个', async () => {
    const n = await newNovel();
    expect((await getStyleExtras(n.id)).styleProfile).toBeNull();
    await promoteFeedback(n.id, '眼底闪过');
    expect((await getStyleExtras(n.id)).styleProfile).not.toBeNull();
    expect(await softList(n.id)).toEqual(['眼底闪过']);
  });

  it('dismissFeedback 删记录的同时把词从少用词里摘掉', async () => {
    const n = await newNovel();
    await promoteFeedback(n.id, '嘴角勾起');
    await promoteFeedback(n.id, '眼底闪过');
    await dismissFeedback(n.id, '嘴角勾起');
    expect(await listFeedback(n.id)).toEqual([{ phrase: '眼底闪过', count: 1, promoted: true }]);
    expect(await softList(n.id)).toEqual(['眼底闪过']);
  });

  it('clearFeedback 清空记录并把学到的词全部摘掉，但不动手写的词', async () => {
    const n = await newNovel();
    await setStyleProfile(n.id, promoteIntoProfile(emptyStyleProfile({ id: 'p', name: 'p' }), ['我自己写的']));
    await promoteFeedback(n.id, '学来的');
    expect(await softList(n.id)).toEqual(['我自己写的', '学来的']);
    await clearFeedback(n.id);
    expect(await listFeedback(n.id)).toEqual([]);
    expect(await softList(n.id)).toEqual(['我自己写的']);
  });

  it('自动记录与手动动作共用同一张表', async () => {
    const n = await newNovel();
    await recordUserEdit(n.id, '他嘴角微微勾起，转身离开。', '他转身离开。');
    const rows = await listFeedback(n.id);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.promoted === false)).toBe(true);
    const phrase = rows[0]!.phrase;
    await promoteFeedback(n.id, phrase);
    expect((await listFeedback(n.id)).find((r) => r.phrase === phrase)!.promoted).toBe(true);
  });
});

describe('作者附加指令', () => {
  it('按小说存取，超长截断，并在缓存里备好给同步的 systemBase 用', async () => {
    const a = await newNovel();
    const b = await newNovel();
    expect(await loadAuthorNote(a.id)).toBe('');
    await saveAuthorNote(a.id, '  不要写心理独白。  ');
    expect(await loadAuthorNote(a.id)).toBe('不要写心理独白。');
    expect(await loadAuthorNote(b.id)).toBe('');
    const long = await saveAuthorNote(b.id, '字'.repeat(AUTHOR_NOTE_MAX_CHARS + 500));
    expect(Array.from(long)).toHaveLength(AUTHOR_NOTE_MAX_CHARS);

    clearAuthorNoteCache();
    expect(authorNoteOf(a.id)).toBe('');
    await primeAuthorNote(a.id);
    expect(authorNoteOf(a.id)).toBe('不要写心理独白。');
  });

  it('renderAuthorNote 空值不产出小节', () => {
    expect(renderAuthorNote('')).toBe('');
    expect(renderAuthorNote(null)).toBe('');
    expect(renderAuthorNote('  ')).toBe('');
    expect(renderAuthorNote('少用形容词')).toContain('【作者附加指令】');
  });

  it('拼进 system 提示，位置在文风之后、输出格式之前', () => {
    const req = defaultRequirements();
    const s = systemBase(req, { authorNote: '每章至少出现一次天气。' });
    expect(s).toContain('【作者附加指令】');
    expect(s).toContain('每章至少出现一次天气。');
    expect(s.indexOf('【作者附加指令】')).toBeLessThan(s.indexOf('【输出格式】'));
    expect(systemBase(req)).not.toContain('【作者附加指令】');
  });
});
