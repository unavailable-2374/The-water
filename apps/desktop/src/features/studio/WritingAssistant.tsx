import { ActivityStatus, StreamingCursor } from '@/components/Activity';
import { PlanReview } from './PlanReview';
import { getNovel } from '@/db/repos/novelsRepo';
import { useEffect, useRef, useState } from 'react';
import type { TextProposal } from '@the-water/shared';
import { t } from '@/i18n';
import { Button, Input, Select } from '@/components/ui';
import { toast } from '@/components/Toast';
import { useAsyncData } from '@/components/data/useAsyncData';
import {
  acceptTextProposal,
  assistantRequest,
  assistantHistory,
  listTextProposals,
  listAssistantReferences,
  previewAssistantRequest,
} from '@/novel/assistant';
import { discardProposal, listWritingCards, listPlanProposals, proposeCard } from '@/db/repos/writingRepo';
import { listDocuments } from '@/db/repos/documentsRepo';
import { CostEstimateLine } from './UsagePanel';

export function WritingAssistant(props: {
  novelId: string;
  chapterId: string;
  versionId: string | null;
  text: string;
  selection: { from: number; to: number; head?: number };
  onPrepare: () => Promise<string | null>;
  onApply: (text: string, proposalId: string) => Promise<void>;
}) {
  const [operation, setOperation] = useState<TextProposal['operation'] | 'discuss'>('discuss'),
    [instruction, setInstruction] = useState(''),
    [sources, setSources] = useState<string[]>([]),
    [answer, setAnswer] = useState(''),
    [running, setRunning] = useState(false),
    [tick, setTick] = useState(0);
  const [documentId, setDocumentId] = useState(''),
    [pageNo, setPageNo] = useState(1);
  const ac = useRef<AbortController | null>(null);
  useEffect(() => () => ac.current?.abort(), []);
  const { data, error: loadError, reload } = useAsyncData(
    async () => ({
      cards: await listWritingCards(props.novelId, { confirmed: true }),
      history: await assistantHistory(props.novelId, props.chapterId),
      references: await listAssistantReferences(props.novelId),
      documents: await listDocuments(),
      proposals: await listTextProposals(props.chapterId),
      materialProposals: (await listPlanProposals(props.novelId)).filter(p => !p.chapterId),
      novel: await getNovel(props.novelId),
    }),
    { key: `writingAssist:${props.chapterId}:${tick}` },
  );
  const { data: cost } = useAsyncData(
    () =>
      previewAssistantRequest({
        ...props,
        from: operation==='continue' ? (props.selection.head ?? props.selection.to):props.selection.from,
        to: props.selection.to,
        operation,
        instruction,
        sourceIds: sources,
        signal: new AbortController().signal,
        onDelta: () => undefined,
      }),
    {
      key: `assistCost:${props.chapterId}:${props.text.length}:${instruction.length}:${operation}:${sources.join(',')}`,
    },
  );
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      setTick((n) => n + 1);
    } catch (e) {
      toast.error(String(e));
    }
  };
  return (
    <aside className="w-80 shrink-0 overflow-y-auto rounded-2xl bg-paper-0 p-4 text-sm dark:bg-paper-900">
      <h3 className="mb-3 font-sans text-lg">{t.studio.workbench.assistant}</h3>
      {data?.novel && <div className="mb-4"><PlanReview novel={data.novel} cards={data.materialProposals} onResolved={() => {setTick(n=>n+1);}} /></div>}
      {loadError != null && <div role="alert" className="mb-3 text-xs text-cinnabar-600"><p>{String(loadError)}</p><Button size="sm" onClick={reload}>{t.common.retry}</Button></div>}
      {!!data?.history.length && (
        <details className="mb-3">
          <summary>{t.studio.workbench.discussionHistory}</summary>
          {data.history.map((m) => (
            <blockquote key={m.id} className="my-2 whitespace-pre-wrap border-l-2 border-paper-300 pl-2">
              {m.role === 'user' ? t.studio.workbench.author : t.studio.workbench.assistant}: {m.content}
            </blockquote>
          ))}
        </details>
      )}
      <Select value={operation} onChange={(e) => setOperation(e.target.value as typeof operation)}>
        {(['discuss', 'continue', 'rewrite', 'expand', 'condense', 'dialogue', 'action'] as const).map(
          (k) => (
            <option key={k} value={k}>
              {t.studio.workbench[k]}
            </option>
          ),
        )}
      </Select>
      <textarea
        className="my-3 min-h-24 w-full rounded-lg border border-paper-300 bg-transparent p-2"
        aria-label={t.studio.workbench.instruction}
        value={instruction}
        onChange={(e) => setInstruction(e.target.value)}
      />
      <details>
        <summary>{t.studio.workbench.sources}</summary>
        {data?.references.map((c) => (
          <label key={c.id} className="block">
            <input
              type="checkbox"
              checked={sources.includes(c.id)}
              onChange={(e) =>
                setSources((v) => (e.target.checked ? [...v, c.id] : v.filter((id) => id !== c.id)))
              }
            />{' '}
            {c.title}
          </label>
        ))}
        <Select
          aria-label={t.studio.workbench.referenceDocument}
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
          aria-label={t.studio.workbench.referencePage}
          type="number"
          min={1}
          max={data?.documents.find((d) => d.id === documentId)?.pageCount}
          value={pageNo}
          onChange={(e) => setPageNo(Number(e.target.value))}
        />
        <Button
          disabled={!documentId}
          onClick={() => setSources((v) => [...new Set([...v, `pdf:${documentId}:${pageNo}`])])}
        >
          {t.studio.workbench.add}
        </Button>
        {sources
          .filter((id) => id.startsWith('pdf:'))
          .map((id) => (
            <button
              key={id}
              className="block text-xs"
              onClick={() => setSources((v) => v.filter((x) => x !== id))}
            >
              {data?.documents.find((d) => id.startsWith(`pdf:${d.id}:`))?.title} · {id.split(':').at(-1)} ×
            </button>
          ))}
      </details>
      <CostEstimateLine preview={cost ?? null} />
      <Button
        disabled={running || !instruction.trim()}
        onClick={() =>
          act(async () => {
            ac.current = new AbortController();
            setAnswer('');
            setRunning(true);
            try {
              const versionId = await props.onPrepare();
              const result = await assistantRequest({
                ...props,
                versionId,
                from: operation==='continue' ? (props.selection.head ?? props.selection.to):props.selection.from,
                to: props.selection.to,
                operation,
                instruction,
                sourceIds: sources,
                signal: ac.current.signal,
                onDelta: setAnswer,
              });
              setAnswer(result.answer);
            } finally {
              setRunning(false);
            }
          })
        }
      >
        {running ? <ActivityStatus label={t.chat.thinking} /> : t.studio.workbench.generate}
      </Button>
      {running && <Button onClick={() => ac.current?.abort()}>{t.studio.workbench.cancel}</Button>}
      {running && !answer && <div className="my-4 text-sm text-ink-500"><ActivityStatus label={t.chat.thinking} elapsed /></div>}
      {answer && <div className="my-4 whitespace-pre-wrap">{answer}{running && answer && <StreamingCursor />}</div>}
      {answer && !running && operation === 'discuss' && (
        <Button
          onClick={() =>
            act(async () => {
              const brief = data?.cards.find((c) => c.kind === 'brief');
              if (brief?.kind === 'brief')
                await proposeCard(
                  props.novelId,
                  { kind: 'brief', data: { ...brief.data, mainline: answer } },
                  null,
                  { id: brief.id, revision: brief.revision },
                );
              else
                await proposeCard(
                  props.novelId,
                  {
                    kind: 'brief',
                    data: {
                      premise: '',
                      mainline: answer,
                      ending: '',
                      audience: '',
                      constraints: [],
                      rollingChapters: 5,
                    },
                  },
                  null,
                );
            })
          }
        >
          {t.studio.workbench.applyPlan}
        </Button>
      )}
      {data?.proposals.map((p) => (
        <article key={p.id} className="my-4 border-t border-paper-300 pt-3">
          <h4>{t.studio.workbench[p.operation]}</h4>
          <p className="text-xs text-ink-500">{t.studio.workbench.before}</p>
          <del className="whitespace-pre-wrap">{p.original}</del>
          <p className="mt-2 text-xs text-ink-500">{t.studio.workbench.after}</p>
          <ins className="whitespace-pre-wrap no-underline">{p.replacement}</ins>
          <div className="mt-2 flex gap-2">
            <Button
              onClick={() =>
                act(async () => {
                  const text = await acceptTextProposal(p, props.text);
                  await props.onApply(text, p.id);
                })
              }
            >
              {t.studio.workbench.accept}
            </Button>
            <Button onClick={() => act(() => discardProposal(p.id))}>{t.studio.workbench.discard}</Button>
          </div>
        </article>
      ))}
    </aside>
  );
}
