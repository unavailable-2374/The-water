import type { StepKind } from '@/db/repos/jobsRepo';
import type { Chapter } from '@/db/repos/chaptersRepo';

export interface PlannedStep { kind: StepKind; chapterId: string | null; input: Record<string, unknown> }

/** generate_novel: write every chapter in `chapters` (already ordered) that has no text, or all when `force`. */
export interface PlanOptions { fiction?: boolean; force?: boolean; only?: Set<number>; /** Insert a style_check step between adjust_length and summarize (docs/writing/README.md §7 第二期 3). */ styleCheck?: boolean }

/** 规划阶段：大纲 / 章节表（§2.1 第 1 条，改成后台步骤）。 */
export function planPlanning(opts: { outline?: boolean; chapterTable?: boolean } = {}): PlannedStep[] {
  const steps: PlannedStep[] = [];
  if (opts.outline !== false) steps.push({ kind: 'outline', chapterId: null, input: {} });
  if (opts.chapterTable !== false) steps.push({ kind: 'chapter_table', chapterId: null, input: {} });
  return steps;
}

export function planGenerate(chapters: Chapter[], opts: PlanOptions = {}): PlannedStep[] {
  const steps: PlannedStep[] = [];
  for (const c of chapters) {
    if (opts.only && !opts.only.has(c.chapterNo)) continue;
    if (!opts.force && c.currentVersionId && c.status !== 'planned') continue;
    steps.push(...chapterTriple(c, opts.styleCheck, opts.fiction));
  }
  return steps;
}

export function planRegenerate(chapter: Chapter, following: Chapter[] = [], opts: Pick<PlanOptions, 'styleCheck' | 'fiction'> = {}): PlannedStep[] {
  return [...chapterTriple(chapter, opts.styleCheck, opts.fiction), ...following.flatMap((c) => chapterTriple(c, opts.styleCheck, opts.fiction))];
}

/** One-off review of an already written chapter. */
export function planStyleCheck(chapter: Chapter): PlannedStep[] {
  return ['style_check', 'summarize', 'commit_chapter'].map(kind => ({ kind: kind as StepKind, chapterId: chapter.id, input: { chapterNo: chapter.chapterNo, standalone: true } }));
}

export interface RewriteItemInput { chapter: Chapter; mode: 'rewrite' | 'revise' | 'name_replace'; instructions: string[]; replacements?: Array<{ from: string; to: string }> }

export function planRewrite(items: RewriteItemInput[], _opts: Pick<PlanOptions, 'styleCheck' | 'fiction'> = {}): PlannedStep[] {
  const steps: PlannedStep[] = [];
  for (const it of [...items].sort((a, b) => a.chapter.chapterNo - b.chapter.chapterNo)) {
    const base = { chapterNo: it.chapter.chapterNo };
    if (it.mode === 'name_replace') {
      steps.push({ kind: 'name_replace', chapterId: it.chapter.id, input: { ...base, replacements: it.replacements ?? [] } });
      steps.push({ kind: 'style_check', chapterId: it.chapter.id, input: base }, { kind: 'summarize', chapterId: it.chapter.id, input: base }, { kind: 'commit_chapter', chapterId: it.chapter.id, input: base });
      continue;
    }
    steps.push({ kind: 'rewrite_chapter', chapterId: it.chapter.id, input: { ...base, mode: it.mode, instructions: it.instructions, replacements: it.replacements ?? [] } });
    steps.push({ kind: 'adjust_length', chapterId: it.chapter.id, input: base });
    steps.push({ kind: 'style_check', chapterId: it.chapter.id, input: base });
    steps.push({ kind: 'summarize', chapterId: it.chapter.id, input: base });
    steps.push({ kind: 'commit_chapter', chapterId: it.chapter.id, input: base });
  }
  return steps;
}

function chapterTriple(c: Chapter, _styleCheck = false, fiction = true): PlannedStep[] {
  const input = { chapterNo: c.chapterNo };
  const steps: PlannedStep[] = [
    ...(fiction ? [{ kind: 'scene_plan' as const, chapterId: c.id, input }, { kind: 'write_scenes' as const, chapterId: c.id, input }] : [{ kind: 'write_chapter' as const, chapterId: c.id, input }]),
    { kind: 'adjust_length', chapterId: c.id, input },
  ];
  steps.push({ kind: 'style_check', chapterId: c.id, input });
  steps.push({ kind: 'summarize', chapterId: c.id, input }, { kind: 'commit_chapter', chapterId: c.id, input });
  return steps;
}
