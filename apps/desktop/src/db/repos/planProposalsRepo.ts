import { writeAtomic, writeStatement, type AtomicWriter } from '../db';
import { nanoid } from 'nanoid';
import {
  OutlineReviewStateSchema, outlineReviewBlocks, outlineReviewSignature,
  WritingCardDataSchema,
  type WritingCardData,
  StorylineDocSchema,
  hashStoryline,
  type StorylineDoc,
} from '@the-water/shared';
import { getDb, now, selectOne, type AtomicOperation } from '../db';
import { getNovel } from './novelsRepo';
import { buildStorylineDoc, storylineOperations } from './storylineRepo';
import { chapterDependencies } from './writingRepo';
import { AwaitingReviewError } from '@/jobs/awaitingReview';
import { acceptedPlanJobOperations, publishPlanJobCompletion } from './planJobCompletion';
import { emitJobEvent } from '@/jobs/events';

export interface DocumentPlanProposal {
  id: string;
  label: string;
  title?: string;
  before: StorylineDoc;
  after: StorylineDoc;
  meta: Record<string, unknown>;
  baseHash: string;
  retiredCards?: Array<{ id: string; revision: number; before: WritingCardData }>;
  cards?: Array<{ id: string; revision: number; before: WritingCardData | null; after: WritingCardData; chapterId?: string | null; chapterNo?: number | null; order?: number }>;
}
export async function proposeDocumentPlan(
  novelId: string,
  after: StorylineDoc,
  label: string,
  meta: Record<string, unknown> = {},
  title?: string,
  cards: NonNullable<DocumentPlanProposal['cards']> = [],
  retiredCards: NonNullable<DocumentPlanProposal['retiredCards']> = [],
  commit: AtomicWriter = writeAtomic,
): Promise<string> {
  const novel = await getNovel(novelId);
  if (!novel) throw new Error('小说不存在');
  const before = await buildStorylineDoc(novelId, novel.premise, novel.meta.themes),
    id = nanoid();
  const proposal: DocumentPlanProposal = {
    id,
    label,
    title,
    cards,
    retiredCards,
    before,
    after: StorylineDocSchema.parse(after),
    meta,
    baseHash: await hashStoryline(before),
  };
  await writeStatement(commit,
    "INSERT INTO writing_proposals(id,novel_id,kind,json,created_at) VALUES (?,?,'plan',?,?)",
    [id, novelId, JSON.stringify(proposal), now()],
  );
  emitJobEvent({ type: 'plan:proposed', novelId });
  return id;
}
export async function listDocumentPlans(novelId: string): Promise<DocumentPlanProposal[]> {
  const rows = await getDb().select<{ json: string }>(
    "SELECT json FROM writing_proposals WHERE novel_id=? AND kind='plan' AND state='pending' ORDER BY created_at",
    [novelId],
  );
  return rows.map((r) => JSON.parse(r.json)).filter((p): p is DocumentPlanProposal => !!p.after);
}
/** Legacy empty proposals must remain inspectable, but cannot erase the author's plan. */
export function documentPlanIssue(p: DocumentPlanProposal): string | null {
  if (p.meta.outlineReviewOnly) return '当前大纲检查只生成报告，不产生可采纳的计划 / Inspection is read-only';
  if (p.meta.outlineReviewRequired) {
    const review = OutlineReviewStateSchema.safeParse(p.meta.outlineReview);
    if (!review.success || review.data.state !== 'complete' || !review.data.report) return '独立大纲审查尚未完成，不能采纳 / Independent outline review incomplete';
    if (outlineReviewBlocks(review.data.report)) return '大纲存在关键矛盾或缺少关键依据，请修订后重新检查 / Resolve critical outline findings before adoption';
  }
  if (p.meta.outlineDone === true && (typeof p.meta.logline !== 'string' || !p.meta.logline.trim())) {
    return '生成的大纲缺少全书主线，不能采纳；请丢弃后重新生成';
  }
  if (p.meta.outlineDone === true && p.cards?.some(c => c.after.kind === 'brief' && (!c.after.data.premise.trim() || !c.after.data.mainline.trim()))) {
    return '生成的大纲中创作简报为空，不能采纳；请丢弃后重新生成';
  }
  return null;
}
export async function acceptDocumentPlan(novelId: string, id: string, commit: AtomicWriter = writeAtomic): Promise<void> {
  const optionSelection = await selectOne<{ state: string }>('SELECT state FROM story_option_selections WHERE novel_id=? AND proposal_id=?', [novelId,id]);
  if (optionSelection?.state === 'accepted') return;
  const p = (await listDocumentPlans(novelId)).find((p) => p.id === id),
    novel = await getNovel(novelId);
  if (!p || !novel) throw new Error('计划建议不存在');
  const issue = documentPlanIssue(p);
  if (issue) throw new Error(issue);
  if (p.meta.outlineReviewRequired) {
    const review = OutlineReviewStateSchema.parse(p.meta.outlineReview);
    const input = await (await import('@/novel/outlineReview')).outlineReviewInput(novelId, p);
    if (review.signature !== await outlineReviewSignature(input)) throw new AwaitingReviewError('大纲或作者约束已变化，请重新检查 / Outline or constraints changed; review again');
  }
  const guard = await chapterDependencies(novelId, 501);
  const current = await buildStorylineDoc(novelId, novel.premise, novel.meta.themes);
  if ((await hashStoryline(current)) !== p.baseHash)
    throw new AwaitingReviewError('基础计划已改变，请重新生成建议');
  const doc = StorylineDocSchema.parse(p.after),
    t = now();
  const operations: AtomicOperation[] = [
    guard.guard,
    {
      sql: "UPDATE writing_proposals SET state='accepted' WHERE id=? AND novel_id=? AND state='pending' AND json=?",
      params: [id, novelId, JSON.stringify(p)],
      expectedRows: 1,
    },
    ...storylineOperations(novelId, doc),
  ];
  const optionAdoption = p.meta.storyOptionSelectionId ? await (await import('@/novel/storyOptionAdoption')).prepareOptionAdoption(novelId, p) : null;
  if (optionAdoption) operations.unshift(...optionAdoption.guards);
  // Upsert plans by chapter number. Existing IDs, prose and historical versions survive.
  for (const c of doc.chapters)
    operations.push({
      sql: `INSERT INTO chapters(id,novel_id,chapter_no,title,goal,target_chars,pov_character_id,beat_ids,end_hook,status,updated_at) VALUES (?,?,?,?,?,?,?,?,?,'planned',?) ON CONFLICT(novel_id,chapter_no) DO UPDATE SET title=excluded.title,goal=excluded.goal,target_chars=excluded.target_chars,pov_character_id=excluded.pov_character_id,beat_ids=excluded.beat_ids,end_hook=excluded.end_hook,archived_at=NULL,updated_at=excluded.updated_at`,
      params: [
        nanoid(),
        novelId,
        c.chapterNo,
        c.title,
        c.goal,
        c.targetChars,
        c.povCharacterId,
        JSON.stringify(c.beatIds),
        c.endHook,
        t,
      ],
    });
  if (p.meta.retireEmptyChapterSlots === true) for (const c of p.before.chapters.filter(c => !doc.chapters.some(next=>next.chapterNo===c.chapterNo))) {
    operations.push({
      sql: `UPDATE chapters SET archived_at=?,updated_at=? WHERE novel_id=? AND chapter_no=? AND archived_at IS NULL AND title='' AND goal='' AND current_version_id IS NULL AND committed_version_id IS NULL AND NOT EXISTS(SELECT 1 FROM chapter_versions WHERE chapter_id=chapters.id) AND NOT EXISTS(SELECT 1 FROM writing_cards WHERE chapter_id=chapters.id)`,
      params:[t,t,novelId,c.chapterNo],expectedRows:1,
    });
  }
  operations.push({
    sql: 'UPDATE style_feedback SET promoted=CASE WHEN phrase IN (SELECT value FROM json_each(?)) THEN 1 ELSE 0 END WHERE novel_id=?',
    params: [JSON.stringify(doc.styleProfile?.negatives.avoidWordsSoft.list ?? []), novelId],
  });
  // Retain superseded materials for recovery, but remove them from generation context.
  for (const card of p.retiredCards ?? []) operations.push({
    sql:'UPDATE writing_cards SET confirmed=0,revision=revision+1,updated_at=? WHERE id=? AND novel_id=? AND revision=? AND confirmed=1',
    params:[t,card.id,novelId,card.revision],expectedRows:1,
  });
  for (const card of p.cards ?? []) {
    const value = WritingCardDataSchema.parse(card.after);
    operations.push(
      card.before
        ? {
            sql: 'UPDATE writing_cards SET json=?,confirmed=1,revision=revision+1,updated_at=? WHERE id=? AND novel_id=? AND revision=?',
            params: [JSON.stringify(value), t, card.id, novelId, card.revision],
            expectedRows: 1,
          }
        : {
            sql: 'INSERT INTO writing_cards(id,novel_id,kind,chapter_id,sort_order,confirmed,json,updated_at) VALUES (?,?,?,COALESCE(?,(SELECT id FROM chapters WHERE novel_id=? AND chapter_no=?)),?,1,?,?)',
            params: [card.id, novelId, value.kind, card.chapterId ?? null, novelId, card.chapterNo ?? null, card.order ?? 0, JSON.stringify(value), t],
          },
    );
  }
  operations.push(
    {
      sql: "INSERT INTO storyline_snapshots(id,novel_id,json,reason,created_at) VALUES (?,?,?,'pre_rewrite',?)",
      params: [nanoid(), novelId, JSON.stringify(current), t],
    },
    {
      sql: "UPDATE novels SET meta=?,title=?,status=CASE WHEN status='draft' THEN 'planning' ELSE status END,updated_at=? WHERE id=?",
      params: [
        JSON.stringify({ ...novel.meta, ...Object.fromEntries(Object.entries(p.meta).filter(([key]) => !['storyOptionSelectionId','downstreamImpact'].includes(key))), themes: doc.themes }),
        (!novel.title || novel.title === '未命名小说') && p.title ? p.title : novel.title,
        t,
        novelId,
      ],
    },
    {
      sql: "INSERT INTO storyline_snapshots(id,novel_id,json,reason,created_at) VALUES (?,?,?,'user_commit',?)",
      params: [nanoid(), novelId, JSON.stringify(doc), t],
    },
  );
  operations.push(...acceptedPlanJobOperations(t, id));
  if (optionAdoption) operations.push(...optionAdoption.tail);
  await commit(operations);
  await publishPlanJobCompletion(novelId);
}
export async function requirePlanAccepted(id: unknown): Promise<boolean> {
  if (typeof id !== 'string') return false;
  const p = await selectOne<{ state: string }>('SELECT state FROM writing_proposals WHERE id=?', [id]);
  if (p?.state === 'accepted') return true;
  if (p?.state === 'pending') throw new AwaitingReviewError('计划建议等待作者采纳，请在发起页面审阅生成结果');
  return false;
}
