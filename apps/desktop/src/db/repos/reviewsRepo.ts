import { nanoid } from 'nanoid';
import { z } from 'zod';
import { ChapterLengthReviewSchema, ReviewIssueSchema, StoryAssessmentSchema, sha256Hex, verifyEvidence } from '@the-water/shared';
import { getVersion, getChapter } from './chaptersRepo';
import { chapterDependencies } from './writingRepo';
import { getNovel } from './novelsRepo';
import { docTypeGuide } from '@/novel/docTypes';
import { AwaitingReviewError } from '@/jobs/awaitingReview';
import { getDb, now, selectOne } from '../db';
import { parseJson } from '../mappers';
import { StyleReviewResultSchema } from '@/llm/prompts/styleReview';
import { ConsistencyResultSchema } from '@/llm/prompts/consistencyReview';

/** Everything a style check produced for one chapter version (docs/writing/README.md §5.4). */
export const ChapterReviewJsonSchema = z.object({
  narrative: z.array(ReviewIssueSchema).optional(),
  story: StoryAssessmentSchema.optional(),
  lengthReview: ChapterLengthReviewSchema.optional(),
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
  contentHash: string; dependencyHash: string; valid: boolean;
  id: string; novelId: string; chapterId: string; chapterVersionId: string; styleScore: number; oocCount: number; verdict: 'pass' | 'revise';
  report: ChapterReviewJson; jobStepId: string | null; createdAt: number;
}
interface Raw { content_hash: string; dependency_hash: string; valid: number; id: string; novel_id: string; chapter_id: string; chapter_version_id: string; style_score: number; ooc_count: number; verdict: string; json: string; job_step_id: string | null; created_at: number }
const map = (r: Raw): ChapterReview => ({
  contentHash: r.content_hash, dependencyHash: r.dependency_hash, valid: !!r.valid,
  id: r.id, novelId: r.novel_id, chapterId: r.chapter_id, chapterVersionId: r.chapter_version_id, styleScore: r.style_score, oocCount: r.ooc_count,
  verdict: r.verdict === 'revise' ? 'revise' : 'pass', report: parseJson(ChapterReviewJsonSchema, r.json, ChapterReviewJsonSchema.parse({})), jobStepId: r.job_step_id, createdAt: r.created_at,
});

export async function saveReview(input: { novelId: string; chapterId: string; chapterVersionId: string; styleScore: number; oocCount: number; verdict: 'pass' | 'revise'; report: ChapterReviewJson; jobStepId?: string | null; contentHash?: string; dependencyHash?: string }): Promise<ChapterReview> {
  const id = nanoid();
  const version = await getVersion(input.chapterVersionId), chapter = await getChapter(input.chapterId);
  if (!version || !chapter || version.chapterId !== chapter.id || chapter.novelId !== input.novelId) throw new Error('审查版本不属于此章节');
  const hash = await sha256Hex(version.content), deps = await chapterDependencies(input.novelId, chapter.chapterNo);
  if (input.contentHash && input.contentHash !== hash || input.dependencyHash && input.dependencyHash !== deps.hash) throw new AwaitingReviewError('审查期间正文或依赖已变化，请重新审查');
  if (new Set(input.report.narrative?.map(i=>i.id)).size !== (input.report.narrative?.length ?? 0)) throw new Error('重复的审稿问题 ID');
  if (new Set(input.report.story?.expectations.map(item=>item.id)).size !== (input.report.story?.expectations.length ?? 0)) throw new Error('重复的阅读期待 ID');
  if (input.report.lengthReview?.actions.some(action => !input.report.narrative?.some(issue => issue.id === action.issueId))) throw new Error('篇幅建议必须引用本次审查中有正文依据的问题');
  for (const issue of input.report.narrative ?? []) if (!verifyEvidence(version.content, issue.evidence)) throw new AwaitingReviewError('审查问题未能定位到原文，请重新审查');
  for (const item of [...(input.report.story?.changes ?? []),...(input.report.story?.expectations ?? [])]) if (!verifyEvidence(version.content,item.evidence)) throw new AwaitingReviewError('故事推进结果未能定位到原文，请重新审查');
  await getDb().atomic([deps.guard,{sql:'UPDATE chapter_versions SET id=id WHERE id=? AND content=?',params:[version.id,version.content],expectedRows:1},{sql:
    'INSERT INTO chapter_reviews(id, novel_id, chapter_id, chapter_version_id, style_score, ooc_count, verdict, json, job_step_id, created_at, content_hash, dependency_hash, valid) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1)',
    params:[id, input.novelId, input.chapterId, input.chapterVersionId, Math.round(input.styleScore), input.oocCount, input.verdict, JSON.stringify(input.report), input.jobStepId ?? null, now(), hash, deps.hash]}]);
  return (await getReview(id))!;
}
export async function getReview(id: string): Promise<ChapterReview | null> {
  const r = await selectOne<Raw>('SELECT * FROM chapter_reviews WHERE id = ?', [id]);
  return r ? map(r) : null;
}
export async function latestReviewForChapter(chapterId: string): Promise<ChapterReview | null> {
  const r = await selectOne<Raw>('SELECT * FROM chapter_reviews WHERE chapter_id = ? ORDER BY created_at DESC,rowid DESC LIMIT 1', [chapterId]);
  return r ? map(r) : null;
}
export async function reviewForVersion(chapterVersionId: string): Promise<ChapterReview | null> {
  const r = await selectOne<Raw>('SELECT * FROM chapter_reviews WHERE chapter_version_id = ? ORDER BY created_at DESC,rowid DESC LIMIT 1', [chapterVersionId]);
  return r ? map(r) : null;
}
export async function findReviewByStep(jobStepId: string): Promise<ChapterReview | null> {
  const r = await selectOne<Raw>('SELECT * FROM chapter_reviews WHERE job_step_id = ? ORDER BY created_at DESC,rowid DESC LIMIT 1', [jobStepId]);
  return r ? map(r) : null;
}
export async function listReviews(novelId: string): Promise<ChapterReview[]> {
  return (await getDb().select<Raw>('SELECT * FROM chapter_reviews WHERE novel_id = ? ORDER BY created_at DESC', [novelId])).map(map);
}

/** Only the exact approved review attached to valid committed prose can supply reader progress. */
export async function committedStoryProgress(novelId: string, beforeChapter: number) {
  const rows = await getDb().select<{chapter_no:number;version_id:string;json:string}>(
    `SELECT c.chapter_no,cc.version_id,r.json FROM chapters c
     JOIN chapter_commits cc ON cc.chapter_id=c.id AND cc.version_id=c.committed_version_id
     JOIN chapter_reviews r ON r.id=cc.review_id
     WHERE c.novel_id=? AND c.chapter_no<? AND c.archived_at IS NULL AND c.memory_status='valid' AND r.valid=1
     ORDER BY c.chapter_no,cc.created_at`,[novelId,beforeChapter]);
  const changes = new Map<number,unknown>();
  const expectations = new Map<string,unknown>();
  for (const row of rows) {
    const story = ChapterReviewJsonSchema.parse(JSON.parse(row.json)).story;
    if (!story || story.verdict!=='ready') continue;
    changes.set(row.chapter_no,{chapterNo:row.chapter_no,versionId:row.version_id,changes:story.changes,nextInterest:story.nextInterest});
    for(const expectation of story.expectations) expectations.set(expectation.id,{...expectation,chapterNo:row.chapter_no,versionId:row.version_id});
  }
  return {recentChanges:[...changes.values()].slice(-2),expectations:[...expectations.values()]};
}

/**
 * 每章最近一次审校结果（chapterId → review）。
 * 章节列表要一眼看出哪几章「风格未达标」，逐章查太慢，这里一次取回（§2.3 第 3 条）。
 */
export async function latestReviewByChapter(novelId: string): Promise<Map<string, ChapterReview>> {
  const rows = await getDb().select<Raw>('SELECT * FROM (SELECT *,ROW_NUMBER() OVER (PARTITION BY chapter_id ORDER BY created_at DESC,rowid DESC) AS rank FROM chapter_reviews WHERE novel_id=?) WHERE rank=1', [novelId]);
  const out = new Map<string, ChapterReview>();
  // 按时间升序覆盖写入，最后留下的就是每章最新的一条。
  for (const r of rows) out.set(r.chapter_id, map(r));
  return out;
}

/** A passed result is usable only for these exact bytes and dependencies. */
export async function assertReviewPass(id: string, versionId: string, contentHash: string, dependencyHash: string): Promise<ChapterReview> {
  const review = await getReview(id);
  if (!review || !review.valid || review.chapterVersionId !== versionId || review.contentHash !== contentHash || review.dependencyHash !== dependencyHash) throw new AwaitingReviewError('审查结果已过期，请重新审查');
  const latest=await reviewForVersion(versionId);
  if(latest?.id!==id) throw new AwaitingReviewError('存在更新的审查结果，请使用最新审查');
  const novel = await getNovel(review.novelId);
  if (novel && docTypeGuide(novel.requirements.docType).fiction && !review.report.narrative) throw new AwaitingReviewError('缺少基础叙事审查');
  if (review.report.story && review.report.story.verdict !== 'ready') throw new AwaitingReviewError('故事推进仍需处理，请修订正文或调整场景计划后重新审查');
  if (review.verdict === 'revise' || review.report.narrative?.some(i=>i.severity==='block')) {
    const resolved = new Set((await getDb().select<{ issue_id: string }>('SELECT issue_id FROM review_resolutions WHERE review_id=?', [id])).map(r => r.issue_id));
    const blocking = (review.report.narrative ?? []).filter(i => i.severity === 'block');
    if (!blocking.length || blocking.some(i => !resolved.has(i.id))) throw new AwaitingReviewError('仍有阻断问题，等待作者修改或记录误报原因');
  }
  return review;
}
export async function dismissReviewIssue(reviewId: string, issueId: string, reason: string): Promise<void> {
  if (!reason.trim()) throw new Error('请填写误报依据');
  const review = await getReview(reviewId);
  if (!review?.valid || !review.report.narrative?.some(i => i.id === issueId)) throw new Error('问题不存在或审查已失效');
  await getDb().execute('INSERT INTO review_resolutions(id,review_id,issue_id,reason,created_at) VALUES (?,?,?,?,?) ON CONFLICT(review_id,issue_id) DO UPDATE SET reason=excluded.reason,created_at=excluded.created_at', [nanoid(), reviewId, issueId, reason.trim(), now()]);
}
