import { nanoid } from 'nanoid';
import {
  AssistantContextSchema,
  AssistantResultSchema,
  type AssistantContext,
  type AssistantRun,
  type AssistantResult,
  type AssistantState,
} from '@the-water/shared';
import { getDb, now, selectOne, type AtomicOperation, type AtomicWriter } from '@/db/db';
import { invalidateMemoryOperations } from '@/db/repos/writingRepo';
import { emitJobEvent } from '@/jobs/events';

export async function revision(novelId: string | null) {
  if (!novelId) return 0;
  return (
    (
      await selectOne<{ revision: number }>(
        'SELECT revision FROM assistant_revisions WHERE novel_id=?',
        [novelId],
      )
    )?.revision ?? 0
  );
}
export async function sessionFor(context: AssistantContext) {
  const key = context.novelId ?? 'global';
  const existing = await selectOne<{ conversation_id: string }>(
    'SELECT conversation_id FROM assistant_sessions WHERE scope_key=?',
    [key],
  );
  if (existing) return existing.conversation_id;
  const id = `assistant:${nanoid()}`;
  await getDb().atomic([
    {
      sql: "INSERT INTO ai_conversations(id,kind,novel_id,title,created_at,updated_at) VALUES (?,'scratch',?,'Assistant',?,?)",
      params: [id, context.novelId, now(), now()],
    },
    {
      sql: 'INSERT OR IGNORE INTO assistant_sessions(conversation_id,scope_key,context_json,created_at) VALUES (?,?,?,?)',
      params: [id, key, JSON.stringify(context), now()],
    },
    {
      sql: 'DELETE FROM ai_conversations WHERE id=? AND NOT EXISTS(SELECT 1 FROM assistant_sessions WHERE conversation_id=?)',
      params: [id, id],
    },
  ]);
  return (await selectOne<{ conversation_id: string }>(
    'SELECT conversation_id FROM assistant_sessions WHERE scope_key=?',
    [key],
  ))!.conversation_id;
}

interface RawRun {
  id: string;
  conversation_id: string;
  novel_id: string | null;
  message_id: string;
  context_json: string;
  state: AssistantState;
  goal: string;
  constraints_json: string;
  job_id: string | null;
  error: string | null;
  created_at: number;
}
const mapRun = (r: RawRun): AssistantRun => ({
  id: r.id,
  conversationId: r.conversation_id,
  novelId: r.novel_id,
  messageId: r.message_id,
  context: AssistantContextSchema.parse(JSON.parse(r.context_json)),
  state: r.state,
  goal: r.goal,
  constraints: JSON.parse(r.constraints_json),
  jobId: r.job_id,
  error: r.error,
  createdAt: r.created_at,
});
export async function getRun(id: string) {
  const r = await selectOne<RawRun>('SELECT * FROM assistant_runs WHERE id=?', [id]);
  return r ? mapRun(r) : null;
}
export async function listRuns(conversationId?: string) {
  return (
    await getDb().select<RawRun>(
      `SELECT * FROM assistant_runs ${conversationId ? 'WHERE conversation_id=?' : ''} ORDER BY created_at`,
      conversationId ? [conversationId] : [],
    )
  ).map(mapRun);
}
export function messageOperation(
  conversationId: string,
  content: string,
  role: 'user' | 'assistant',
  id = nanoid(),
): AtomicOperation {
  return {
    sql: 'INSERT OR IGNORE INTO ai_messages(id,conversation_id,seq,role,content,created_at) VALUES (?,?,(SELECT COALESCE(MAX(seq),0)+1 FROM ai_messages WHERE conversation_id=?),?,?,?)',
    params: [id, conversationId, conversationId, role, content, now()],
  };
}
export async function createRun(
  requestId: string,
  conversationId: string,
  context: AssistantContext,
  text: string,
) {
  const existing = await getRun(requestId);
  if (existing) {
    const source = await selectOne<{ content: string }>(
      'SELECT content FROM ai_messages WHERE id=?',
      [existing.messageId],
    );
    if (existing.conversationId !== conversationId || source?.content !== text)
      throw new Error('Request ID was reused with different content');
    return existing;
  }
  const messageId = nanoid(),
    value = AssistantContextSchema.parse(context);
  try {
    await getDb().atomic([
      messageOperation(conversationId, text, 'user', messageId),
      {
        sql: "INSERT INTO assistant_runs(id,conversation_id,novel_id,message_id,context_json,state,created_at,updated_at) VALUES (?,?,?,?,?,'running',?,?)",
        params: [
          requestId,
          conversationId,
          value.novelId,
          messageId,
          JSON.stringify(value),
          now(),
          now(),
        ],
      },
      {
        sql: 'UPDATE assistant_sessions SET context_json=? WHERE conversation_id=?',
        params: [JSON.stringify(value), conversationId],
      },
    ]);
  } catch (error) {
    // Another delivery of the same request may have won after the initial read.
    // Its transaction already includes the source message; never insert a second one.
    if (!(await getRun(requestId))) throw error;
    return createRun(requestId, conversationId, context, text);
  }
  return (await getRun(requestId))!;
}
export async function setRunState(id: string, state: AssistantState, error: string | null = null) {
  await getDb().execute('UPDATE assistant_runs SET state=?,error=?,updated_at=? WHERE id=?', [
    state,
    error,
    now(),
    id,
  ]);
}
export interface OperationRecord {
  id: string;
  runId: string;
  sequence: number;
  name: string;
  parameters: unknown;
  intent: 'explicit_edit' | 'authorized_continuation';
  completeAfter: boolean;
  state: string;
  novelId: string | null;
  beforeRevision: number | null;
  afterRevision: number | null;
  result: AssistantResult | null;
  error: string | null;
}
interface RawOperation {
  id: string;
  run_id: string;
  sequence: number;
  name: string;
  parameters_json: string;
  intent: OperationRecord['intent'];
  complete_after: number;
  state: string;
  novel_id: string | null;
  before_revision: number | null;
  after_revision: number | null;
  result_json: string | null;
  error: string | null;
}
const mapOperation = (r: RawOperation): OperationRecord => ({
  id: r.id,
  runId: r.run_id,
  sequence: r.sequence,
  name: r.name,
  parameters: JSON.parse(r.parameters_json),
  intent: r.intent,
  completeAfter: r.complete_after === 1,
  state: r.state,
  novelId: r.novel_id,
  beforeRevision: r.before_revision,
  afterRevision: r.after_revision,
  result: r.result_json ? AssistantResultSchema.parse(JSON.parse(r.result_json)) : null,
  error: r.error,
});
export async function listOperations(runId: string) {
  return (
    await getDb().select<RawOperation>(
      'SELECT * FROM assistant_operations WHERE run_id=? ORDER BY sequence',
      [runId],
    )
  ).map(mapOperation);
}
export async function getOperation(id: string) {
  const r = await selectOne<RawOperation>('SELECT * FROM assistant_operations WHERE id=?', [id]);
  return r ? mapOperation(r) : null;
}
export async function beginOperation(
  run: AssistantRun,
  name: string,
  parameters: unknown,
  base: number,
  sequence: number,
  intent: OperationRecord['intent'] = 'explicit_edit',
  completeAfter = false,
) {
  const id = `${run.id}:${sequence}`;
  await getDb().execute(
    'INSERT OR IGNORE INTO assistant_operations(id,run_id,sequence,name,parameters_json,intent,complete_after,novel_id,before_revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    [
      id,
      run.id,
      sequence,
      name,
      JSON.stringify(parameters),
      intent,
      completeAfter ? 1 : 0,
      run.novelId,
      base,
      now(),
      now(),
    ],
  );
  const op = (await getOperation(id))!;
  if (
    op.name !== name ||
    op.intent !== intent ||
    op.completeAfter !== completeAfter ||
    JSON.stringify(op.parameters) !== JSON.stringify(parameters)
  )
    throw new Error('Operation replay differs from its durable decision');
  return op;
}
export function runGuard(runId: string): AtomicOperation {
  return {
    sql: "UPDATE assistant_runs SET id=id WHERE id=? AND state IN ('running','waiting_job')",
    params: [runId],
    expectedRows: 1,
  };
}
/** The writer can be consumed once. Domain mutations, CAS, row history and result are one transaction. */
export function operationWriter(
  op: OperationRecord,
  result: AssistantResult,
  options: { novelId?: string; tail?: AtomicOperation[] } = {},
): AtomicWriter {
  const novelId = options.novelId ?? op.novelId;
  if (!novelId) throw new Error('An operation must be bound to a work');
  let used = false;
  return async (operations) => {
    if (used) throw new Error('Operation attempted a second transaction');
    used = true;
    await getDb().atomic([
      runGuard(op.runId),
      {
        sql: "UPDATE assistant_operations SET novel_id=? WHERE id=? AND state='running'",
        params: [op.novelId, op.id],
        expectedRows: 1,
      },
      {
        sql: 'UPDATE assistant_runs SET id=id WHERE id=? AND COALESCE((SELECT revision FROM assistant_revisions WHERE novel_id=?),0)=?',
        params: [op.runId, novelId, op.beforeRevision ?? 0],
        expectedRows: 1,
      },
      {
        sql: 'INSERT INTO assistant_mutation_context(singleton,operation_id,novel_id) VALUES (1,?,?)',
        params: [op.id, novelId],
      },
      ...operations,
      { sql: 'DELETE FROM assistant_mutation_context WHERE singleton=1' },
      ...(options.tail ?? []),
      {
        sql: 'UPDATE assistant_operations SET novel_id=?,state=?,result_json=?,after_revision=(SELECT revision FROM assistant_revisions WHERE novel_id=?),updated_at=? WHERE id=?',
        params: [
          novelId,
          result.state,
          JSON.stringify(AssistantResultSchema.parse({ ...result, novelId })),
          novelId,
          now(),
          op.id,
        ],
      },
    ]);
    emitJobEvent({ type: 'novel:storylineUpdated', novelId });
  };
}
export async function finishOperation(op: OperationRecord, result: AssistantResult) {
  await getDb().atomic([
    runGuard(op.runId),
    {
      sql: "UPDATE assistant_operations SET state=?,result_json=?,updated_at=? WHERE id=? AND state='running'",
      params: [result.state, JSON.stringify(AssistantResultSchema.parse(result)), now(), op.id],
      expectedRows: 1,
    },
  ]);
}
export async function failOperation(id: string, error: string) {
  await getDb().execute(
    "UPDATE assistant_operations SET state='failed',error=?,updated_at=? WHERE id=? AND state='running'",
    [error, now(), id],
  );
}
export interface RowChange {
  sequence: number;
  table_name: string;
  row_id: string;
  before_json: string | null;
  after_json: string | null;
}
export async function changesFor(id: string) {
  return getDb().select<RowChange>(
    'SELECT * FROM assistant_row_changes WHERE operation_id=? ORDER BY sequence',
    [id],
  );
}
const reversibleTables = new Set([
  'story_option_batches',
  'story_changes',
  'story_suggestions',
  'settings',
  'novels',
  'storyline_characters',
  'storyline_settings',
  'storyline_arcs',
  'storyline_beats',
  'chapters',
  'writing_cards',
  'story_graphs',
  'story_branches',
  'writing_proposals',
  'chapter_structure_changes',
]);
/** Undo refuses ALL intervening writes, including in-place editor saves and dependency changes. */
export async function undoOperation(id: string, novelId: string) {
  const op = await getOperation(id);
  if (!op || op.novelId !== novelId) throw new Error('Operation does not belong to this work');
  if (op.state === 'undone') return;
  if (!['completed', 'waiting_job', 'partial', 'failed', 'cancelled'].includes(op.state) && !(op.name === 'story_options' && op.state === 'needs_input'))
    throw new Error('Operation is not complete');
  const running = await getDb().select(
    "SELECT id FROM generation_jobs WHERE novel_id=? AND status IN ('running','queued','pausing','cancelling')",
    [novelId],
  );
  if (running.length) throw new Error('Pause the task before undoing its changes');
  const current = await revision(novelId);
  if (op.afterRevision !== current)
    throw new Error('Undo conflict: the work or its dependencies changed after this operation');
  const changes = await changesFor(id);
  if (!changes.length) throw new Error('This operation has no reversible content changes');
  const operations: AtomicOperation[] = [
    {
      sql: "UPDATE assistant_operations SET state='undone',result_json=json_set(result_json,'$.state','undone'),updated_at=? WHERE id=? AND state<>'undone' AND after_revision=(SELECT revision FROM assistant_revisions WHERE novel_id=?)",
      params: [now(), id, novelId],
      expectedRows: 1,
    },
  ];
  // Free all affected positions before restoring a chapter permutation.
  for (const c of changes.filter((c) => c.table_name === 'chapters'))
    operations.push({
      sql: 'UPDATE chapters SET chapter_no=? WHERE id=?',
      params: [-1000000 - c.sequence, c.row_id],
    });
  for (const c of [...changes].reverse()) {
    if (!reversibleTables.has(c.table_name)) throw new Error('Unknown undo table');
    const before = c.before_json ? (JSON.parse(c.before_json) as Record<string, unknown>) : null;
    const after = c.after_json ? (JSON.parse(c.after_json) as Record<string, unknown>) : null;
    if (c.table_name === 'story_option_batches' && after) operations.push({ sql: 'UPDATE story_option_batches SET id=id WHERE id=? AND json=? AND revision=?', params: [c.row_id, after.json, after.revision], expectedRows: 1 });
    const key =
      c.table_name === 'story_graphs' ? 'novel_id' : c.table_name === 'settings' ? 'key' : 'id';
    if (c.table_name === 'settings' && c.row_id !== `authorNote:${novelId}`)
      throw new Error('Invalid author note undo scope');
    if (!before) {
      // Preserve novel/chapter/version history and references; undo creation by archiving.
      if (c.table_name === 'novels')
        operations.push({
          sql: 'UPDATE novels SET deleted_at=? WHERE id=?',
          params: [now(), c.row_id],
        });
      else if (c.table_name === 'chapters')
        operations.push({
          sql: 'UPDATE chapters SET archived_at=?,chapter_no=? WHERE id=?',
          params: [now(), 1000000 + c.sequence, c.row_id],
        });
      else if (c.table_name === 'story_changes')
        operations.push({
          sql: 'UPDATE story_changes SET undone=1 WHERE id=?',
          params: [c.row_id],
        });
      else
        operations.push({ sql: `DELETE FROM ${c.table_name} WHERE ${key}=?`, params: [c.row_id] });
    } else {
      const columns = Object.keys(before);
      // Revisions never go backwards: stale proposals must not become valid again.
      if (typeof before.revision === 'number')
        before.revision = Math.max(Number(before.revision), Number(after?.revision ?? 0)) + 1;
      if (c.table_name === 'story_branches' && typeof before.json === 'string')
        before.json = JSON.stringify({ ...JSON.parse(before.json), revision: before.revision });
      operations.push(
        after
          ? {
              sql: `UPDATE ${c.table_name} SET ${columns
                .filter((k) => k !== key)
                .map((k) => `${k}=?`)
                .join(',')} WHERE ${key}=?`,
              params: [...columns.filter((k) => k !== key).map((k) => before[k]), c.row_id],
              expectedRows: 1,
            }
          : {
              sql: `INSERT INTO ${c.table_name}(${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
              params: columns.map((k) => before[k]),
            },
      );
    }
  }
  operations.push(
    ...invalidateMemoryOperations(novelId, 1),
    {
      sql: 'UPDATE chapter_reviews SET valid=0 WHERE chapter_id IN (SELECT id FROM chapters WHERE novel_id=?)',
      params: [novelId],
    },
    {
      sql: "UPDATE assistant_operations SET after_revision=(SELECT revision FROM assistant_revisions WHERE novel_id=?) WHERE novel_id=? AND after_revision=? AND state<>'undone'",
      params: [novelId, novelId, op.beforeRevision],
    },
  );
  await getDb().atomic(operations);
  emitJobEvent({ type: 'novel:storylineUpdated', novelId });
}
