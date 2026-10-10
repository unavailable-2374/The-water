import { saveAuthorNote, loadAuthorNote } from '@/llm/prompts/authorNote';
import { generateStoryOptions, retainStoryOption, resumeStoryOptions, storyOptionSource, combineStoryOptions } from '@/novel/storyOptions';
import { optionBatch, optionHistory } from '@/db/repos/storyOptionsRepo';
import { prepareJobMemoryRepair } from '@/db/repos/jobMemoryRepair';
import { nanoid } from 'nanoid';
import {
  assistantParameters,
  AssistantOperationSchema,
  TextProposalSchema,
  type AssistantOperation,
  type AssistantResult,
  type AssistantRun,
} from '@the-water/shared';
import { getDb, now, selectOne, type AtomicOperation } from '@/db/db';
import { getNovel, createNovel, updateNovel, listNovels } from '@/db/repos/novelsRepo';
import {
  listChapters,
  getVersion,
  listVersions,
  createVersion,
  upsertChapterPlan,
  resolveRewrite,
} from '@/db/repos/chaptersRepo';
import {
  buildStorylineDoc,
  upsertCharacter,
  upsertSetting,
  upsertArc,
  upsertBeat,
  deleteEntity,
  setStyleProfile,
  setDerivative,
} from '@/db/repos/storylineRepo';
import {
  getStoryGraph,
  saveStoryGraph,
  assertStoryTextEdit,
  listStoryChanges,
  undoStoryChange,
} from '@/db/repos/storyGraphRepo';
import {
  listWritingCards,
  saveWritingCard,
  acceptPlanProposal,
  discardProposal,
  reorderCards,
  splitScene,
  mergeScenes,
  listCanonEvents,
  pageImportedMaterials,
} from '@/db/repos/writingRepo';
import { listDocumentPlans, acceptDocumentPlan } from '@/db/repos/planProposalsRepo';
import {
  reorderChapters,
  splitChapter,
  mergeChapters,
  cancelChapterMerge,
} from '@/db/repos/chapterStructureRepo';
import { createJob, listJobs, getJob, listSteps, BLOCKING_JOB_STATUSES } from '@/db/repos/jobsRepo';
import { assertBudget } from '@/db/repos/usageRepo';
import { listDocuments, getDocument, getPageText } from '@/db/repos/documentsRepo';
import { planGenerate, planPlanning, planRewrite, planStyleCheck } from '@/jobs/planner';
import { kick, pauseJob, resumeJob, cancelJob } from '@/jobs/runner';
import { getNovelProviders } from '@/novel/service';
import { NovelRequirementsSchema } from '@/novel/types';
import { docTypeGuide } from '@/novel/docTypes';
import {
  listStoryBranches,
  createStoryBranch,
  saveStoryBranch,
  generateBranchSample,
  mergeStoryBranch,
} from '@/novel/storyBranches';
import {
  listStoryReadings,
  readStoryProse,
  acceptStoryReading,
  dismissStoryReading,
  suggestStoryVoice,
} from '@/novel/storyIntelligence';
import { acceptTextProposal } from '@/novel/assistant';
import {
  beginOperation,
  operationWriter,
  finishOperation,
  failOperation,
  listOperations,
  getOperation,
  getRun,
  type OperationRecord,
} from './repository';
import { importManuscript } from './manuscript';

export class ClarificationRequired extends Error {}
export async function inspect(
  run: AssistantRun,
  parameters: { section: string; id?: string },
): Promise<unknown> {
  const novelId = run.novelId;
  if (!novelId) return { works: await listNovels(), documents: await listDocuments() };
  const novel = await getNovel(novelId);
  if (!novel) throw new Error('Work is unavailable');
  const chapters = await listChapters(novelId);
  const chapter = parameters.id
    ? chapters.find((c) => c.id === parameters.id)
    : chapters.find((c) => c.id === run.context.chapterId);
  switch (parameters.section) {
    case 'overview':
      return {
        novel,
        chapters,
        authorNote: await loadAuthorNote(novelId),
        graph: await getStoryGraph(novelId),
      };
    case 'chapters':
      return chapters;
    case 'chapter':
      if (!chapter) throw new ClarificationRequired('Choose a chapter ID');
      return { chapter, version: await getVersion(chapter.currentVersionId) };
    case 'versions':
      if (!chapter) throw new ClarificationRequired('Choose a chapter ID');
      return listVersions(chapter.id);
    case 'plans':
      return {
        storyline: await buildStorylineDoc(novelId, novel.premise, novel.meta.themes),
        cards: await listWritingCards(novelId),
      };
    case 'graph':
      return getStoryGraph(novelId);
    case 'branches':
      return listStoryBranches(novelId);
    case 'readings':
      return listStoryReadings(novelId);
    case 'story_history':
      return listStoryChanges(novelId);
    case 'candidates':
      return getDb().select(
        "SELECT id,chapter_id,kind,state,json,assistant_run_id,source_job_id FROM writing_proposals WHERE novel_id=? AND state IN ('pending','conflict')",
        [novelId],
      );
    case 'jobs':
      return Promise.all(
        (await listJobs({ novelId })).map(async (j) => ({ ...j, steps: await listSteps(j.id) })),
      );
    case 'history':
      return listOperations(run.id);
    case 'materials':
      return { documents: await listDocuments(), imported: await pageImportedMaterials(novelId) };
    case 'facts':
      return listCanonEvents(novelId, chapter?.chapterNo ?? 501);
    default:
      throw new Error('Unknown inspection section');
  }
}
export async function sourceContext(ids: string[]) {
  return Promise.all(
    ids.map(async (id) => {
      const page = /^pdf:([^:]+):(\d+)$/.exec(id);
      if (!page) throw new Error(`Unknown source: ${id}`);
      const doc = await getDocument(page[1]!);
      const text = await getPageText(page[1]!, Number(page[2]));
      if (!doc || text === null || Number(page[2]) < 1 || Number(page[2]) > doc.pageCount)
        throw new Error('Referenced document page is not indexed');
      return { id, title: doc.title, fileHash: doc.fileSha256, text };
    }),
  );
}
export async function executeOperation(
  run: AssistantRun,
  raw: AssistantOperation,
  baseRevision: number,
  sequence: number,
  signal: AbortSignal,
  intent: OperationRecord['intent'] = 'explicit_edit',
  completeAfter = false,
): Promise<AssistantResult> {
  const parsed = AssistantOperationSchema.parse(raw) as AssistantOperation;
  const operation = {
    ...parsed,
    parameters: assistantParameters[parsed.name].parse(parsed.parameters),
  } as AssistantOperation;
  const op = await beginOperation(
    run,
    operation.name,
    operation.parameters,
    baseRevision,
    sequence,
    intent,
    completeAfter,
  );
  if (op.result && op.state !== 'running') return op.result;
  if (op.state !== 'running') throw new Error(op.error ?? 'Operation already stopped');
  const novelId = run.novelId;
  const result: AssistantResult = {
    state: 'completed',
    summary: operation.name,
    novelId,
    objectIds: [],
    ...(novelId ? { location: `/studio/${novelId}/workspace` } : {}),
  };
  try {
    signal.throwIfAborted();
    if (
      run.context.selection &&
      [
        'rewrite',
        'write',
        'review',
        'finish_work',
        'restore_version',
        'split_chapter',
        'merge_chapters',
        'candidate',
        'rewrite_candidate',
        'branch_merge',
      ].includes(operation.name)
    )
      throw new ClarificationRequired(
        'The selected range limits this request. Use edit_text for that exact range, or clear the selection before requesting whole-chapter changes.',
      );
    if (operation.name === 'inspect') {
      result.detail = await inspect(run, operation.parameters);
      await finishOperation(op, result);
      return result;
    }
    if (operation.name === 'create_work' || operation.name === 'import_manuscript') {
      if (novelId)
        throw new ClarificationRequired('Start a global conversation to create a new work');
      const id = nanoid();
      result.novelId = id;
      result.objectIds = [id];
      result.location = `/studio/${id}/plan`;
      const context = { ...run.context, novelId: id };
      const commit = operationWriter(op, result, {
        novelId: id,
        tail: [
          {
            sql: 'UPDATE assistant_runs SET novel_id=?,context_json=? WHERE id=?',
            params: [id, JSON.stringify(context), run.id],
          },
          {
            sql: 'UPDATE ai_conversations SET novel_id=? WHERE id=?',
            params: [id, run.conversationId],
          },
          {
            sql: 'UPDATE assistant_sessions SET scope_key=?,context_json=? WHERE conversation_id=?',
            params: [id, JSON.stringify(context), run.conversationId],
          },
        ],
      });
      if (operation.name === 'create_work')
        await createNovel({
          id,
          commit,
          ...operation.parameters,
          requirements: NovelRequirementsSchema.parse(operation.parameters.requirements),
        });
      else await importManuscript(id, operation.parameters, commit, signal);
      return result;
    }
    if (!novelId) throw new ClarificationRequired('Choose or create a work first');
    const novel = await getNovel(novelId);
    if (!novel) throw new Error('Work is unavailable');
    const chapters = await listChapters(novelId);
    const ownChapter = (id: string) => {
      const c = chapters.find((c) => c.id === id);
      if (!c) throw new Error('Chapter does not belong to this work');
      return c;
    };
    const commit = operationWriter(op, result);
    switch (operation.name) {
      case 'story_options': {
        const p = operation.parameters, owner = { novelId };
        const retentionOps: AtomicOperation[] = [];
        await storyOptionSource(owner, p.scope);
        if (p.batchId) {
          const { batch } = await optionBatch(owner, p.batchId);
          if (batch.scope.kind !== p.scope.kind || batch.scope.id !== p.scope.id) throw new Error('Batch does not belong to the requested scope');
        }
        let batchId = p.batchId;
        if (p.action === 'combine') {
          if (!p.batchId || !p.optionIds) throw new Error('Combine requires batchId and two to four optionIds');
          batchId = await combineStoryOptions({ owner, batchId: p.batchId, optionIds: p.optionIds, feedback: p.feedback, authorMaterials: p.authorMaterials, requestKey: op.id });
        } else if (p.action === 'generate' || p.action === 'redraw') {
          if (p.action === 'redraw' && !p.batchId) throw new Error('Redraw requires a batch ID');
          batchId = await generateStoryOptions({ owner, scope: p.scope, mode: p.mode, amplitude: p.amplitude, feedback: p.feedback, authorMaterials: p.authorMaterials, requestKey: op.id, previousBatchId: p.batchId, keep: p.action === 'redraw' });
        } else if (p.action === 'retain') {
          if (!p.batchId || !p.optionId || p.retained === undefined) throw new Error('Retain requires batchId, optionId and retained');
          await retainStoryOption(owner, p.batchId, p.optionId, p.retained, async ops => { retentionOps.push(...ops); });
        } else if (p.action === 'resume') {
          if (!p.batchId) throw new Error('Resume requires batchId');
          await resumeStoryOptions(owner, p.batchId);
        }
        const history = await optionHistory(owner, p.scope);
        result.detail = { storyOptions: true, scope: p.scope, batchId: batchId ?? history[0]?.batch.id, history };
        result.objectIds = batchId ? [batchId] : [];
        result.state = 'needs_input';
        result.summary = 'Story directions await the author’s choice';
        if (retentionOps.length) await operationWriter(op, result)(retentionOps);
        else await finishOperation(op, result);
        await getDb().execute("UPDATE assistant_runs SET state='needs_input',updated_at=? WHERE id=? AND state='running'", [now(), run.id]);
        break;
      }
      case 'edit_work': {
        const { requirements, ...patch } = operation.parameters;
        await updateNovel(
          novelId,
          {
            ...patch,
            ...(requirements
              ? {
                  requirements: NovelRequirementsSchema.parse({
                    ...novel.requirements,
                    ...requirements,
                  }),
                }
              : {}),
          },
          commit,
        );
        break;
      }
      case 'character':
        await upsertCharacter(novelId, operation.parameters.value, undefined, commit);
        break;
      case 'setting':
        await upsertSetting(novelId, operation.parameters.value, undefined, commit);
        break;
      case 'arc':
        await upsertArc(novelId, operation.parameters.value, undefined, commit);
        break;
      case 'beat':
        await upsertBeat(novelId, operation.parameters.value, undefined, commit);
        break;
      case 'remove_entity':
        await deleteEntity(operation.parameters.kind, operation.parameters.id, commit);
        break;
      case 'style':
        await setStyleProfile(novelId, operation.parameters.value, commit);
        break;
      case 'card': {
        const p = operation.parameters;
        const old = (await listWritingCards(novelId)).find((c) => c.id === p.id);
        if (p.id && !old) throw new Error('Card does not belong to this work');
        await saveWritingCard(novelId, p.value, { ...p, expectedRevision: old?.revision, commit });
        break;
      }
      case 'chapter_plan':
        await upsertChapterPlan(novelId, operation.parameters.value, commit);
        break;
      case 'graph':
        await saveStoryGraph(
          novelId,
          (await getStoryGraph(novelId)).revision,
          operation.parameters.value,
          operation.parameters.reason,
          commit,
        );
        break;
      case 'reorder_chapters':
        operation.parameters.ids.forEach(ownChapter);
        await reorderChapters(novelId, operation.parameters.ids, commit);
        break;
      case 'split_chapter': {
        const p = operation.parameters;
        const c = ownChapter(p.chapterId);
        const v = await getVersion(c.currentVersionId);
        await assertStoryTextEdit(novelId, c.id, v?.content ?? '', 0, v?.content.length ?? 0);
        await splitChapter(c.id, p.offset, commit);
        break;
      }
      case 'merge_chapters': {
        const p = operation.parameters;
        for (const id of [p.firstId, p.secondId]) {
          const c = ownChapter(id);
          const v = await getVersion(c.currentVersionId);
          await assertStoryTextEdit(novelId, id, v?.content ?? '', 0, v?.content.length ?? 0);
        }
        await mergeChapters(p.firstId, p.secondId, commit);
        break;
      }
      case 'cancel_merge':
        ownChapter(operation.parameters.chapterId);
        await cancelChapterMerge(operation.parameters.chapterId, commit);
        break;
      case 'reorder_cards':
      case 'split_scene':
      case 'merge_scenes': {
        const cards = await listWritingCards(novelId);
        const own = (id: string) => {
          const c = cards.find((c) => c.id === id);
          if (!c) throw new Error('Card does not belong to this work');
          return c;
        };
        if (operation.name === 'reorder_cards')
          await reorderCards(operation.parameters.ids.map(own), commit);
        else if (operation.name === 'split_scene')
          await splitScene(own(operation.parameters.id), commit);
        else
          await mergeScenes(
            own(operation.parameters.firstId),
            own(operation.parameters.secondId),
            commit,
          );
        break;
      }
      case 'edit_text':
      case 'restore_version': {
        const p = operation.parameters,
          c = ownChapter(p.chapterId),
          v = await getVersion(c.currentVersionId),
          old = v?.content ?? '';
        let content: string;
        if (operation.name === 'edit_text') {
          const p = operation.parameters,
            s = run.context.selection;
          if (p.baseVersionId !== c.currentVersionId || p.baseHash !== (v?.contentHash ?? null))
            throw new Error(
              'Concurrent modification: inspected prose changed; inspect the current version before editing',
            );
          if (p.to < p.from || p.to > old.length) throw new Error('Text range is invalid');
          if (
            s &&
            (c.id !== run.context.chapterId ||
              p.from !== s.from ||
              p.to !== s.to ||
              v?.id !== s.versionId ||
              v.contentHash !== s.contentHash)
          )
            throw new Error('Selection scope or version changed');
          await assertStoryTextEdit(novelId, c.id, old, p.from, p.to);
          content = old.slice(0, p.from) + p.replacement + old.slice(p.to);
        } else {
          const source = await getVersion(operation.parameters.versionId);
          if (source?.chapterId !== c.id)
            throw new Error('Version does not belong to this chapter');
          await assertStoryTextEdit(novelId, c.id, old, 0, old.length);
          content = source.content;
        }
        result.objectIds = [c.id];
        result.location = `/studio/${novelId}/chapters?chapter=${c.id}`;
        await createVersion({
          chapterId: c.id,
          content,
          source: 'rewritten',
          expectedWorkingVersionId: c.currentVersionId,
          expectedWorkingHash: v?.contentHash,
          commit,
        });
        break;
      }
      case 'candidate': {
        const p = operation.parameters;
        const candidate = await selectOne<{
          kind: string;
          json: string;
          chapter_id: string | null;
          assistant_run_id: string | null;
        }>(
          'SELECT kind,json,chapter_id,assistant_run_id FROM writing_proposals WHERE novel_id=? AND id=?',
          [novelId, p.id],
        );
        if (!candidate) throw new Error('Candidate does not belong to this work');
        if (p.action === 'accept' && await selectOne('SELECT id FROM story_option_selections WHERE proposal_id=? AND novel_id=?', [p.id, novelId])) throw new ClarificationRequired('Story directions require author adoption in the shared plan review; automatic adoption is disabled');
        if (
          p.action === 'accept' &&
          intent === 'authorized_continuation' &&
          candidate.assistant_run_id !== run.id
        )
          throw new ClarificationRequired(
            'Historical candidates require an explicit adoption request',
          );
        if (p.action === 'discard') await discardProposal(p.id, commit);
        else if (candidate.kind === 'text') {
          const proposal = TextProposalSchema.parse(JSON.parse(candidate.json)),
            c = ownChapter(proposal.chapterId),
            v = await getVersion(c.currentVersionId);
          await createVersion({
            chapterId: c.id,
            content: await acceptTextProposal(proposal, v?.content ?? ''),
            source: 'user_edit',
            expectedWorkingVersionId: c.currentVersionId,
            acceptProposalId: p.id,
            commit,
          });
        } else if ((await listDocumentPlans(novelId)).some((p) => p.id === candidateId(operation)))
          await acceptDocumentPlan(novelId, p.id, commit);
        else await acceptPlanProposal(novelId, p.id, commit);
        break;
      }
      case 'plan':
      case 'write':
      case 'rewrite':
      case 'review':
      case 'extract_style':
      case 'finish_work':
        return startOperationJob(run, op, operation, result, signal);
      case 'rewrite_candidate': {
        const chapter = ownChapter(operation.parameters.chapterId);
        const owner = chapter.rewriteJobId ? await getJob(chapter.rewriteJobId) : null;
        if (
          operation.parameters.action === 'accept' &&
          intent === 'authorized_continuation' &&
          owner?.params.assistantRunId !== run.id
        )
          throw new ClarificationRequired(
            'Historical rewrites require an explicit adoption request',
          );
        await resolveRewrite(chapter.id, operation.parameters.action, commit);
        break;
      }
      case 'author_note':
        await saveAuthorNote(novelId, operation.parameters.value, commit);
        break;
      case 'derivative':
        await setDerivative(novelId, operation.parameters.value, commit);
        break;
      case 'repair_memory': {
        const j = await getJob(operation.parameters.jobId);
        if (j?.novelId !== novelId) throw new Error('Task does not belong to this work');
        await prepareJobMemoryRepair(j.id, commit);
        kick();
        break;
      }
      case 'task': {
        const p = operation.parameters,
          job = await getJob(p.id),
          target = await getRun(
            typeof job?.params.assistantRunId === 'string' ? job.params.assistantRunId : p.id,
          );
        if (job?.novelId !== novelId && target?.novelId !== novelId)
          throw new Error('Task does not belong to this work');
        if (
          target &&
          ['completed', 'cancelled', 'undone'].includes(target.state) &&
          p.action === 'resume'
        )
          throw new ClarificationRequired(
            'This assistant task has ended; request new work instead',
          );
        const tail: AtomicOperation[] =
          target && target.id !== run.id
            ? [
                ...(p.action === 'resume'
                  ? [
                      {
                        sql: "UPDATE assistant_runs SET state='completed',updated_at=? WHERE id=?",
                        params: [now(), run.id],
                      },
                    ]
                  : []),
                {
                  sql: 'UPDATE assistant_runs SET state=?,error=NULL,updated_at=? WHERE id=?',
                  params: [
                    p.action === 'resume'
                      ? target.jobId
                        ? 'waiting_job'
                        : 'running'
                      : p.action === 'cancel'
                        ? 'cancelled'
                        : 'paused',
                    now(),
                    target.id,
                  ],
                },
                ...(p.action === 'resume'
                  ? [
                      {
                        sql: "UPDATE assistant_operations SET state='waiting_job',error=NULL,result_json=json_set(result_json,'$.state','waiting_job') WHERE run_id=? AND json_extract(result_json,'$.jobId')=?",
                        params: [target.id, target.jobId],
                      },
                    ]
                  : []),
              ]
            : [];
        const controlCommit = operationWriter(op, result, { tail });
        if (job) {
          if (p.action === 'pause') await pauseJob(job.id, controlCommit);
          else if (p.action === 'cancel') await cancelJob(job.id, controlCommit);
          else await resumeJob(job.id, controlCommit);
        } else await controlCommit([]);
        if (target && target.id !== run.id) {
          const control = await import('./runtime');
          if (p.action === 'resume') await control.resumeAssistant(target.id);
          else await control.pauseAssistant(target.id, p.action === 'cancel');
        }
        break;
      }
      case 'undo': {
        const p = operation.parameters;
        const targetId = p.operationId
          ? (await getOperation(p.operationId))?.runId
          : (p.runId ?? (await previousRun(run)));
        const target = targetId ? await getRun(targetId) : null;
        if (!target || target.novelId !== novelId || target.id === run.id)
          throw new Error('Choose a previous turn in this work');
        const { undoAssistantChanges } = await import('./runtime');
        await undoAssistantChanges(target.id, p.operationId);
        await finishOperation(op, result);
        break;
      }
      case 'branch_create':
        await createStoryBranch(
          novelId,
          operation.parameters.nodeId,
          operation.parameters.name,
          commit,
        );
        break;
      case 'read_prose':
        ownChapter(operation.parameters.chapterId);
        await readStoryProse(novelId, operation.parameters.chapterId, signal, commit);
        break;
      case 'reading_candidate': {
        const p = operation.parameters;
        if (!(await listStoryReadings(novelId)).some((c) => c.id === p.id))
          throw new Error('Reading candidate does not belong to this work');
        if (p.action === 'accept') {
          const owned = await getDb().select(
            "SELECT c.row_id FROM assistant_row_changes c JOIN assistant_operations o ON o.id=c.operation_id WHERE o.run_id=? AND c.table_name='story_suggestions' AND c.row_id=? AND c.before_json IS NULL",
            [run.id, p.id],
          );
          if (intent === 'authorized_continuation' && !owned.length)
            throw new ClarificationRequired(
              'Historical readings require an explicit adoption request',
            );
          await acceptStoryReading(novelId, p.id, commit);
        } else await dismissStoryReading(novelId, p.id, commit);
        break;
      }
      case 'suggest_voice':
        result.detail = await suggestStoryVoice(novelId, signal);
        await finishOperation(op, result);
        break;
      case 'restore_story_change':
        await undoStoryChange(novelId, operation.parameters.id, commit);
        break;
      case 'branch_edit': {
        const branch = (await listStoryBranches(novelId)).find(
          (b) => b.id === operation.parameters.id,
        );
        if (!branch) throw new Error('Experiment does not belong to this work');
        await saveStoryBranch(novelId, branch, operation.parameters, commit);
        break;
      }
      case 'branch_sample':
      case 'branch_merge': {
        const branch = (await listStoryBranches(novelId)).find(
          (b) => b.id === operation.parameters.id,
        );
        if (!branch) throw new Error('Experiment does not belong to this work');
        if (operation.name === 'branch_sample')
          await generateBranchSample(
            novelId,
            branch,
            operation.parameters.instruction,
            signal,
            commit,
          );
        else {
          if (!operation.parameters.prose && branch.sample)
            throw new ClarificationRequired(
              'This experiment includes prose; clarify whether to merge it',
            );
          await mergeStoryBranch(novelId, branch, commit);
        }
        break;
      }
      case 'export_work': {
        const p = operation.parameters;
        if (
          (p.from === undefined) !== (p.to === undefined) ||
          (p.from !== undefined && p.from > p.to!)
        )
          throw new Error('Invalid export range');
        const { exportNovel } = await import('@/novel/export');
        const path = await exportNovel(novel, p.format, {
          draft: p.draft,
          range: p.from ? { from: p.from, to: p.to! } : null,
        });
        if (!path) throw new ClarificationRequired('Export cancelled; no file was written');
        result.detail = { path };
        await finishOperation(op, result);
        break;
      }
      default: {
        const unregistered: never = operation;
        throw new Error(`Unregistered assistant operation: ${JSON.stringify(unregistered)}`);
      }
    }
    return result;
  } catch (error) {
    await failOperation(op.id, error instanceof Error ? error.message : String(error));
    throw error;
  }
}
function candidateId(operation: Extract<AssistantOperation, { name: 'candidate' }>) {
  return operation.parameters.id;
}
async function previousRun(run: AssistantRun) {
  const row = await selectOne<{ id: string }>(
    'SELECT id FROM assistant_runs WHERE conversation_id=? AND id<>? AND created_at<=? ORDER BY created_at DESC LIMIT 1',
    [run.conversationId, run.id, run.createdAt],
  );
  if (!row) throw new Error('No previous turn');
  return row.id;
}
async function startOperationJob(
  run: AssistantRun,
  op: OperationRecord,
  operation: Extract<
    AssistantOperation,
    { name: 'plan' | 'write' | 'rewrite' | 'review' | 'extract_style' | 'finish_work' }
  >,
  result: AssistantResult,
  signal: AbortSignal,
) {
  const novelId = run.novelId!,
    novel = (await getNovel(novelId))!;
  await assertBudget(novelId);
  signal.throwIfAborted();
  if ((await listJobs({ novelId, statuses: [...BLOCKING_JOB_STATUSES, 'cancelling'] })).length)
    throw new ClarificationRequired('An existing task must finish or be cancelled first');
  const chapters = await listChapters(novelId);
  const ids = 'chapterIds' in operation.parameters ? operation.parameters.chapterIds : undefined;
  const chosen = ids
    ? ids.map((id) => {
        const c = chapters.find((c) => c.id === id);
        if (!c) throw new Error('Chapter does not belong to this work');
        return c;
      })
    : chapters;
  let steps;
  if (operation.name === 'plan')
    steps = planPlanning({
      outline: operation.parameters.stage !== 'chapters',
      chapterTable: operation.parameters.stage !== 'outline',
    });
  else if (operation.name === 'finish_work' && (!novel.meta.outlineDone || !novel.meta.tableDone))
    steps = planPlanning({ outline: !novel.meta.outlineDone, chapterTable: !novel.meta.tableDone });
  else if (operation.name === 'review') steps = chosen.flatMap(planStyleCheck);
  else if (operation.name === 'finish_work')
    steps = chosen.flatMap((c) =>
      !c.currentVersionId
        ? planGenerate([c], { fiction: docTypeGuide(novel.requirements.docType).fiction })
        : c.currentVersionId !== c.committedVersionId || c.memoryStatus !== 'valid'
          ? planStyleCheck(c)
          : [],
    );
  else if (operation.name === 'rewrite')
    steps = planRewrite(
      chosen.map((chapter) => ({
        chapter,
        mode: 'revise',
        instructions: [operation.parameters.instruction],
      })),
    );
  else if (operation.name === 'extract_style')
    steps = [{ kind: 'extract_style' as const, chapterId: null, input: {} }];
  else steps = planGenerate(chosen, { fiction: docTypeGuide(novel.requirements.docType).fiction });
  if (!steps.length)
    throw new ClarificationRequired('No eligible chapters; inspect the plan and existing drafts');
  const jobId = nanoid(),
    providerIds = await getNovelProviders(novelId);
  const goal = operation.name === 'finish_work' ? operation.parameters.goal : run.goal,
    constraints =
      operation.name === 'finish_work' ? operation.parameters.constraints : run.constraints;
  const scope = ids ?? null;
  result.state = 'waiting_job';
  result.jobId = jobId;
  result.objectIds = chosen.map((c) => c.id);
  result.location = `/studio/${novelId}/jobs`;
  const commit = operationWriter(op, result, {
    tail: [
      {
        sql: "UPDATE assistant_runs SET state='waiting_job',job_id=?,goal=?,constraints_json=? WHERE id=?",
        params: [jobId, goal, JSON.stringify(constraints), run.id],
      },
    ],
  });
  await createJob({
    id: jobId,
    novelId,
    type:
      operation.name === 'rewrite'
        ? 'rewrite'
        : operation.name === 'review'
          ? 'style_check'
          : operation.name === 'extract_style'
            ? 'extract_style'
            : 'generate_novel',
    providerId: providerIds.writing ?? null,
    params: {
      providerIds,
      assistantRunId: run.id,
      assistantOperationId: op.id,
      assistantChapterIds: scope,
      assistantGoal: goal,
      assistantConstraints: constraints,
      ...(steps.some((s) => s.kind === 'outline' || s.kind === 'chapter_table')
        ? { stage: 'plan' }
        : {}),
    },
    steps,
    commit,
  });
  kick();
  return result;
}
