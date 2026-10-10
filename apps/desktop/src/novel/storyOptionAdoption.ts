import { nanoid } from 'nanoid';
import { canonicalJson } from '@the-water/shared';
import { now, selectOne, writeAtomic, type AtomicOperation, type AtomicWriter } from '@/db/db';
import { optionBatch, optionCards, optionGuard, optionSignature, optionSignatureSql, type OptionSelection } from '@/db/repos/storyOptionsRepo';
import type { DocumentPlanProposal } from '@/db/repos/planProposalsRepo';
import { buildStorylineDoc, storylineOperations } from '@/db/repos/storylineRepo';
import { getNovel } from '@/db/repos/novelsRepo';
import { invalidateMemoryOperations } from '@/db/repos/writingRepo';
import { emitJobEvent } from '@/jobs/events';
import { INDEPENDENT_OPTIONS_VERSION } from './storyOptionInputs';
import { storyOptionSource, storyOptionPlanSource, validateOptionPlan } from './storyOptions';

export async function prepareOptionAdoption(novelId: string, p: DocumentPlanProposal) {
  const s = await selectOne<OptionSelection>("SELECT * FROM story_option_selections WHERE id=? AND novel_id=? AND proposal_id=? AND state='pending'", [p.meta.storyOptionSelectionId, novelId, p.id]);
  if (!s) throw new Error('方向建议不可采纳 / Direction proposal unavailable');
  const { batch } = await optionBatch({ novelId }, s.batch_id);
  const source = await storyOptionPlanSource({ novelId }, batch.scope);
  const exploration = batch.inputSnapshot.sourceVersion === INDEPENDENT_OPTIONS_VERSION ? await storyOptionSource({ novelId }, batch.scope, undefined, String(batch.inputSnapshot.authorMaterials ?? '')) : source;
  if (exploration.hash !== batch.dependencyHash) throw new Error('方向已过期，请重新抽卡 / Direction is stale');
  if (p.meta.storyOptionAdoptionSignature && p.meta.storyOptionAdoptionSignature !== source.snapshot.signature) throw new Error('待审计划生成后作品已变化，请重新生成计划 / Work changed since planning');
  const novel = (await getNovel(novelId))!;
  await validateOptionPlan(novelId, { ...batch, boundary: source.boundary }, { after: p.after, title: p.title ?? novel.title, logline: String(p.meta.logline ?? novel.meta.logline), cards: (p.cards ?? []).map(c => ({ id: c.before ? c.id : null, chapterId: c.chapterId ?? null, chapterNo: c.chapterNo ?? null, value: c.after })), downstreamImpact: [], requiresWiderScope: false });
  const option = (await optionCards(batch)).find(o => o.id === s.option_id)!;
  return {
    guards: [optionGuard(novelId, String(source.snapshot.signature)), {
      sql: "UPDATE novels SET id=id WHERE id=? AND NOT EXISTS(SELECT 1 FROM generation_jobs WHERE novel_id=? AND status IN ('queued','running','pausing','cancelling'))",
      params: [novelId, novelId], expectedRows: 1,
    }, {
      sql: "UPDATE story_option_selections SET before_decisions=(SELECT json_group_array(json_object('id',id,'state',state)) FROM story_option_decisions WHERE novel_id=?) WHERE id=? AND state='pending'",
      params: [novelId, s.id], expectedRows: 1,
    }],
    tail: [
      ...invalidateMemoryOperations(novelId, 1),
      { sql: "UPDATE story_option_decisions SET state='superseded' WHERE novel_id=? AND scope_json=? AND state IN ('active','review')", params: [novelId, canonicalJson(batch.scope)] },
      { sql: "INSERT INTO story_option_decisions(id,novel_id,scope_json,option_json,state,created_at) VALUES (?,?,?,?,'active',?)", params: [s.id, novelId, canonicalJson(batch.scope), JSON.stringify(option), now()] },
      { sql: `UPDATE story_option_selections SET state='accepted',adopted_signature=(${optionSignatureSql}) WHERE id=? AND state='pending'`, params: [novelId, s.id], expectedRows: 1 },
    ] as AtomicOperation[],
  };
}
/** Undo the entire adopted group, including scenes. Changed prose/plan blocks undo. */
export async function undoStoryOption(novelId: string, selectionId: string, commit: AtomicWriter = writeAtomic) {
  const s = await selectOne<OptionSelection>('SELECT * FROM story_option_selections WHERE id=? AND novel_id=?', [selectionId, novelId]);
  if (s?.state === 'reverted') return;
  if (!s || s.state !== 'accepted' || !s.adopted_signature || s.adopted_signature !== await optionSignature(novelId)) throw new Error('采纳后作品已变化，不能覆盖并发修改 / Work changed since adoption');
  const row = await selectOne<{ json: string }>('SELECT json FROM writing_proposals WHERE id=? AND novel_id=?', [s.proposal_id, novelId]);
  if (!row) throw new Error('原计划建议不存在 / Original proposal unavailable');
  const p = JSON.parse(row.json) as DocumentPlanProposal, novel = (await getNovel(novelId))!, current = await buildStorylineDoc(novelId, novel.premise, novel.meta.themes), time = now();
  const operations: AtomicOperation[] = [optionGuard(novelId, s.adopted_signature),
    { sql: "UPDATE novels SET id=id WHERE id=? AND NOT EXISTS(SELECT 1 FROM generation_jobs WHERE novel_id=? AND status IN ('queued','running','pausing','cancelling'))", params: [novelId, novelId], expectedRows: 1 },
    ...storylineOperations(novelId, p.before),
  ];
  for (const c of p.before.chapters) operations.push({ sql: 'UPDATE chapters SET title=?,goal=?,target_chars=?,pov_character_id=?,beat_ids=?,end_hook=?,updated_at=? WHERE novel_id=? AND chapter_no=?', params: [c.title, c.goal, c.targetChars, c.povCharacterId, JSON.stringify(c.beatIds), c.endHook, time, novelId, c.chapterNo], expectedRows: 1 });
  for (const c of p.after.chapters.filter(c => !p.before.chapters.some(old => old.chapterNo === c.chapterNo))) operations.push({ sql: 'UPDATE chapters SET archived_at=?,updated_at=? WHERE novel_id=? AND chapter_no=? AND current_version_id IS NULL', params: [time, time, novelId, c.chapterNo], expectedRows: 1 });
  for (const c of p.cards ?? []) operations.push(c.before ? { sql: 'UPDATE writing_cards SET json=?,confirmed=?,revision=revision+1,updated_at=? WHERE id=? AND novel_id=?', params: [JSON.stringify(c.before), 'confirmed' in c.before && c.before.confirmed === false ? 0 : 1, time, c.id, novelId], expectedRows: 1 } : { sql: 'UPDATE writing_cards SET confirmed=0,revision=revision+1,updated_at=? WHERE id=? AND novel_id=?', params: [time, c.id, novelId], expectedRows: 1 });
  operations.push(
    { sql: 'UPDATE novels SET meta=?,title=?,updated_at=? WHERE id=?', params: [s.before_meta, s.before_title, time, novelId], expectedRows: 1 },
    { sql: "INSERT INTO storyline_snapshots(id,novel_id,json,reason,created_at) VALUES (?,?,?,'pre_rewrite',?)", params: [nanoid(), novelId, JSON.stringify(current), time] },
    ...invalidateMemoryOperations(novelId, 1),
    { sql: "UPDATE story_option_decisions SET state=(SELECT json_extract(value,'$.state') FROM json_each(?) WHERE json_extract(value,'$.id')=story_option_decisions.id) WHERE novel_id=? AND id IN (SELECT json_extract(value,'$.id') FROM json_each(?))", params: [s.before_decisions ?? '[]', novelId, s.before_decisions ?? '[]'] },
    { sql: "UPDATE story_option_selections SET state='reverted' WHERE id=? AND state='accepted'", params: [s.id], expectedRows: 1 },
    { sql: "UPDATE story_option_decisions SET state='reverted' WHERE id=?", params: [s.id], expectedRows: 1 },
  );
  await commit(operations);
  emitJobEvent({ type: 'novel:storylineUpdated', novelId });
}
