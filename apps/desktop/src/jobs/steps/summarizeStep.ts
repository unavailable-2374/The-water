import { countZh } from '@the-water/shared';
import { getDb } from '@/db/db';
import { listChapters, setChapterTarget, updateVersionSummary } from '@/db/repos/chaptersRepo';
import { saveBible } from '@/db/repos/bibleRepo';
import { requestJson } from '@/llm/json';
import { summarizePrompt } from '@/llm/prompts/summarizeAndBible';
import { applyBibleDelta } from '@/novel/bible';
import { redistributeRemaining, type BudgetChapter } from '@/novel/wordBudget';
import { emitJobEvent } from '../events';
import type { StepHandler } from '../context';
import { arcIdForChapter, currentVersionOf, loadChapterEnv } from './common';

export const summarizeStep: StepHandler = async (ctx) => {
  const env = await loadChapterEnv(ctx);
  const { chapter, novel, doc, bible } = env;
  const version = await currentVersionOf(chapter);
  if (!version) throw new Error('章节尚无正文');
  // idempotency: a bible snapshot already produced for this exact version
  const done = await getDb().select<{ id: string }>('SELECT id FROM story_bible_snapshots WHERE novel_id = ? AND chapter_version_id = ? LIMIT 1', [novel.id, version.id]);
  if (done[0]) return { outputRef: done[0].id };

  ctx.setMessage(`正在总结第 ${chapter.chapterNo} 章并更新故事圣经`);
  const spec = summarizePrompt({ chapterNo: chapter.chapterNo, chapterText: version.content, bibleBefore: bible, doc });
  // 不推 onDelta：那条通道的语义是「正在写的章节正文」，编辑器会原样显示。
  // 总结输出的是 JSON，推上去会让读者在正文区看到一坨 {"summary":...}。进度靠上面的 setMessage。
  const r = await requestJson(ctx.provider, { ...spec, schema: spec.schema! }, { signal: ctx.signal, gate: ctx.gate });
  await ctx.recordUsage(r.usage);
  const next = applyBibleDelta(bible, r.value.bibleDelta, chapter.chapterNo, doc, arcIdForChapter(doc, chapter.chapterNo));
  await updateVersionSummary(version.id, r.value.summary);
  const snap = await saveBible(novel.id, chapter.chapterNo, next, version.id);
  emitJobEvent({ type: 'novel:bibleUpdated', novelId: novel.id, afterChapterNo: chapter.chapterNo });

  // keep the book on target: redistribute remaining chars over unwritten chapters
  if (novel.targetChars > 0) {
    const chapters = await listChapters(novel.id);
    const budget: BudgetChapter[] = [];
    for (const c of chapters) {
      const v = c.currentVersionId ? await getDb().select<{ char_count: number }>('SELECT char_count FROM chapter_versions WHERE id = ?', [c.currentVersionId]) : [];
      const actual = v[0]?.char_count ?? 0;
      const planned = doc.chapters.find((p) => p.chapterNo === c.chapterNo)?.targetChars ?? c.targetChars;
      budget.push({ chapterNo: c.chapterNo, targetChars: c.targetChars, originalTarget: planned || c.targetChars, done: c.chapterNo <= chapter.chapterNo && !!c.currentVersionId, actualChars: actual });
    }
    const next2 = redistributeRemaining(budget, novel.targetChars);
    for (const c of chapters) {
      const t = next2.get(c.chapterNo);
      if (t != null && t !== c.targetChars && c.chapterNo > chapter.chapterNo) await setChapterTarget(c.id, t);
    }
  }
  void countZh;
  return { outputRef: snap.id };
};
