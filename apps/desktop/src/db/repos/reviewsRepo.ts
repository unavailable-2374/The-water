import { nanoid } from 'nanoid';
import { z } from 'zod';
import { getDb, now, selectOne } from '../db';
import { parseJson } from '../mappers';
import { StyleReviewResultSchema } from '@/llm/prompts/styleReview';
import { ConsistencyResultSchema } from '@/llm/prompts/consistencyReview';

/** Everything a style check produced for one chapter version (docs/writing/README.md §5.4). */
export const ChapterReviewJsonSchema = z.object({
  metricScore: z.number().default(100),
  metricFindings: z.array(z.object({ key: z.string(), label: z.string(), value: z.number(), target: z.tuple([z.number(), z.number()]), hard: z.boolean(), hint: z.string() })).default([]),
  lintIssues: z.array(z.object({ rule: z.string(), severity: z.enum(['block', 'warn']), message: z.string(), quote: z.string().default('') })).default([]),
  aiTellScore: z.number().default(100),
  llm: StyleReviewResultSchema.nullable().default(null),
  /** 设定校对通道（数值/时间线/称呼/规则），与 llm 风格审校相互独立。 */
  consistency: ConsistencyResultSchema.nullable().default(null),
  /** Set when the step auto-revised the chapter once. */
  revisedVersionId: z.string().nullable().default(null),
  revisionInstructions: z.array(z.string()).default([]),
});
export type ChapterReviewJson = z.infer<typeof ChapterReviewJsonSchema>;

export interface ChapterReview {
  id: string; novelId: string; chapterId: string; chapterVersionId: string; styleScore: number; oocCount: number; verdict: 'pass' | 'revise';
  report: ChapterReviewJson; jobStepId: string | null; createdAt: number;
}
interface Raw { id: string; novel_id: string; chapter_id: string; chapter_version_id: string; style_score: number; ooc_count: number; verdict: string; json: string; job_step_id: string | null; created_at: number }
const map = (r: Raw): ChapterReview => ({
  id: r.id, novelId: r.novel_id, chapterId: r.chapter_id, chapterVersionId: r.chapter_version_id, styleScore: r.style_score, oocCount: r.ooc_count,
  verdict: r.verdict === 'revise' ? 'revise' : 'pass', report: parseJson(ChapterReviewJsonSchema, r.json, ChapterReviewJsonSchema.parse({})), jobStepId: r.job_step_id, createdAt: r.created_at,
});

export async function saveReview(input: { novelId: string; chapterId: string; chapterVersionId: string; styleScore: number; oocCount: number; verdict: 'pass' | 'revise'; report: ChapterReviewJson; jobStepId?: string | null }): Promise<ChapterReview> {
  const id = nanoid();
  await getDb().execute(
    'INSERT INTO chapter_reviews(id, novel_id, chapter_id, chapter_version_id, style_score, ooc_count, verdict, json, job_step_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [id, input.novelId, input.chapterId, input.chapterVersionId, Math.round(input.styleScore), input.oocCount, input.verdict, JSON.stringify(input.report), input.jobStepId ?? null, now()],
  );
  return (await getReview(id))!;
}
export async function getReview(id: string): Promise<ChapterReview | null> {
  const r = await selectOne<Raw>('SELECT * FROM chapter_reviews WHERE id = ?', [id]);
  return r ? map(r) : null;
}
export async function latestReviewForChapter(chapterId: string): Promise<ChapterReview | null> {
  const r = await selectOne<Raw>('SELECT * FROM chapter_reviews WHERE chapter_id = ? ORDER BY created_at DESC LIMIT 1', [chapterId]);
  return r ? map(r) : null;
}
export async function reviewForVersion(chapterVersionId: string): Promise<ChapterReview | null> {
  const r = await selectOne<Raw>('SELECT * FROM chapter_reviews WHERE chapter_version_id = ? ORDER BY created_at DESC LIMIT 1', [chapterVersionId]);
  return r ? map(r) : null;
}
export async function findReviewByStep(jobStepId: string): Promise<ChapterReview | null> {
  const r = await selectOne<Raw>('SELECT * FROM chapter_reviews WHERE job_step_id = ? ORDER BY created_at DESC LIMIT 1', [jobStepId]);
  return r ? map(r) : null;
}
export async function listReviews(novelId: string): Promise<ChapterReview[]> {
  return (await getDb().select<Raw>('SELECT * FROM chapter_reviews WHERE novel_id = ? ORDER BY created_at DESC', [novelId])).map(map);
}
