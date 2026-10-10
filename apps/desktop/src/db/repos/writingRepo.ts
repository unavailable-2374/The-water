import { writeAtomic, type AtomicWriter } from '../db';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import {
  CanonEventSchema,
  WritingCardDataSchema,
  MaterialCardSchema,
  canonicalJson,
  anchorEvidence,
  sha256Hex,
  type CanonEvent,
  type StoryBible,
  type WritingCardData,
} from '@the-water/shared';
import { getDb, now, selectOne, type AtomicOperation } from '../db';
import { getChapter, getVersion } from './chaptersRepo';
import { structureCommitOperations } from './chapterStructureRepo';
import { AwaitingReviewError } from '@/jobs/awaitingReview';
import { acceptedPlanJobOperations, discardedPlanJobOperations, publishPlanJobCompletion } from './planJobCompletion';
import { emitJobEvent } from '@/jobs/events';
import { sceneReferenceIssues } from '@/novel/sceneReferences';
import { acceptedChapterJobOperations } from './chapterJobCompletion';

export type WritingCard = WritingCardData & {
  id: string;
  novelId: string;
  chapterId: string | null;
  order: number;
  revision: number;
  confirmed: boolean;
};
interface RawCard {
  id: string;
  novel_id: string;
  chapter_id: string | null;
  sort_order: number;
  revision: number;
  confirmed: number;
  json: string;
}
function mapCard(r: RawCard): WritingCard {
  return {
    ...WritingCardDataSchema.parse(JSON.parse(r.json)),
    id: r.id,
    novelId: r.novel_id,
    chapterId: r.chapter_id,
    order: r.sort_order,
    revision: r.revision,
    confirmed: !!r.confirmed,
  };
}
export async function listWritingCards(
  novelId: string,
  filter: {
    kind?: WritingCardData['kind'];
    chapterId?: string;
    confirmed?: boolean;
    context?: { chapterId: string; chapterNo: number };
  } = {},
): Promise<WritingCard[]> {
  const clauses = [
      'novel_id=?',
      '(chapter_id IS NULL OR chapter_id IN (SELECT id FROM chapters WHERE archived_at IS NULL))',
    ],
    params: unknown[] = [novelId];
  if (filter.kind) {
    clauses.push('kind=?');
    params.push(filter.kind);
  }
  if (filter.chapterId) {
    clauses.push('chapter_id=?');
    params.push(filter.chapterId);
  }
  if (filter.confirmed !== undefined) {
    clauses.push('confirmed=?');
    params.push(filter.confirmed ? 1 : 0);
  }
  if (filter.context) {
    clauses.push(
      "(kind NOT IN ('scene','volume') OR kind='scene' AND chapter_id=? OR kind='volume' AND json_extract(json,'$.data.startChapterNo')<=? AND json_extract(json,'$.data.endChapterNo')>=?)",
    );
    params.push(filter.context.chapterId, filter.context.chapterNo, filter.context.chapterNo);
  }
  return (
    await getDb().select<RawCard>(
      `SELECT * FROM writing_cards WHERE ${clauses.join(' AND ')} ORDER BY sort_order,id`,
      params,
    )
  ).map(mapCard);
}
/** Imported provenance is historical source material, never certified local canon. */
export async function pageImportedMaterials(novelId: string, page = 0) {
  const total =
    (await selectOne<{ n: number }>('SELECT COUNT(*) AS n FROM writing_imports WHERE novel_id=?', [novelId]))
      ?.n ?? 0;
  const rows = await getDb().select<{
    id: string;
    source_version_id: string;
    local_id: string;
    json: string;
  }>(
    'SELECT id,source_version_id,local_id,json FROM writing_imports WHERE novel_id=? ORDER BY created_at,id LIMIT 50 OFFSET ?',
    [novelId, Math.max(0, page) * 50],
  );
  return {
    total,
    entries: rows.map((r) => ({
      id: r.id,
      sourceVersionId: r.source_version_id,
      localId: r.local_id,
      card: MaterialCardSchema.parse(JSON.parse(r.json)),
    })),
  };
}
/** Caller must be an explicit author edit/accept action. AI uses proposeCard. */
export async function saveWritingCard(
  novelId: string,
  card: WritingCardData,
  opts: {
    id?: string;
    chapterId?: string | null;
    order?: number;
    expectedRevision?: number;
    confirmed?: boolean;
    commit?: AtomicWriter;
  } = {},
): Promise<string> {
  const value = WritingCardDataSchema.parse(card),
    id = opts.id ?? nanoid();
  if (opts.chapterId) {
    const chapter = await getChapter(opts.chapterId);
    if (chapter?.novelId !== novelId) throw new Error('场景章节不属于此作品');
  }
  const old = await selectOne<RawCard>('SELECT * FROM writing_cards WHERE id=? AND novel_id=?', [
    id,
    novelId,
  ]);
  if (opts.confirmed) await validateCardReferences(novelId, value, opts.chapterId ?? old?.chapter_id ?? null);
  if (old && mapCard(old).kind !== value.kind) throw new Error('不能改变已有卡片的类型');
  const time=now();
  const operations: AtomicOperation[] = old ? [{
    sql:'UPDATE writing_cards SET json=?,confirmed=?,sort_order=?,revision=revision+1,updated_at=? WHERE id=? AND novel_id=? AND revision=?',
    params:[JSON.stringify(value),opts.confirmed ? 1:0,opts.order ?? old.sort_order,time,id,novelId,opts.expectedRevision ?? old.revision],
    expectedRows:1,
  }] : [{
    sql:'INSERT INTO writing_cards(id,novel_id,kind,chapter_id,sort_order,confirmed,json,updated_at) VALUES (?,?,?,?,?,?,?,?)',
    params:[id,novelId,value.kind,opts.chapterId ?? null,opts.order ?? 0,opts.confirmed ? 1:0,JSON.stringify(value),time],
  }];
  if (value.kind === 'scene' && opts.confirmed) operations.push(...acceptedPlanJobOperations(time,undefined,novelId));
  await (opts.commit ?? writeAtomic)(operations);
  if (value.kind === 'scene' && opts.confirmed) await publishPlanJobCompletion(novelId);
  return id;
}
export async function proposeCard(
  novelId: string,
  card: WritingCardData,
  chapterId: string | null,
  base: { id: string; revision: number } | null = null,
): Promise<string> {
  const id = nanoid();
  await getDb().execute(
    "INSERT INTO writing_proposals(id,novel_id,chapter_id,kind,json,created_at) VALUES (?,?,?,'plan',?,?)",
    [id, novelId, chapterId, JSON.stringify({ card: WritingCardDataSchema.parse(card), base }), now()],
  );
  emitJobEvent({type:'plan:proposed',novelId});
  return id;
}

export interface PlanProposal {
  id: string;
  chapterId: string | null;
  card: WritingCardData;
  base: { id: string; revision: number } | null;
  /** Generated scene position, independent of adoption order. */
  order?: number;
}
export async function listPlanProposals(novelId: string): Promise<PlanProposal[]> {
  const rows = await getDb().select<{ id: string; chapter_id: string | null; json: string }>(
    "SELECT * FROM writing_proposals WHERE novel_id=? AND kind='plan' AND state='pending' ORDER BY created_at,rowid",
    [novelId],
  );
  return rows.flatMap((r) => {
    const data = JSON.parse(r.json);
    return data.card
      ? [
          {
            id: r.id,
            chapterId: r.chapter_id,
            card: WritingCardDataSchema.parse(data.card),
            base: data.base ?? null,
            order: data.order,
          },
        ]
      : [];
  });
}
export async function acceptPlanProposal(novelId: string, proposalId: string, commit: AtomicWriter = writeAtomic): Promise<void> {
  const proposal = (await listPlanProposals(novelId)).find((p) => p.id === proposalId);
  if (!proposal) throw new Error('计划建议不存在');
  if (proposal.base) {
    const base = await selectOne<RawCard>('SELECT * FROM writing_cards WHERE id=? AND novel_id=?', [
      proposal.base.id,
      novelId,
    ]);
    if (!base || mapCard(base).kind !== proposal.card.kind || base.chapter_id !== proposal.chapterId)
      throw new Error('建议的基础卡片类型或所属章节已变化');
  }
  if (proposal.order !== undefined && (!Number.isSafeInteger(proposal.order) || proposal.order < 0 || proposal.card.kind !== 'scene')) throw new Error('场景建议顺序无效');
  await validateCardReferences(novelId, proposal.card, proposal.chapterId);
  const t = now();
  await commit([
    {
      sql: "UPDATE writing_proposals SET state='accepted' WHERE id=? AND novel_id=? AND state='pending'",
      params: [proposalId, novelId],
      expectedRows: 1,
    },
    proposal.base
      ? {
          sql: 'UPDATE writing_cards SET json=?,revision=revision+1,confirmed=1,updated_at=? WHERE id=? AND novel_id=? AND revision=?',
          params: [JSON.stringify(proposal.card), t, proposal.base.id, novelId, proposal.base.revision],
          expectedRows: 1,
        }
      : {
          sql: 'INSERT INTO writing_cards(id,novel_id,kind,chapter_id,sort_order,confirmed,json,updated_at) VALUES (?,?,?,?,COALESCE(?,(SELECT COALESCE(MAX(sort_order),0)+1 FROM writing_cards WHERE novel_id=?)),1,?,?)',
          params: [
            nanoid(),
            novelId,
            proposal.card.kind,
            proposal.chapterId,
            proposal.order ?? null,
            novelId,
            JSON.stringify(proposal.card),
            t,
          ],
        },
    ...acceptedPlanJobOperations(t, proposalId),
  ]);
  await publishPlanJobCompletion(novelId);
}

export async function validateCardReferences(novelId: string, card: WritingCardData, chapterId: string | null) {
  const characters = new Set(
    (
      await getDb().select<{ id: string }>('SELECT id FROM storyline_characters WHERE novel_id=?', [novelId])
    ).map((c) => c.id),
  );
  const ids =
    card.kind === 'scene'
      ? [...card.data.characterIds, ...(card.data.povCharacterId ? [card.data.povCharacterId] : [])]
      : card.kind === 'thread'
        ? card.data.characterIds
        : card.kind === 'character'
          ? [card.data.characterId]
          : [];
  if (ids.some((id) => !characters.has(id))) throw new Error('创作资料引用了不存在的人物');
  if (card.kind === 'volume') {
    const arcs = new Set(
      (await getDb().select<{ id: string }>('SELECT id FROM storyline_arcs WHERE novel_id=?', [novelId])).map(
        (a) => a.id,
      ),
    );
    if (card.data.arcIds.some((id) => !arcs.has(id))) throw new Error('分卷引用了不存在的故事弧');
  }
  if (card.kind === 'scene') {
    const chapter = chapterId ? await getChapter(chapterId) : null;
    if (chapter?.novelId !== novelId) throw new Error('场景必须关联本作品的章节');
    const cards = await listWritingCards(novelId, { confirmed: true });
    if (
      (card.data.volumeId && !cards.some((c) => c.id === card.data.volumeId && c.kind === 'volume')) ||
      card.data.threadIds.some((id) => !cards.some((c) => c.id === id && c.kind === 'thread'))
    )
      throw new Error('场景引用的分卷或伏笔尚未确认');
    const facts = new Set((await listCanonEvents(novelId, chapter.chapterNo)).map((e) => e.id));
    const issues = sceneReferenceIssues(card.data, {
      characterIds: characters,
      volumes: new Map(cards.flatMap(c => c.kind === 'volume' ? [[c.id, c.data] as const] : [])),
      threadIds: new Set(cards.filter(c => c.kind === 'thread').map(c => c.id)),
      factIds: facts,
    }, chapter.chapterNo);
    if (issues.length) throw new Error(issues[0]!.message);
  }
}
export async function discardProposal(id: string, commit: AtomicWriter = writeAtomic): Promise<void> {
  const proposal=await selectOne<{novel_id:string}>('SELECT novel_id FROM writing_proposals WHERE id=?',[id]);
  if (!proposal) return;
  const time=now();
  await commit([
    {sql:"UPDATE writing_proposals SET state='discarded' WHERE id=? AND state IN ('pending','conflict')",params:[id]},
    {sql:"UPDATE story_option_selections SET state='discarded' WHERE proposal_id=? AND state='pending'",params:[id]},
    ...discardedPlanJobOperations(time,id),
    ...acceptedPlanJobOperations(time,id),
  ]);
  await publishPlanJobCompletion(proposal.novel_id);
}
/** Reorder cards with revision checks; scene meaning is unchanged. */
export async function reorderCards(cards: WritingCard[], commit: AtomicWriter = writeAtomic): Promise<void> {
  await commit(
    cards.map((c, i) => ({
      sql: 'UPDATE writing_cards SET sort_order=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?',
      params: [i, now(), c.id, c.revision],
      expectedRows: 1,
    })),
  );
}
export async function splitScene(card: WritingCard, commit: AtomicWriter = writeAtomic): Promise<void> {
  if (card.kind !== 'scene') throw new Error('请选择场景');
  const half = Math.max(100, Math.ceil(card.data.targetChars / 2));
  const left = { kind: 'scene', data: { ...card.data, targetChars: half } };
  await commit([
    {
      sql: 'UPDATE writing_cards SET confirmed=0,revision=revision+1,json=?,updated_at=? WHERE id=? AND revision=?',
      params: [JSON.stringify(left), now(), card.id, card.revision],
      expectedRows: 1,
    },
    {
      sql: 'UPDATE writing_cards SET sort_order=sort_order+1 WHERE novel_id=? AND chapter_id IS ? AND sort_order>?',
      params: [card.novelId, card.chapterId, card.order],
    },
    {
      sql: "INSERT INTO writing_cards(id,novel_id,kind,chapter_id,sort_order,confirmed,json,updated_at) VALUES (?,?,'scene',?,?,0,?,?)",
      params: [nanoid(), card.novelId, card.chapterId, card.order + 1, JSON.stringify(left), now()],
    },
  ]);
}
export async function mergeScenes(first: WritingCard, second: WritingCard, commit: AtomicWriter = writeAtomic): Promise<void> {
  if (
    first.kind !== 'scene' ||
    second.kind !== 'scene' ||
    first.novelId !== second.novelId ||
    first.chapterId !== second.chapterId
  )
    throw new Error('只能合并同一章场景');
  const merged = WritingCardDataSchema.parse({
    kind: 'scene',
    data: {
      ...first.data,
      goal: [first.data.goal, second.data.goal].join('\n'),
      obstacle: [first.data.obstacle, second.data.obstacle].join('\n'),
      turn: [first.data.turn, second.data.turn].join('\n'),
      outcome: second.data.outcome,
      targetChars: first.data.targetChars + second.data.targetChars,
      characterIds: [...new Set([...first.data.characterIds, ...second.data.characterIds])],
      threadIds: [...new Set([...first.data.threadIds, ...second.data.threadIds])],
    },
  });
  await commit([
    {
      sql: 'UPDATE writing_cards SET json=?,confirmed=0,revision=revision+1,updated_at=? WHERE id=? AND revision=?',
      params: [JSON.stringify(merged), now(), first.id, first.revision],
      expectedRows: 1,
    },
    {
      sql: 'DELETE FROM writing_cards WHERE id=? AND revision=?',
      params: [second.id, second.revision],
      expectedRows: 1,
    },
  ]);
}

/** Each SQL read has an equivalent CAS predicate evaluated inside the commit transaction. */
export async function chapterDependencies(
  novelId: string,
  chapterNo: number,
): Promise<{ hash: string; guard: AtomicOperation }> {
  const queries = [
    {sql:"SELECT COALESCE((SELECT value FROM settings WHERE key=?),'')",params:[`authorNote:${novelId}`]},
    {
      sql: "SELECT COALESCE((SELECT json_array(json_extract(json,'$.nodes'),json_extract(json,'$.relations'),json_extract(json,'$.secrets'),json_extract(json,'$.growth'),json_extract(json,'$.preferences'),json_extract(json,'$.lockedNodeIds'),json_extract(json,'$.lockedAnchors')) FROM story_graphs WHERE novel_id=?),'')",
      params: [novelId],
    },
    {
      sql: 'SELECT json_array(premise,requirements,style_profile,derivative,meta) FROM novels WHERE id=?',
      params: [novelId],
    },
    ...Object.entries({
      characters: 'id,name,aliases,role,description,arc,relationships,voice,sort_order',
      settings: 'id,name,kind,description,lore,sort_order',
      arcs: 'id,title,summary,start_chapter_no,end_chapter_no,sort_order',
      beats: 'id,arc_id,title,summary,chapter_no,character_ids,setting_ids,sort_order',
    }).map(([table, fields]) => ({
      sql: `SELECT json_group_array(json_array(${fields})) FROM (SELECT * FROM storyline_${table} WHERE novel_id=? ORDER BY id)`,
      params: [novelId],
    })),
    {
      sql: "SELECT json_group_array(json_array(id,revision,json)) FROM (SELECT * FROM writing_cards WHERE novel_id=? AND confirmed=1 AND (kind NOT IN ('scene','volume') OR kind='scene' AND chapter_id=(SELECT id FROM chapters WHERE novel_id=? AND chapter_no=?) OR kind='volume' AND json_extract(json,'$.data.startChapterNo')<=? AND json_extract(json,'$.data.endChapterNo')>=?) ORDER BY id)",
      params: [novelId, novelId, chapterNo, chapterNo, chapterNo],
    },
    {
      sql: 'SELECT json_group_array(json_array(id,chapter_no,title,goal,target_chars,pov_character_id,beat_ids,end_hook)) FROM (SELECT * FROM chapters WHERE novel_id=? AND chapter_no<=? ORDER BY chapter_no)',
      params: [novelId, chapterNo],
    },
    {
      sql: 'SELECT json_group_array(json_array(id,committed_version_id,memory_status)) FROM (SELECT * FROM chapters WHERE novel_id=? AND chapter_no<? ORDER BY chapter_no)',
      params: [novelId, chapterNo],
    },
  ];
  const values: string[] = [];
  for (const q of queries) {
    const r = await getDb().select<{ value: string }>(`SELECT (${q.sql}) AS value`, q.params);
    values.push(r[0]?.value ?? '');
  }
  return {
    hash: await sha256Hex(canonicalJson(values)),
    guard: {
      sql: `UPDATE novels SET id=id WHERE id=? AND ${queries.map((q) => `(${q.sql})=?`).join(' AND ')}`,
      params: [novelId, ...queries.flatMap((q, i) => [...q.params, values[i]])],
      expectedRows: 1,
    },
  };
}

export function invalidateMemoryOperations(novelId: string, from: number): AtomicOperation[] {
  return [
    {
      sql: "UPDATE chapters SET memory_status='stale', status=CASE WHEN committed_version_id IS NOT NULL THEN 'stale' ELSE status END WHERE novel_id=? AND chapter_no>=?",
      params: [novelId, from],
    },
    { sql: 'UPDATE canon_events SET valid=0 WHERE novel_id=? AND chapter_no>=?', params: [novelId, from] },
    {
      sql: 'UPDATE story_bible_snapshots SET valid=0 WHERE novel_id=? AND after_chapter_no>=?',
      params: [novelId, from],
    },
    {
      sql: 'UPDATE chapter_reviews SET valid=0 WHERE chapter_id IN (SELECT id FROM chapters WHERE novel_id=? AND chapter_no>=?)',
      params: [novelId, from],
    },
  ];
}

export const ExtractionSchema = z.object({
  summary: z.string().max(2000),
  events: z.array(CanonEventSchema).max(200),
});
export type Extraction = z.infer<typeof ExtractionSchema>;
interface ExtractionRow {
  id: string;
  chapter_id: string;
  version_id: string;
  content_hash: string;
  dependency_hash: string;
  review_id: string;
  json: string;
}

export async function stageExtraction(
  chapterId: string,
  versionId: string,
  reviewId: string,
  dependencyHash: string,
  value: Extraction,
): Promise<string> {
  const version = await getVersion(versionId),
    chapter = await getChapter(chapterId);
  if (!version || version.chapterId !== chapterId || !chapter) throw new Error('正文版本不存在');
  const extraction = ExtractionSchema.parse(value),
    hash = await sha256Hex(version.content);
  const knownIds = new Set(
    (
      await getDb().select<{ id: string }>('SELECT id FROM storyline_characters WHERE novel_id=?', [
        chapter.novelId,
      ])
    ).map((x) => x.id),
  );
  const threads = new Set(
    (await listWritingCards(chapter.novelId, { kind: 'thread', confirmed: true })).map((x) => x.id),
  );
  const dependencyIds = new Set((await listCanonEvents(chapter.novelId, chapter.chapterNo)).map((e) => e.id));
  const seen = new Set<string>();
  for (const event of extraction.events) {
    try {
      event.evidence = anchorEvidence(version.content, event.evidence);
    } catch {
      throw new AwaitingReviewError('事实证据与正文位置不匹配，请重新提取');
    }
    if (seen.has(event.id) || dependencyIds.has(event.id)) throw new Error('重复的事实 ID');
    if (event.dependencyIds.some((id) => !dependencyIds.has(id)))
      throw new AwaitingReviewError('事实依赖不存在或已失效');
    seen.add(event.id);
    dependencyIds.add(event.id);
    if ((event.entityId && !knownIds.has(event.entityId)) || event.knownBy.some((x) => !knownIds.has(x)))
      throw new AwaitingReviewError('事实引用了未确认人物，请先完善人物卡');
    if (event.perspectiveId && !knownIds.has(event.perspectiveId) || event.relationshipState && (!knownIds.has(event.relationshipState.relatedCharacterId) || event.relationshipState.perspectives.some(p=>!knownIds.has(p.characterId)))) throw new AwaitingReviewError('人物理解或关系摘要引用了未确认人物');
    if (
      (event.threadId && !threads.has(event.threadId)) ||
      (event.kind.startsWith('thread_') && !event.threadId)
    )
      throw new AwaitingReviewError('伏笔事件必须引用已确认的伏笔 ID');
  }
  const dependencies = await chapterDependencies(chapter.novelId, chapter.chapterNo);
  if (dependencies.hash !== dependencyHash)
    throw new AwaitingReviewError('提取期间计划或前文发生变化，请重新审查');
  const { assertReviewPass } = await import('./reviewsRepo');
  await assertReviewPass(reviewId,versionId,hash,dependencyHash);
  const id = nanoid();
  await getDb().atomic([
    dependencies.guard,
    {
      sql: 'UPDATE chapter_versions SET id=id WHERE id=? AND content=?',
      params: [version.id, version.content],
      expectedRows: 1,
    },
    {
      sql: 'INSERT OR REPLACE INTO chapter_extractions(id,chapter_id,version_id,content_hash,dependency_hash,review_id,json,created_at) VALUES (?,?,?,?,?,?,?,?)',
      params: [id, chapterId, versionId, hash, dependencyHash, reviewId, JSON.stringify(extraction), now()],
    },
  ]);
  return id;
}

export async function listCanonEvents(
  novelId: string,
  beforeChapterNo: number,
  entityIds: string[] = [],
): Promise<
  Array<CanonEvent & { versionId: string; chapterNo: number; contentHash: string; eventIndex: number }>
> {
  const rows = await getDb().select<{
    json: string;
    version_id: string;
    chapter_no: number;
    content_hash: string;
    event_index: number;
  }>(
    `SELECT * FROM canon_events WHERE novel_id=? AND valid=1 AND chapter_no<? ${entityIds.length ? `AND (entity_id IN (${entityIds.map(() => '?').join(',')}) OR entity_id IS NULL)` : ''} ORDER BY chapter_no,event_index,id`,
    [novelId, beforeChapterNo, ...entityIds],
  );
  return rows.map((r) => ({
    ...CanonEventSchema.parse(JSON.parse(r.json)),
    versionId: r.version_id,
    chapterNo: r.chapter_no,
    contentHash: r.content_hash,
    eventIndex: r.event_index,
  }));
}

/** Complete dependency closure, with explicit knowledge holders and source versions. */
export async function retrieveCanonEvents(
  novelId: string,
  beforeChapterNo: number,
  filter: {
    characterIds: string[];
    threadIds: string[];
    dependencyIds: string[];
    times: string[];
    locations: string[];
  },
) {
  const rows = await getDb().select<{
    json: string;
    version_id: string;
    chapter_no: number;
    content_hash: string;
    event_index: number;
  }>(
    `WITH RECURSIVE selected(id) AS (
    SELECT id FROM canon_events WHERE novel_id=? AND valid=1 AND chapter_no<? AND (
      (kind='fact' AND entity_id IS NULL) OR chapter_no>=? OR entity_id IN (SELECT value FROM json_each(?))
      OR EXISTS(SELECT 1 FROM json_each(canon_events.json,'$.knownBy') WHERE value IN (SELECT value FROM json_each(?)))
      OR thread_id IN (SELECT value FROM json_each(?)) OR id IN (SELECT value FROM json_each(?))
      OR json_extract(json,'$.time') IN (SELECT value FROM json_each(?)) OR json_extract(json,'$.location') IN (SELECT value FROM json_each(?))
    ) UNION SELECT dep.value FROM selected JOIN canon_events e ON e.id=selected.id JOIN json_each(e.json,'$.dependencyIds') dep
    JOIN canon_events source ON source.id=dep.value AND source.novel_id=? AND source.valid=1 AND source.chapter_no<?
  ) SELECT e.* FROM canon_events e JOIN selected s ON s.id=e.id ORDER BY e.chapter_no,e.event_index,e.id`,
    [
      novelId,
      beforeChapterNo,
      Math.max(1, beforeChapterNo - 2),
      JSON.stringify(filter.characterIds),
      JSON.stringify(filter.characterIds),
      JSON.stringify(filter.threadIds),
      JSON.stringify(filter.dependencyIds),
      JSON.stringify(filter.times.filter(Boolean)),
      JSON.stringify(filter.locations.filter(Boolean)),
      novelId,
      beforeChapterNo,
    ],
  );
  return rows.map((r) => ({
    ...CanonEventSchema.parse(JSON.parse(r.json)),
    versionId: r.version_id,
    chapterNo: r.chapter_no,
    contentHash: r.content_hash,
    eventIndex: r.event_index,
  }));
}

/** UI pages never load the full million-word manuscript or the full fact history. */
export async function pageCanonEvents(novelId: string, page: number, query = '') {
  const params = [novelId, `%${query}%`];
  const where = "novel_id=? AND valid=1 AND (json_extract(json,'$.text') LIKE ? OR ?='')";
  params.push(query);
  const count = await selectOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM canon_events WHERE ${where}`,
    params,
  );
  const rows = await getDb().select<{
    json: string;
    version_id: string;
    chapter_no: number;
    content_hash: string;
    event_index: number;
  }>(
    `SELECT json,version_id,chapter_no,content_hash,event_index FROM canon_events WHERE ${where} ORDER BY chapter_no,event_index,id LIMIT 50 OFFSET ?`,
    [...params, Math.max(0, page) * 50],
  );
  return {
    total: count?.n ?? 0,
    events: rows.map((r) => ({
      ...CanonEventSchema.parse(JSON.parse(r.json)),
      versionId: r.version_id,
      chapterNo: r.chapter_no,
      contentHash: r.content_hash,
      eventIndex: r.event_index,
    })),
  };
}

/** Rebuildable projection; events and source versions are the authoritative record. */
export function projectEvents(
  bible: StoryBible,
  events: Array<CanonEvent & { chapterNo?: number }>,
  chapterNo: number,
): StoryBible {
  const next = structuredClone(bible);
  for (const event of events) {
    const subjective = event.epistemic === 'belief' || event.epistemic === 'claim';
    const eventText = subjective ? `[${event.epistemic}:${event.perspectiveId}] ${event.text}` : event.text;
    if (event.kind === 'fact' && !subjective) next.facts.push(event.text);
    if (event.kind === 'event')
      next.timeline.push({ chapterNo: event.chapterNo ?? chapterNo, event: eventText });
    if (event.kind === 'thread_setup' && event.threadId)
      next.openThreads.push(`${event.threadId}: ${event.text}`);
    if (event.kind === 'thread_payoff' && event.threadId)
      next.openThreads = next.openThreads.filter((t) => !t.startsWith(`${event.threadId}: `));
    for (const entityId of new Set([...(event.entityId ? [event.entityId] : []), ...event.knownBy])) {
      const state = next.characters[entityId] ?? {
        name: entityId,
        state: '',
        location: '',
        knowledge: '',
        relationships: [],
      };
      if (event.kind === 'knowledge' && event.knownBy.includes(entityId))
        state.knowledge += `\n${eventText}`;
      if (event.entityId === entityId) {
        if (event.kind === 'state') state.state = eventText;
        if (event.location) state.location = event.location;
        if (event.kind === 'relationship') state.relationships.push(eventText);
      }
      next.characters[entityId] = state;
    }
  }
  return next;
}

export async function commitPreparedChapter(
  chapterId: string,
  versionId: string,
  authorAccepted = false,
  commit: AtomicWriter = writeAtomic,
): Promise<string> {
  const chapter = await getChapter(chapterId),
    version = await getVersion(versionId);
  if (!chapter || !version || version.chapterId !== chapterId) throw new Error('正文版本不存在');
  if (chapter.currentVersionId !== versionId) throw new AwaitingReviewError('工作稿已变化，请重新审查');
  if (chapter.rewriteBaselineVersionId && !authorAccepted)
    throw new AwaitingReviewError('改写稿已审查，等待作者采纳');
  const pendingBefore = await selectOne<{ id: string }>(
    "SELECT id FROM chapters WHERE novel_id=? AND chapter_no<? AND committed_version_id IS NOT NULL AND memory_status<>'valid' LIMIT 1",
    [chapter.novelId, chapter.chapterNo],
  );
  if (pendingBefore) throw new AwaitingReviewError('前文记忆需要按章重建后才能提交');
  const hash = await sha256Hex(version.content),
    deps = await chapterDependencies(chapter.novelId, chapter.chapterNo);
  const extraction = await selectOne<ExtractionRow>(
    'SELECT * FROM chapter_extractions WHERE version_id=? AND content_hash=? AND dependency_hash=? ORDER BY created_at DESC LIMIT 1',
    [versionId, hash, deps.hash],
  );
  if (!extraction) throw new AwaitingReviewError('缺少当前版本的审查和事实提取，请重新审查');
  const { assertReviewPass } = await import('./reviewsRepo');
  await assertReviewPass(extraction.review_id, versionId, hash, deps.hash);
  // Rechecking identical approved prose refreshes its review, without replaying canon or invalidating later chapters.
  if (chapter.committedVersionId === versionId && chapter.memoryStatus === 'valid') {
    const existing = await selectOne<{id:string}>('SELECT id FROM chapter_commits WHERE chapter_id=? AND version_id=? ORDER BY created_at DESC LIMIT 1',[chapterId,versionId]);
    if (existing) {
      await commit([deps.guard,
        {sql:'UPDATE chapters SET status=\'final\',updated_at=? WHERE id=? AND current_version_id=? AND committed_version_id=? AND memory_status=\'valid\'',params:[now(),chapterId,versionId,versionId],expectedRows:1},
        {sql:'UPDATE chapter_reviews SET id=id WHERE id=? AND valid=1 AND content_hash=? AND dependency_hash=? AND id=(SELECT id FROM chapter_reviews WHERE chapter_version_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1)',params:[extraction.review_id,hash,deps.hash,versionId],expectedRows:1},
        {sql:'UPDATE chapter_commits SET review_id=? WHERE id=? AND version_id=?',params:[extraction.review_id,existing.id,versionId],expectedRows:1}]);
      return existing.id;
    }
  }
  const value = ExtractionSchema.parse(JSON.parse(extraction.json));
  const earlier = await listCanonEvents(chapter.novelId, chapter.chapterNo);
  const setup = new Set<string | null>();
  for (const e of earlier) {
    if (e.kind === 'thread_setup') setup.add(e.threadId);
    if (e.kind === 'thread_payoff') setup.delete(e.threadId);
  }
  for (const e of value.events) {
    if (e.kind === 'thread_setup') {
      if (setup.has(e.threadId)) throw new AwaitingReviewError('该伏笔已经埋设，请记录推进');
      setup.add(e.threadId);
    }
    if ((e.kind === 'thread_payoff' || e.kind === 'thread_progress') && !setup.has(e.threadId))
      throw new AwaitingReviewError('伏笔尚未埋设或已经回收');
    if (e.kind === 'thread_payoff') setup.delete(e.threadId);
  }
  const id = nanoid(),
    t = now();
  const previousCommits = await getDb().select<{ id: string }>(
    'SELECT DISTINCT commit_id AS id FROM canon_events WHERE novel_id=? AND chapter_no<? AND valid=1 AND commit_id IS NOT NULL',
    [chapter.novelId, chapter.chapterNo],
  );
  const projection = { projection: 'canon', commitIds: [...previousCommits.map((c) => c.id), id] };
  const structureOperations = await structureCommitOperations(chapter, versionId);
  const eventIds = new Map(value.events.map((e) => [e.id, nanoid()]));
  const committedEvents = value.events.map((e) => ({
    ...e,
    id: eventIds.get(e.id)!,
    dependencyIds: e.dependencyIds.map((id) => eventIds.get(id) ?? id),
  }));
  await commit([
    deps.guard,
    {
      sql: 'UPDATE chapters SET id=id WHERE id=? AND current_version_id=? AND committed_version_id IS ?',
      params: [chapterId, versionId, chapter.committedVersionId],
      expectedRows: 1,
    },
    {
      sql: 'UPDATE chapter_versions SET id=id WHERE id=? AND content=?',
      params: [versionId, version.content],
      expectedRows: 1,
    },
    {
      sql: 'UPDATE chapter_reviews SET id=id WHERE id=? AND valid=1 AND content_hash=? AND dependency_hash=? AND id=(SELECT id FROM chapter_reviews WHERE chapter_version_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1)',
      params: [extraction.review_id, hash, deps.hash, versionId],
      expectedRows: 1,
    },
    ...structureOperations,
    ...invalidateMemoryOperations(chapter.novelId, chapter.chapterNo + 1),
    { sql: 'UPDATE canon_events SET valid=0 WHERE chapter_id=?', params: [chapterId] },
    {
      sql: 'UPDATE story_bible_snapshots SET valid=0 WHERE novel_id=? AND after_chapter_no=?',
      params: [chapter.novelId, chapter.chapterNo],
    },
    // Legacy prose is already immutable; derived summary remains in the extraction/snapshot.
    ...(version.committedAt === null
      ? [
          {
            sql: "UPDATE chapter_versions SET summary=?, committed_at=?, session_id=NULL, state='accepted' WHERE id=?",
            params: [value.summary, t, versionId],
          },
        ]
      : []),
    {
      sql: "INSERT INTO chapter_commits(id,chapter_id,version_id,content_hash,review_id,dependency_hash,kind,created_at) VALUES (?,?,?,?,?,?,'reviewed',?)",
      params: [id, chapterId, versionId, hash, extraction.review_id, deps.hash, t],
    },
    ...committedEvents.map((e, index) => ({
      sql: 'INSERT INTO canon_events(id,novel_id,chapter_id,chapter_no,version_id,content_hash,kind,entity_id,thread_id,from_pos,to_pos,quote,json,created_at,event_index,commit_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      params: [
        e.id,
        chapter.novelId,
        chapterId,
        chapter.chapterNo,
        versionId,
        hash,
        e.kind,
        e.entityId,
        e.threadId,
        e.evidence.from,
        e.evidence.to,
        e.evidence.quote,
        JSON.stringify(e),
        t,
        index,
        id,
      ],
    })),
    {
      sql: 'INSERT INTO story_bible_snapshots(id,novel_id,after_chapter_no,chapter_version_id,json,created_at,valid) VALUES (?,?,?,?,?,?,1)',
      params: [nanoid(), chapter.novelId, chapter.chapterNo, versionId, JSON.stringify(projection), t],
    },
    {
      sql: "UPDATE chapters SET committed_version_id=?,memory_status='valid',status='final',stale_reasons='[]',rewrite_baseline_version_id=NULL,rewrite_baseline_status=NULL,rewrite_job_id=NULL,updated_at=? WHERE id=?",
      params: [versionId, t, chapterId],
    },
    ...(authorAccepted ? acceptedChapterJobOperations(chapterId,id,t) : []),
  ]);
  return id;
}

/** Latest committed lifecycle event per stable thread ID, never inferred from strings. */
export async function listThreadStates(novelId: string): Promise<
  Array<{
    threadId: string;
    kind: 'thread_setup' | 'thread_progress' | 'thread_payoff';
    chapterNo: number;
    versionId: string;
    quote: string;
  }>
> {
  const rows = await getDb().select<{
    thread_id: string;
    kind: 'thread_setup' | 'thread_progress' | 'thread_payoff';
    chapter_no: number;
    version_id: string;
    quote: string;
  }>(
    `SELECT * FROM (SELECT thread_id,kind,chapter_no,version_id,quote,ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY chapter_no DESC,event_index DESC) AS rank FROM canon_events WHERE novel_id=? AND valid=1 AND thread_id IS NOT NULL AND kind IN ('thread_setup','thread_progress','thread_payoff')) WHERE rank=1`,
    [novelId],
  );
  return rows.map((r) => ({
    threadId: r.thread_id,
    kind: r.kind,
    chapterNo: r.chapter_no,
    versionId: r.version_id,
    quote: r.quote,
  }));
}
