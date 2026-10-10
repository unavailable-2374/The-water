import { useEffect, useRef, useState } from 'react';
import { StoryOptionsPanel } from '@/features/studio/StoryOptionsPanel';
import { StoryOptionScopeSchema } from '@the-water/shared';
import { Link } from 'react-router';
import { create } from 'zustand';
import { nanoid } from 'nanoid';
import type { AssistantOperationName, AssistantRun, AssistantState } from '@the-water/shared';
import { fmt, t } from '@/i18n';
import { Button, Select, Input } from '@/components/ui';
import { Bubble, Composer } from '@/components/conversation';
import { ActivityStatus } from '@/components/Activity';
import { useAsyncData } from '@/components/data/useAsyncData';
import { toast } from '@/components/Toast';
import { listNovels } from '@/db/repos/novelsRepo';
import { listChapters, getVersion } from '@/db/repos/chaptersRepo';
import { listConversations, listMessages } from '@/db/repos/conversationsRepo';
import { getDb } from '@/db/db';
import { listDocuments } from '@/db/repos/documentsRepo';
import { getJob } from '@/db/repos/jobsRepo';
import { getNovelProviders, setNovelProviders } from '@/novel/service';
import { ModelPurposePicker } from '@/features/studio/ModelPicker';
import {
  useAssistant,
  sendAssistant,
  pauseAssistant,
  resumeAssistant,
  undoAssistantChanges,
} from './runtime';
import {
  sessionFor,
  listRuns,
  listOperations,
  changesFor,
  type OperationRecord,
} from './repository';

const useDrafts = create<{
  values: Record<string, string>;
  set: (key: string, value: string) => void;
}>((set) => ({
  values: {},
  set: (key, value) => set((s) => ({ values: { ...s.values, [key]: value } })),
}));
const act = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
  } catch (error) {
    toast.error(String(error));
  }
};
export function AssistantPanel({ compact = false }: { compact?: boolean }) {
  const context = useAssistant((s) => s.context),
    tick = useAssistant((s) => s.tick),
    setContext = useAssistant((s) => s.setContext);
  const scope = context.novelId ?? 'global',
    input = useDrafts((s) => s.values[scope] ?? ''),
    setInput = (value: string) => useDrafts.getState().set(scope, value);
  const [sending, setSending] = useState(false),
    [documentId, setDocumentId] = useState(''),
    [page, setPage] = useState(1);
  const request = useRef<{ id: string; text: string; scope: string } | null>(null),
    bottom = useRef<HTMLDivElement>(null);
  const {
    data: loaded,
    error,
    reload,
  } = useAsyncData(
    async () => {
      const conversationId = await sessionFor(context);
      const runs = await listRuns(conversationId);
      const sessions = await getDb().select<{ conversation_id: string }>(
        'SELECT conversation_id FROM assistant_sessions',
      );
      const legacy = (
        await listConversations(context.novelId ? { novelId: context.novelId } : {})
      ).filter(
        (c) =>
          !sessions.some((s) => s.conversation_id === c.id) &&
          (context.novelId || !c.novelId) &&
          ['scratch', 'novel_assist'].includes(c.kind),
      );
      return {
        scope,
        conversationId,
        runs,
        messages: await listMessages(conversationId),
        works: await listNovels(),
        chapters: context.novelId ? await listChapters(context.novelId) : [],
        documents: await listDocuments(),
        legacy: await Promise.all(
          legacy.map(async (c) => ({ ...c, messages: await listMessages(c.id) })),
        ),
        operations: await Promise.all(
          runs.map(async (run) => ({ run, operations: await listOperations(run.id) })),
        ),
        providers: context.novelId ? await getNovelProviders(context.novelId) : {},
      };
    },
    { key: `assistant:${scope}:${tick}` },
  );
  // The data hook preserves stale values while refreshing. Never show a previous work under a new scope.
  const data = loaded?.scope === scope ? loaded : null;
  const active = data?.runs.find((r) => r.state === 'running' || r.state === 'waiting_job');
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'nearest' });
  }, [data?.messages.length, data?.operations.length]);
  const send = () =>
    act(async () => {
      if (sending || !input.trim()) return;
      setSending(true);
      const text = input.trim();
      if (!request.current || request.current.text !== text || request.current.scope !== scope)
        request.current = { id: nanoid(), text, scope };
      try {
        await sendAssistant(text, context, request.current.id);
        setInput('');
        request.current = null;
      } finally {
        setSending(false);
      }
    });
  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col" aria-label={t.assistant.title}>
      <div className="space-y-2 border-b border-paper-300/40 p-4 dark:border-paper-800">
        {!compact && <h1 className="font-semibold">{t.assistant.title}</h1>}
        <Select
          aria-label={t.assistant.work}
          value={context.novelId ?? ''}
          onChange={(e) =>
            setContext({
              novelId: e.target.value || null,
              chapterId: null,
              selection: null,
              objectIds: [],
              sourceIds: [],
            })
          }
        >
          <option value="">{t.assistant.global}</option>
          {data?.works.map((n) => (
            <option key={n.id} value={n.id}>
              {n.title}
            </option>
          ))}
        </Select>
        {!!context.novelId && (
          <Select
            aria-label={t.assistant.chapter}
            value={context.chapterId ?? ''}
            onChange={(e) =>
              setContext({ chapterId: e.target.value || null, selection: null, objectIds: [] })
            }
          >
            <option value="">{t.assistant.all}</option>
            {data?.chapters.map((c) => (
              <option key={c.id} value={c.id}>
                {c.chapterNo}. {c.title}
              </option>
            ))}
          </Select>
        )}
        {context.novelId && (
          <details>
            <summary className="text-xs text-ink-500">{t.assistant.models}</summary>
            <ModelPurposePicker
              value={data?.providers ?? {}}
              onChange={(value) =>
                void act(async () => {
                  await setNovelProviders(context.novelId!, value);
                  reload();
                })
              }
            />
          </details>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4" role="log" aria-live="polite">
        {error != null && (
          <p role="alert">
            {String(error)} <Button onClick={reload}>{t.common.retry}</Button>
          </p>
        )}
        {data?.messages.length === 0 && (
          <p className="my-10 text-sm text-ink-500">{t.assistant.empty}</p>
        )}
        {data?.messages.map((message) => (
          <div className="mb-4" key={message.id}>
            <Bubble role={message.role} text={message.content} />
            {data.operations
              .filter((entry) => entry.run.messageId === message.id)
              .map(({ run, operations }) => (
                <RunCard key={run.id} run={run} operations={operations} />
              ))}
          </div>
        ))}
        {active && <ActivityStatus label={t.assistant.state[active.state]} elapsed />}
        {!!data?.legacy.length && (
          <details className="mt-5 text-xs">
            <summary>{t.assistant.history}</summary>
            {data.legacy.map((c) => (
              <details key={c.id}>
                <summary>{c.title}</summary>
                {c.messages.map((m) => (
                  <blockquote className="my-3 whitespace-pre-wrap" key={m.id}>
                    {m.content}
                  </blockquote>
                ))}
              </details>
            ))}
          </details>
        )}
        <div ref={bottom} />
      </div>
      <div className="space-y-2 p-4 pt-2">
        <div
          className="rounded-lg bg-paper-200/60 p-2 text-xs dark:bg-paper-800"
          aria-label={t.assistant.context}
        >
          {data?.works.find((n) => n.id === context.novelId)?.title ?? t.assistant.global}
          {context.chapterId &&
            ` · ${data?.chapters.find((c) => c.id === context.chapterId)?.title ?? t.assistant.chapter}`}
          {context.selection && (
            <span>
              {' '}
              · {t.assistant.selection} {context.selection.from}–{context.selection.to}{' '}
              <button aria-label={t.common.close} onClick={() => setContext({ selection: null })}>
                ×
              </button>
            </span>
          )}
          {!!context.objectIds.length && (
            <span>
              {' '}
              · {t.assistant.objects}: {context.objectIds.length}
            </span>
          )}
          {!!context.sourceIds.length && (
            <span>
              {' '}
              · {t.assistant.sources}: {context.sourceIds.length}
            </span>
          )}
        </div>
        <details className="text-xs">
          <summary>{t.assistant.sources}</summary>
          <div className="flex gap-1 py-2">
            <Select
              aria-label={t.assistant.sources}
              value={documentId}
              onChange={(e) => setDocumentId(e.target.value)}
            >
              <option value="">—</option>
              {data?.documents.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.title}
                </option>
              ))}
            </Select>
            <Input
              aria-label={t.assistant.page}
              type="number"
              min={1}
              max={data?.documents.find((d) => d.id === documentId)?.pageCount}
              value={page}
              onChange={(e) => setPage(Number(e.target.value))}
            />
            <Button
              disabled={!documentId}
              onClick={() =>
                setContext({
                  sourceIds: [...new Set([...context.sourceIds, `pdf:${documentId}:${page}`])],
                })
              }
            >
              {t.assistant.add}
            </Button>
          </div>
          {context.sourceIds.map((id) => (
            <button
              className="block"
              key={id}
              onClick={() => setContext({ sourceIds: context.sourceIds.filter((s) => s !== id) })}
            >
              {data?.documents.find((d) => id.startsWith(`pdf:${d.id}:`))?.title} ·{' '}
              {id.split(':').at(-1)} ×
            </button>
          ))}
        </details>
        <Composer
          value={input}
          onChange={setInput}
          onSend={() => void send()}
          onStop={() => active && void act(() => pauseAssistant(active.id))}
          streaming={null}
          placeholder={t.assistant.placeholder}
          hint={t.assistant.hint}
          compact={compact}
        />
      </div>
    </section>
  );
}
function RunCard({ run, operations }: { run: AssistantRun; operations: OperationRecord[] }) {
  const refresh = () => useAssistant.setState((s) => ({ tick: s.tick + 1 }));
  const undo = async (id?: string) => {
    await undoAssistantChanges(run.id, id);
    refresh();
  };
  return (
    <div className="my-3 space-y-2 rounded-xl border border-paper-300 p-3 text-sm dark:border-paper-700">
      <div className="flex flex-wrap items-center gap-2">
        <span role="status">{t.assistant.state[run.state]}</span>
        {['running', 'waiting_job'].includes(run.state) && (
          <Button size="sm" onClick={() => void act(() => pauseAssistant(run.id))}>
            {t.assistant.pause}
          </Button>
        )}
        {['paused', 'needs_input', 'partial', 'failed'].includes(run.state) && (
          <Button size="sm" onClick={() => void act(() => resumeAssistant(run.id))}>
            {t.assistant.resume}
          </Button>
        )}
        {!['completed', 'cancelled', 'undone'].includes(run.state) && (
          <Button size="sm" onClick={() => void act(() => pauseAssistant(run.id, true))}>
            {t.assistant.cancel}
          </Button>
        )}
        {run.novelId &&
          operations.some(
            (o) =>
              !['inspect', 'export_work', 'task', 'undo'].includes(o.name) &&
              ['completed', 'waiting_job', 'partial', 'failed', 'cancelled'].includes(o.state),
          ) && (
            <Button size="sm" onClick={() => void act(() => undo())}>
              {t.assistant.undoTurn}
            </Button>
          )}
      </div>
      {run.error && (
        <p role="alert" className="whitespace-pre-wrap text-cinnabar-600">
          {run.error}
        </p>
      )}
      {operations
        .filter((o) => o.name !== 'inspect')
        .map((op) => (
          <OperationCard key={`${op.id}:${op.state}`} op={op} undo={() => undo(op.id)} />
        ))}
    </div>
  );
}
function OperationCard({ op, undo }: { op: OperationRecord; undo: () => Promise<void> }) {
  const tick = useAssistant((s) => s.tick);
  const { data } = useAsyncData(
    async () => {
      const changes = await changesFor(op.id),
        diffs = [];
      for (const c of changes)
        if (c.table_name === 'chapters') {
          const before = c.before_json ? JSON.parse(c.before_json) : null,
            after = c.after_json ? JSON.parse(c.after_json) : null;
          if (before?.current_version_id !== after?.current_version_id)
            diffs.push({
              id: c.row_id,
              before: (await getVersion(before?.current_version_id ?? null))?.content ?? '',
              after: (await getVersion(after?.current_version_id ?? null))?.content ?? '',
            });
        }
      const labels = changes
        .filter(
          (c) =>
            ![
              'story_changes',
              'writing_proposals',
              'story_suggestions',
              'chapter_structure_changes',
            ].includes(c.table_name),
        )
        .map((c) => {
          const row = JSON.parse(c.after_json ?? c.before_json ?? '{}');
          return (
            row.title ??
            row.name ??
            (c.table_name === 'settings' ? t.assistant.operation.author_note : null)
          );
        })
        .filter((value): value is string => typeof value === 'string' && !!value);
      return {
        changes,
        diffs,
        labels,
        job: op.result?.jobId ? await getJob(op.result.jobId) : null,
      };
    },
    { key: `assistant-result:${op.id}:${op.state}:${tick}` },
  );
  const label = t.assistant.operation[op.name as AssistantOperationName] ?? op.name;
  const optionScope = op.name === 'story_options' && typeof op.parameters === 'object' && op.parameters !== null && 'scope' in op.parameters ? StoryOptionScopeSchema.safeParse(op.parameters.scope) : null;
  const jobStatus = data?.job?.status;
  const state =
    op.state === 'waiting_job' &&
    jobStatus &&
    ['paused', 'cancelled', 'failed', 'awaiting_review'].includes(jobStatus)
      ? jobStatus === 'awaiting_review'
        ? 'needs_input'
        : jobStatus === 'failed' && data.changes.length
          ? 'partial'
          : jobStatus
      : op.state;
  return (
    <article className="border-t border-paper-300/50 pt-2">
      <div className="flex flex-wrap gap-2">
        <strong>{label}</strong>
        <span>{t.assistant.state[state as AssistantState] ?? state}</span>
      </div>
      {!!data?.changes.length && (
        <p className="text-xs text-ink-500">
          {fmt(t.assistant.changedObjects, {
            count: data.changes.filter((c) => c.table_name !== 'story_changes').length,
          })}
          {data.labels.length ? ` · ${[...new Set(data.labels)].join('、')}` : ''}
        </p>
      )}
      {op.error && <p role="alert">{op.error}</p>}
      {optionScope?.success && op.novelId && <StoryOptionsPanel owner={{ novelId: op.novelId }} scope={optionScope.data} initialBatchId={op.result?.objectIds[0]} />}
      {data?.job && (
        <p>
          {t.jobs.status[data.job.status]} · {data.job.progress.done}/{data.job.progress.total}
          {data.job.error && ` · ${data.job.error}`}
        </p>
      )}
      {op.result?.location && (
        <Link className="mr-3 underline" to={op.result.location}>
          {t.assistant.locate}
        </Link>
      )}
      {!!data?.changes.length && op.state !== 'undone' && (
        <Button size="sm" onClick={() => void act(undo)}>
          {t.assistant.undo}
        </Button>
      )}
      {!!data?.diffs.length && (
        <details>
          <summary>{t.assistant.changes}</summary>
          {data.diffs.map((d) => (
            <div key={d.id} className="max-h-96 overflow-auto text-xs">
              <p>{t.assistant.before}</p>
              <del className="block whitespace-pre-wrap">{d.before}</del>
              <p className="mt-3">{t.assistant.after}</p>
              <ins className="block whitespace-pre-wrap no-underline">{d.after}</ins>
            </div>
          ))}
        </details>
      )}
    </article>
  );
}
