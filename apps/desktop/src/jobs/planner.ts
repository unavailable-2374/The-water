import type { StepKind } from '@/db/repos/jobsRepo';
import type { Chapter } from '@/db/repos/chaptersRepo';

export interface PlannedStep { kind: StepKind; chapterId: string | null; input: Record<string, unknown> }

/** generate_novel: write every chapter in `chapters` (already ordered) that has no text, or all when `force`. */
export interface PlanOptions { force?: boolean; only?: Set<number>; /** Insert a style_check step between adjust_length and summarize (docs/writing/README.md §7 第二期 3). */ styleCheck?: boolean }

export function planGenerate(chapters: Chapter[], opts: PlanOptions = {}): PlannedStep[] {
  const steps: PlannedStep[] = [];
  for (const c of chapters) {
    if (opts.only && !opts.only.has(c.chapterNo)) continue;
    if (!opts.force && c.currentVersionId && c.status !== 'planned') continue;
    steps.push(...chapterTriple(c, opts.styleCheck));
  }
  return steps;
}

export function planRegenerate(chapter: Chapter, following: Chapter[] = [], opts: Pick<PlanOptions, 'styleCheck'> = {}): PlannedStep[] {
  return [...chapterTriple(chapter, opts.styleCheck), ...following.flatMap((c) => chapterTriple(c, opts.styleCheck))];
}

/** One-off review of an already written chapter. */
export function planStyleCheck(chapter: Chapter): PlannedStep[] {
  return [{ kind: 'style_check', chapterId: chapter.id, input: { chapterNo: chapter.chapterNo, standalone: true } }];
}

export interface RewriteItemInput { chapter: Chapter; mode: 'rewrite' | 'revise' | 'name_replace'; instructions: string[]; replacements?: Array<{ from: string; to: string }> }

export function planRewrite(items: RewriteItemInput[], opts: Pick<PlanOptions, 'styleCheck'> = {}): PlannedStep[] {
  const steps: PlannedStep[] = [];
  for (const it of [...items].sort((a, b) => a.chapter.chapterNo - b.chapter.chapterNo)) {
    const base = { chapterNo: it.chapter.chapterNo };
    if (it.mode === 'name_replace') {
      steps.push({ kind: 'name_replace', chapterId: it.chapter.id, input: { ...base, replacements: it.replacements ?? [] } });
      continue;
    }
    steps.push({ kind: 'rewrite_chapter', chapterId: it.chapter.id, input: { ...base, mode: it.mode, instructions: it.instructions, replacements: it.replacements ?? [] } });
    steps.push({ kind: 'adjust_length', chapterId: it.chapter.id, input: base });
    if (opts.styleCheck) steps.push({ kind: 'style_check', chapterId: it.chapter.id, input: base });
    steps.push({ kind: 'summarize', chapterId: it.chapter.id, input: base });
  }
  return steps;
}

function chapterTriple(c: Chapter, styleCheck = false): PlannedStep[] {
  const input = { chapterNo: c.chapterNo };
  const steps: PlannedStep[] = [
    { kind: 'write_chapter', chapterId: c.id, input },
    { kind: 'adjust_length', chapterId: c.id, input },
  ];
  if (styleCheck) steps.push({ kind: 'style_check', chapterId: c.id, input });
  steps.push({ kind: 'summarize', chapterId: c.id, input });
  return steps;
}
