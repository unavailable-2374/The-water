/**
 * chapter_table 步骤（§2.1 第 1 条）。
 *
 * 章节表是**分批**生成的（每批 30 章），原来跑在前台：跑到第三批崩了，前两批
 * 白跑。这里每跑完一批就把结果写回 `job_steps.input.batches`，恢复时直接从
 * 下一批接着跑。全部批次跑完才动数据库（删旧章 + 建新章），中途中断不会留下半张表。
 */
import { getNovel } from '@/db/repos/novelsRepo';
import { requestJson } from '@/llm/json';
import { chapterTableBatches, chapterTablePrompt } from '@/llm/prompts/chapterTable';
import { buildStorylineDoc } from '@/db/repos/storylineRepo';
import { setStepInput } from '@/db/repos/jobsRepo';
import { applyChapterTable, normalizeBatchEntries, storylineToOutline } from '@/novel/planning';
import { planChapterCount } from '@/novel/wordBudget';
import type { ChapterTable, ChapterTableEntry } from '@/novel/types';
import type { StepHandler } from '../context';

/** 已跑完的批次缓存在步骤输入里，键名固定。 */
export const BATCH_CACHE_KEY = 'batches';

/** 从步骤输入里读回已经跑完的批次（脏数据一律当作没有）。 */
export function readBatchCache(input: Record<string, unknown> | null | undefined): ChapterTable {
  const raw = input?.[BATCH_CACHE_KEY];
  if (!Array.isArray(raw)) return [];
  const out: ChapterTableEntry[] = [];
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue;
    const r = e as Record<string, unknown>;
    if (typeof r.chapterNo !== 'number') continue;
    out.push({
      chapterNo: r.chapterNo,
      title: typeof r.title === 'string' ? r.title : `第${r.chapterNo}章`,
      goal: typeof r.goal === 'string' ? r.goal : '',
      beatTitles: Array.isArray(r.beatTitles) ? r.beatTitles.filter((x): x is string => typeof x === 'string') : [],
      povCharacter: typeof r.povCharacter === 'string' ? r.povCharacter : null,
      targetChars: typeof r.targetChars === 'number' ? r.targetChars : 0,
      endHook: typeof r.endHook === 'string' ? r.endHook : '',
    });
  }
  return out.sort((a, b) => a.chapterNo - b.chapterNo);
}

/** 缓存里已经覆盖到的最大章号；下一批从它之后开始。 */
export function coveredUpTo(cache: ChapterTable): number {
  let n = 0;
  for (const e of cache) if (e.chapterNo === n + 1) n = e.chapterNo;
  return n;
}

export const chapterTableStep: StepHandler = async (ctx) => {
  const novel = await getNovel(ctx.job.novelId);
  if (!novel) throw new Error('小说不存在');
  const doc = await buildStorylineDoc(novel.id, novel.premise, novel.meta.themes);
  const outline = storylineToOutline(doc, novel);
  const total = planChapterCount(novel.targetChars);
  const perChapter = Math.round(novel.targetChars / total);

  const table: ChapterTable = readBatchCache(ctx.step.input).filter((e) => e.chapterNo <= total);
  const done = coveredUpTo(table);
  table.length = done; // 只保留连续的前缀，缺口重跑

  for (const [from, to] of chapterTableBatches(total)) {
    if (to <= done) continue;
    const count = to - from + 1;
    ctx.setMessage(`正在规划第 ${from}–${to} 章（共 ${total} 章）`);
    const spec = chapterTablePrompt({
      outline, requirements: novel.requirements, fromChapter: from, toChapter: to, totalChapters: total,
      batchTotalChars: perChapter * count, minChars: Math.max(800, Math.round(perChapter * 0.6)),
      maxChars: Math.round(perChapter * 1.5), previousEntries: table.slice(-3),
    });
    const r = await requestJson(ctx.provider, { ...spec, schema: spec.schema! }, { signal: ctx.signal, gate: ctx.gate });
    await ctx.recordUsage(r.usage);
    table.push(...normalizeBatchEntries(r.value, from, to, perChapter));
    // 跑完一批立刻落盘：下次恢复从这里接着来，不重复计费。
    await setStepInput(ctx.step.id, { ...ctx.step.input, [BATCH_CACHE_KEY]: table });
  }

  ctx.setMessage('正在写入章节表');
  const chapters = await applyChapterTable(novel.id, table);
  await setStepInput(ctx.step.id, { ...ctx.step.input, [BATCH_CACHE_KEY]: [] });
  return { outputRef: chapters[0]?.id ?? null };
};
