import { storyOptionInputHash, INDEPENDENT_OPTIONS_VERSION } from '@/novel/storyOptionInputs';
import { getNovel } from './novelsRepo';
import { nanoid } from 'nanoid';
import { StoryOptionBatchSchema, StoryOptionSchema, canonicalJson, sha256Hex, type StoryOptionBatch, type StoryOptionScope } from '@the-water/shared';
import { getDb, now, selectOne, writeAtomic, type AtomicOperation, type AtomicWriter } from '../db';

export type OptionOwner = { novelId: string; draftId?: never } | { draftId: string; novelId?: never };
export interface OptionSession { id: string; novel_id: string | null; draft_id: string | null; scope_json: string }
export interface OptionSelection { id: string; batch_id: string; option_id: string; novel_id: string | null; proposal_id: string | null; state: string; error: string | null; generated_json: string | null; adopted_signature: string | null; before_meta: string | null; before_title: string | null; before_decisions: string | null }

/** Same expression is evaluated in the write transaction: no check/write race. */
export const optionSignatureSql = `WITH owner AS (SELECT ? AS id) SELECT json_array(
 (SELECT json_array(title,premise,requirements,target_chars,meta,style_profile,derivative,deleted_at) FROM novels WHERE id=(SELECT id FROM owner)),
 (SELECT json_group_array(json_array(id,name,aliases,role,description,arc,relationships,voice)) FROM (SELECT * FROM storyline_characters WHERE novel_id=(SELECT id FROM owner) ORDER BY id)),
 (SELECT json_group_array(json_array(id,name,kind,description,lore)) FROM (SELECT * FROM storyline_settings WHERE novel_id=(SELECT id FROM owner) ORDER BY id)),
 (SELECT json_group_array(json_array(id,title,summary,start_chapter_no,end_chapter_no)) FROM (SELECT * FROM storyline_arcs WHERE novel_id=(SELECT id FROM owner) ORDER BY id)),
 (SELECT json_group_array(json_array(id,arc_id,title,summary,chapter_no,character_ids,setting_ids)) FROM (SELECT * FROM storyline_beats WHERE novel_id=(SELECT id FROM owner) ORDER BY id)),
 (SELECT json_group_array(json_array(id,chapter_no,title,goal,target_chars,pov_character_id,beat_ids,end_hook,current_version_id,archived_at)) FROM (SELECT * FROM chapters WHERE novel_id=(SELECT id FROM owner) ORDER BY id)),
 (SELECT json_group_array(json_array(id,chapter_id,json,revision,confirmed,sort_order)) FROM (SELECT * FROM writing_cards WHERE novel_id=(SELECT id FROM owner) ORDER BY id)),
 (SELECT json FROM story_graphs WHERE novel_id=(SELECT id FROM owner)),
 (SELECT value FROM settings WHERE key='authorNote:'||(SELECT id FROM owner)),
 (SELECT json_group_array(json_array(v.id,v.content_hash,v.content)) FROM chapter_versions v JOIN chapters c ON c.current_version_id=v.id WHERE c.novel_id=(SELECT id FROM owner))
)`;
export async function optionSignature(novelId: string) {
  const row = await selectOne<{ value: string }>(`SELECT (${optionSignatureSql}) AS value`, [novelId]);
  return row!.value;
}
export function optionGuard(novelId: string, signature: string): AtomicOperation {
  return { sql: `UPDATE novels SET id=id WHERE id=? AND deleted_at IS NULL AND (${optionSignatureSql})=?`, params: [novelId, novelId, signature], expectedRows: 1 };
}
export async function optionSession(owner: OptionOwner, scope: StoryOptionScope) {
  const existing = await selectOne<OptionSession>('SELECT * FROM story_option_sessions WHERE novel_id IS ? AND draft_id IS ? AND scope_json=? ORDER BY created_at DESC LIMIT 1', [owner.novelId ?? null, owner.draftId ?? null, canonicalJson(scope)]);
  if (existing) return existing;
  const value: OptionSession = { id: nanoid(), novel_id: owner.novelId ?? null, draft_id: owner.draftId ?? null, scope_json: canonicalJson(scope) };
  await getDb().execute('INSERT INTO story_option_sessions(id,novel_id,draft_id,scope_json,created_at) VALUES (?,?,?,?,?)', [value.id, value.novel_id, value.draft_id, value.scope_json, now()]);
  return value;
}
export async function requireOptionSession(owner: OptionOwner, sessionId: string) {
  const s = await selectOne<OptionSession>('SELECT * FROM story_option_sessions WHERE id=? AND novel_id IS ? AND (? IS NULL OR draft_id=?)', [sessionId, owner.novelId ?? null, owner.draftId ?? null, owner.draftId ?? null]);
  if (!s) throw new Error('故事线不属于当前作品 / Story options do not belong to this work');
  return s;
}
export async function optionBatch(owner: OptionOwner, id: string) {
  const row = await selectOne<{ json: string; revision: number }>('SELECT json,revision FROM story_option_batches WHERE id=?', [id]);
  if (!row) throw new Error('候选批次不存在 / Batch unavailable');
  const batch = StoryOptionBatchSchema.parse(JSON.parse(row.json));
  if (batch.inputSnapshot.sourceVersion !== INDEPENDENT_OPTIONS_VERSION && typeof batch.inputSnapshot.boundSignature === 'string') batch.dependencyHash = await sha256Hex(batch.inputSnapshot.boundSignature);
  const session = await requireOptionSession(owner, batch.sessionId);
  // Draft scopes are rebound atomically when the work is created; immutable cards stay intact.
  if (session.novel_id && batch.scope.kind === 'work') batch.scope = { kind: 'work', id: session.novel_id };
  return { batch, revision: row.revision, session };
}
export async function saveOptionBatch(batch: StoryOptionBatch, revision: number, tail: AtomicOperation[] = [], commit: AtomicWriter = writeAtomic) {
  await commit([{ sql: 'UPDATE story_option_batches SET json=?,revision=revision+1 WHERE id=? AND revision=?', params: [JSON.stringify(StoryOptionBatchSchema.parse(batch)), batch.id, revision], expectedRows: 1 }, ...tail]);
}
export async function optionCards(batch: StoryOptionBatch) {
  const rows = await getDb().select<{ id: string; json: string }>('SELECT id,json FROM story_options WHERE session_id=?', [batch.sessionId]);
  return batch.optionIds.map(id => {
    const row = rows.find(r => r.id === id);
    if (!row) throw new Error('持久化候选缺失 / Saved option missing');
    return StoryOptionSchema.parse(JSON.parse(row.json));
  });
}
export async function optionHistory(owner: OptionOwner, scope: StoryOptionScope) {
  const sessions = await getDb().select<OptionSession>('SELECT * FROM story_option_sessions WHERE novel_id IS ? AND (? IS NULL OR draft_id=?)', [owner.novelId ?? null, owner.draftId ?? null, owner.draftId ?? null]);
  const ids = sessions.filter(s => canonicalJson(JSON.parse(s.scope_json)) === canonicalJson(scope)).map(s => s.id);
  const rows = await getDb().select<{ json: string }>('SELECT json FROM story_option_batches WHERE session_id IN (SELECT value FROM json_each(?)) ORDER BY rowid DESC', [JSON.stringify(ids)]);
  const signature = owner.novelId ? await optionSignature(owner.novelId) : null;
  const hash = signature ? await sha256Hex(signature) : null;
  const novel = owner.novelId ? await getNovel(owner.novelId) : null;
  return Promise.all(rows.map(async row => {
    const batch = StoryOptionBatchSchema.parse(JSON.parse(row.json));
    if (owner.novelId && batch.scope.kind === 'work') batch.scope = { kind: 'work', id: owner.novelId };
    if (batch.inputSnapshot.sourceVersion !== INDEPENDENT_OPTIONS_VERSION && typeof batch.inputSnapshot.boundSignature === 'string') batch.dependencyHash = await sha256Hex(batch.inputSnapshot.boundSignature);
    const selections = await getDb().select<OptionSelection>('SELECT * FROM story_option_selections WHERE batch_id=?', [batch.id]);
    const currentHash = batch.inputSnapshot.sourceVersion === INDEPENDENT_OPTIONS_VERSION && novel ? await storyOptionInputHash(novel, String(batch.inputSnapshot.authorMaterials ?? '')) : hash;
    return { batch, cards: await optionCards(batch), stale: currentHash !== null && batch.dependencyHash !== currentHash, selections };
  }));
}
export async function recoverStoryOptions() {
  await getDb().atomic([
    { sql: `UPDATE story_option_batches SET json=json_set(json,'$.state','interrupted'),revision=revision+1 WHERE json_extract(json,'$.state') IN ('candidates','comparison')` },
    { sql: "UPDATE story_option_selections SET state='failed',error='请求中断，可恢复 / Interrupted; resume available' WHERE state='planning'" },
  ]);
}
export async function storyDirectionContext(novelId: string) {
  const rows = await getDb().select<{ scope_json: string; option_json: string; state: string }>("SELECT scope_json,option_json,state FROM story_option_decisions WHERE novel_id=? AND state IN ('active','review') ORDER BY created_at", [novelId]);
  return rows.length ? `作者已采纳的作用域方向（父范围明确约束对子范围有效；review 表示计划已修改，发生冲突须等待作者复核，不得擅自覆盖）：\n${JSON.stringify(rows.map(r => ({ scope: JSON.parse(r.scope_json), direction: JSON.parse(r.option_json), state: r.state })))}` : '';
}
