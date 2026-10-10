import { INDEPENDENT_OPTIONS_VERSION, storyOptionInputHash } from './storyOptionInputs';
import { canonicalJson, sha256Hex } from '@the-water/shared';
import { getDb, selectOne, type AtomicOperation } from '@/db/db';
import { optionBatch, optionSignatureSql, type OptionSelection } from '@/db/repos/storyOptionsRepo';
import type { WizardInput } from './service';

export async function wizardBindingOperations(draftId: string, novelId: string, input: WizardInput, selectionId?: string | null): Promise<AtomicOperation[]> {
  const sessions = await getDb().select<{ id: string }>('SELECT id FROM story_option_sessions WHERE draft_id=? AND novel_id IS NULL', [draftId]);
  if (selectionId) {
    const selection = await selectOne<OptionSelection>("SELECT * FROM story_option_selections WHERE id=? AND novel_id IS NULL AND state='selected'", [selectionId]);
    if (!selection) throw new Error('草稿方向不存在 / Draft direction unavailable');
    const { batch } = await optionBatch({ draftId }, selection.batch_id);
    if (batch.dependencyHash !== (batch.inputSnapshot.sourceVersion === INDEPENDENT_OPTIONS_VERSION ? await storyOptionInputHash(input, String(batch.inputSnapshot.authorMaterials ?? '')) : await sha256Hex(canonicalJson(input)))) throw new Error('向导输入已变化，请重新选择方向 / Wizard inputs changed');
  }
  const operations: AtomicOperation[] = sessions.flatMap(s => [
    { sql: 'UPDATE story_option_sessions SET novel_id=?,scope_json=? WHERE id=? AND novel_id IS NULL', params: [novelId, canonicalJson({ kind: 'work', id: novelId }), s.id], expectedRows: 1 },
    { sql: 'UPDATE story_option_selections SET novel_id=? WHERE batch_id IN (SELECT id FROM story_option_batches WHERE session_id=?)', params: [novelId, s.id] },
  ]);
  if (selectionId) operations.push({ sql: `UPDATE story_option_batches SET json=json_set(json,'$.inputSnapshot.boundSignature',(${optionSignatureSql}) || ''),revision=revision+1 WHERE id=(SELECT batch_id FROM story_option_selections WHERE id=? AND novel_id=?)`, params: [novelId, selectionId, novelId], expectedRows: 1 });
  return operations;
}
