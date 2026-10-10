import { useJobs } from '@/stores/jobsStore';
import { ActivityStatus } from '@/components/Activity';
import { AsyncNotice } from '@/components/data/AsyncNotice';
import { PlanReview } from './PlanReview';
import {
  reorderChapters,
  mergeChapters,
  cancelChapterMerge,
  pendingChapterMerges,
} from '@/db/repos/chapterStructureRepo';
import { emitJobEvent } from '@/jobs/events';
import {
  listDocumentPlans,
} from '@/db/repos/planProposalsRepo';
import { useState } from 'react';
import { WritingCardDataSchema, type WritingCardData } from '@the-water/shared';
import { t } from '@/i18n';
import { Button, Input, Select, Textarea } from '@/components/ui';
import { toast } from '@/components/Toast';
import { useAsyncData } from '@/components/data/useAsyncData';
import { getVersion, listArchivedChapters, listChapters, upsertChapterPlan } from '@/db/repos/chaptersRepo';
import {
  acceptPlanProposal,
  discardProposal,
  listWritingCards,
  listThreadStates,
  listPlanProposals,
  pageCanonEvents,
  pageImportedMaterials,
  saveWritingCard,
  reorderCards,
  splitScene,
  mergeScenes,
  type WritingCard,
} from '@/db/repos/writingRepo';
import { listCharacters, listArcs } from '@/db/repos/storylineRepo';
import { createJob, listJobs, BLOCKING_JOB_STATUSES } from '@/db/repos/jobsRepo';
import { kick } from '@/jobs/runner';
import { planStyleCheck } from '@/jobs/planner';
import type { Novel } from '@/db/repos/novelsRepo';

function blank(kind: WritingCardData['kind']): WritingCardData {
  switch (kind) {
    case 'brief':
      return {
        kind,
        data: { premise: '', mainline: '', ending: '', audience: '', readingExperience: '', distinctiveApproach: '', protagonistLimits: '', firstChoice: '', choiceConsequences: '', storyEngine: '', endingConditions: '', constraints: [], rollingChapters: 5 },
      };
    case 'volume':
      return { kind, data: { title: '', summary: '', startChapterNo: 1, endChapterNo: 1, arcIds: [] } };
    case 'scene':
      return {
        kind,
        data: {
          title: '',
          volumeId: null,
          povCharacterId: null,
          time: '',
          location: '',
          characterIds: [],
          goal: '',
          obstacle: '',
          turn: '',
          outcome: '', readerInterest:'',choice:'',choiceReason:'',consequence:'',beforeState:'',afterState:'',presentation:'dramatize',
          targetChars: 1000,
          dependencyIds: [],
          threadIds: [],
        },
      };
    case 'thread':
      return {
        kind,
        data: { title: '', setup: '', progression: '', payoff: '', plannedChapterNo: null, characterIds: [], milestones: [] },
      };
    case 'character':
      return { kind, data: { characterId: '', goal: '', motivation: '', contradiction: '', fear:'',belief:'',habitualStrategy:'',independentAgenda:'',growth: [] } };
  }
}
export const cardTitle = (card: WritingCardData): string =>
  'title' in card.data ? card.data.title : card.kind === 'brief' ? card.data.premise : card.data.goal;
const renderValue = (value: unknown): string =>
  Array.isArray(value)
    ? value.map((v) => (typeof v === 'object' ? `${v.chapterNo}: ${v.change}` : v)).join('\n')
    : String(value ?? '');

export function WritingMaterials({ novel }: { novel: Novel }) {
  const novelTick=useJobs(s=>s.novelTick[novel.id]??0);
  const [cardPage, setCardPage] = useState(0),
    [cardChapter, setCardChapter] = useState('');
  const [importPage, setImportPage] = useState(0);
  const [memoryPage, setMemoryPage] = useState(0),
    [memoryQuery, setMemoryQuery] = useState(''),
    [sourceText, setSourceText] = useState('');
  const [tick, setTick] = useState(0),
    [kind, setKind] = useState<WritingCardData['kind']>('brief');
  const [editing, setEditing] = useState<WritingCardData | null>(null),
    [base, setBase] = useState<WritingCard | null>(null),
    [chapterId, setChapterId] = useState('');
  const { data, error, reload } = useAsyncData(
    async () => ({
      imports: await pageImportedMaterials(novel.id, importPage),
      cards: await listWritingCards(novel.id),
      threads: await listThreadStates(novel.id),
      merges: await pendingChapterMerges(novel.id),
      archived: await listArchivedChapters(novel.id),
      documentPlans: await listDocumentPlans(novel.id),
      proposals: await listPlanProposals(novel.id),
      chapters: await listChapters(novel.id),
      characters: await listCharacters(novel.id),
      arcs: await listArcs(novel.id),
      memory: await pageCanonEvents(novel.id, memoryPage, memoryQuery),
    }),
    { key: `writingMaterials:${novel.id}:${novelTick}:${tick}:${memoryPage}:${memoryQuery}:${importPage}` },
  );
  const [acting, setActing] = useState(false);
  const act = async (fn: () => Promise<unknown>) => {
    if (acting) return;
    setActing(true);
    try {
      await fn();
      emitJobEvent({ type: 'novel:storylineUpdated', novelId: novel.id });
      setTick((n) => n + 1);
    } catch (e) {
      toast.error(String(e));
    } finally { setActing(false); }
  };
  if (!data || error) return <AsyncNotice error={error} retry={reload} />;
  const matchingCards = data.cards.filter(
    (c) => c.kind === kind && (kind !== 'scene' || !cardChapter || c.chapterId === cardChapter),
  );
  const siblings = (card: WritingCard) =>
    data.cards.filter((c) => c.kind === card.kind && c.chapterId === card.chapterId);
  const moveUp = (card: WritingCard) => {
    const next = siblings(card),
      i = next.findIndex((c) => c.id === card.id);
    if (i <= 0) return Promise.resolve();
    [next[i - 1], next[i]] = [next[i]!, next[i - 1]!];
    return reorderCards(next);
  };
  const visibleCards = matchingCards.slice(cardPage * 50, cardPage * 50 + 50);
  const options = (key: string): Array<{ id: string; title: string }> => {
    if (['characterIds', 'characterId', 'povCharacterId'].includes(key))
      return data.characters.map((c) => ({ id: c.id, title: c.name }));
    if (key === 'arcIds') return data.arcs;
    if (key === 'dependencyIds') {
      const available = data.memory.events.map((e) => ({ id: e.id, title: e.text }));
      // Paging the evidence list must not silently drop already selected references.
      const selected = editing?.kind === 'scene' ? editing.data.dependencyIds : [];
      return [
        ...available,
        ...selected
          .filter((id) => !available.some((e) => e.id === id))
          .map((id) => ({ id, title: `${t.studio.workbench.referenceOutsidePage}: ${id}` })),
      ];
    }
    return data.cards
      .filter((c) => (key === 'volumeId' ? c.kind === 'volume' : c.kind === 'thread'))
      .map((c) => ({ id: c.id, title: cardTitle(c) }));
  };
  const label = (key: string) =>
    t.studio.workbench.fields[key as keyof typeof t.studio.workbench.fields] ?? key;
  const change = (key: string, value: unknown) =>
    setEditing((v) => (v ? ({ ...v, data: { ...v.data, [key]: value } } as WritingCardData) : null));
  return (
    <div className="h-full overflow-y-auto bg-paper-50 p-8 dark:bg-paper-950">
      {acting && <ActivityStatus label={t.common.processing} className="mb-3 text-sm text-ink-500" />}
      <fieldset disabled={acting} className="min-w-0">
      <div className="mb-5 flex gap-3">
        <Select
          aria-label={t.studio.workbench.title}
          value={kind}
          onChange={(e) => {
            setKind(e.target.value as WritingCardData['kind']);
            setCardPage(0);
          }}
        >
          {(['brief', 'volume', 'scene', 'thread', 'character'] as const).map((k) => (
            <option key={k} value={k}>
              {t.studio.workbench[k]}
            </option>
          ))}
        </Select>
        <Button
          onClick={() => {
            setBase(null);
            setEditing(blank(kind));
          }}
        >
          {t.studio.workbench.add}
        </Button>
        <Button
          onClick={() =>
            act(async () => {
              await upsertChapterPlan(novel.id, { chapterNo: (data.chapters.at(-1)?.chapterNo ?? 0) + 1 });
            })
          }
        >
          {t.studio.workbench.newChapter}
        </Button>
        <Button
          onClick={() =>
            act(async () => {
              const active = await listJobs({ novelId: novel.id, statuses: [...BLOCKING_JOB_STATUSES] });
              if (active.length) throw new Error(t.studio.workbench.activeJob);
              const chapters = data.chapters.filter(
                (c) => c.committedVersionId && c.memoryStatus !== 'valid',
              );
              if (!chapters.length) return;
              await createJob({
                novelId: novel.id,
                type: 'style_check',
                params: { rebuild: true },
                providerId: null,
                steps: chapters.flatMap(planStyleCheck),
              });
              kick();
            })
          }
        >
          {t.studio.workbench.rebuild}
        </Button>
      </div>
      <details className="mb-5">
        <summary>
          {t.studio.chapters} ({data.chapters.length})
        </summary>
        <p className="my-2 text-xs text-ink-500">{t.studio.workbench.structureNotice}</p>
        {data.merges.map((m) => (
          <Button key={m.chapter_id} onClick={() => act(() => cancelChapterMerge(m.chapter_id))}>
            {t.studio.workbench.cancelMerge}
          </Button>
        ))}
        {data.archived.map((c) => (
          <Button
            key={c.id}
            onClick={() =>
              act(async () => {
                const v = c.committedVersionId ?? c.currentVersionId;
                setSourceText(v ? ((await getVersion(v))?.content ?? '') : '');
              })
            }
          >
            {t.studio.workbench.archived}: {c.title}
          </Button>
        ))}
        {data.chapters.map((c, i) => (
          <div key={c.id} className="my-2 flex items-center gap-3">
            <span className="flex-1">
              {c.chapterNo} · {c.title}
            </span>
            <Button
              size="sm"
              disabled={i === 0}
              onClick={() =>
                act(() => {
                  const ids = data.chapters.map((x) => x.id);
                  [ids[i - 1], ids[i]] = [ids[i]!, ids[i - 1]!];
                  return reorderChapters(novel.id, ids);
                })
              }
            >
              {t.studio.workbench.up}
            </Button>
            <Button
              size="sm"
              disabled={!data.chapters[i + 1]}
              onClick={() => act(() => mergeChapters(c.id, data.chapters[i + 1]!.id))}
            >
              {t.studio.workbench.mergeChapter}
            </Button>
          </div>
        ))}
      </details>
      {editing && (
        <div className="mb-6 grid grid-cols-2 gap-4 rounded-2xl bg-paper-0 p-6 dark:bg-paper-900">
          {editing.kind === 'character' && <p className="col-span-2 text-sm text-ink-500">{t.studio.workbench.characterDesignHelp}</p>}
          {(editing.kind === 'brief' || editing.kind === 'scene') && <p className="col-span-2 text-sm text-ink-500">{t.studio.workbench.plotDesignHelp}</p>}
          {editing.kind === 'scene' && (
            <label>
              {t.studio.chapters}
              <Select
                value={base?.chapterId ?? chapterId}
                onChange={(e) => setChapterId(e.target.value)}
                disabled={!!base}
              >
                <option value="">—</option>
                {data.chapters.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.chapterNo} · {c.title}
                  </option>
                ))}
              </Select>
            </label>
          )}
          {Object.entries(editing.data).map(([key, value]) => (
            <label key={key} className="flex flex-col gap-1 text-sm">
              {label(key)}
              {key==='milestones' ? <div className="space-y-2">
                {(value as Array<{chapterNo:number;kind:string;detail:string}>).map((m,i)=> <div key={i} className="rounded border border-paper-300 p-2">
                  <div className="flex gap-2">
                    <Input aria-label={t.studio.workbench.milestoneChapter} type="number" min={1} max={500} value={m.chapterNo} onChange={e=>change(key,(value as unknown[]).map((item,j)=>j===i ? {...m,chapterNo:Number(e.target.value)} : item))} />
                    <Select aria-label={t.studio.workbench.milestoneKind} value={m.kind} onChange={e=>change(key,(value as unknown[]).map((item,j)=>j===i ? {...m,kind:e.target.value} : item))}>
                      <option value="setup">{t.studio.workbench.fields.setup}</option><option value="progress">{t.studio.workbench.fields.progression}</option><option value="payoff">{t.studio.workbench.fields.payoff}</option>
                    </Select>
                    <Button onClick={()=>change(key,(value as unknown[]).filter((_,j)=>j!==i))}>{t.common.delete}</Button>
                  </div>
                  <Textarea aria-label={t.studio.workbench.milestoneDetail} value={m.detail} onChange={e=>change(key,(value as unknown[]).map((item,j)=>j===i ? {...m,detail:e.target.value} : item))} />
                </div>)}
                <Button onClick={()=>change(key,[...(value as unknown[]),{chapterNo:1,kind:'progress',detail:''}])}>{t.studio.workbench.milestoneAdd}</Button>
              </div> : key==='presentation' ? (<Select value={String(value)} onChange={e=>change(key,e.target.value)}><option value='dramatize'>{t.studio.storyReview.dramatize}</option><option value='summarize'>{t.studio.storyReview.summarize}</option></Select>) : key.endsWith('Id') ? (
                <Select value={String(value ?? '')} onChange={(e) => change(key, e.target.value || null)}>
                  <option value="">—</option>
                  {options(key).map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.title}
                    </option>
                  ))}
                </Select>
              ) : key.endsWith('Ids') ? (
                <select
                  className="min-h-24 rounded-lg border border-paper-300 bg-transparent p-2"
                  multiple
                  value={value as string[]}
                  onChange={(e) =>
                    change(
                      key,
                      Array.from(e.target.selectedOptions, (o) => o.value),
                    )
                  }
                >
                  {options(key).map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.title}
                    </option>
                  ))}
                </select>
              ) : typeof value === 'number' || key === 'plannedChapterNo' ? (
                <Input
                  type="number"
                  value={value ?? ''}
                  onChange={(e) => change(key, e.target.value === '' ? null : Number(e.target.value))}
                />
              ) : (
                <textarea
                  className="min-h-24 rounded-lg border border-paper-300 bg-transparent p-2"
                  value={renderValue(value)}
                  onChange={(e) =>
                    change(
                      key,
                      key === 'growth'
                        ? e.target.value
                            .split('\n')
                            .filter(Boolean)
                            .map((line) => {
                              const [no, ...rest] = line.split(/[:：]/);
                              return { chapterNo: Number(no), change: rest.join(':') };
                            })
                        : Array.isArray(value)
                          ? e.target.value.split('\n').filter(Boolean)
                          : e.target.value,
                    )
                  }
                />
              )}
            </label>
          ))}
          <Button
            onClick={() =>
              act(async () => {
                if (editing.kind === 'scene' && !(base?.chapterId ?? chapterId))
                  throw new Error(t.studio.chapters);
                await saveWritingCard(novel.id, WritingCardDataSchema.parse(editing), {
                  id: base?.id,
                  expectedRevision: base?.revision,
                  chapterId: base?.chapterId ?? (chapterId || null),
                  confirmed: true,
                });
                setEditing(null);
              })
            }
          >
            {t.studio.workbench.save}
          </Button>
        </div>
      )}
      <PlanReview novel={novel} documents={data.documentPlans} cards={data.proposals.filter(p => p.card.kind === 'scene')} chapters={data.chapters} onResolved={() => { reload(); }} />
      <div className="grid grid-cols-2 gap-6">
        <section>
          <h2 className="mb-3 font-sans text-xl">{t.studio.workbench.title}</h2>
          {kind === 'scene' && (
            <Select
              aria-label={t.studio.chapters}
              value={cardChapter}
              onChange={(e) => {
                setCardChapter(e.target.value);
                setCardPage(0);
              }}
            >
              <option value="">{t.studio.chapters}</option>
              {data.chapters.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.chapterNo} · {c.title}
                </option>
              ))}
            </Select>
          )}
          <Button disabled={cardPage === 0} onClick={() => setCardPage((p) => p - 1)}>
            ←
          </Button>
          <span>
            {cardPage + 1}/{Math.max(1, Math.ceil(matchingCards.length / 50))}
          </span>
          <Button
            disabled={(cardPage + 1) * 50 >= matchingCards.length}
            onClick={() => setCardPage((p) => p + 1)}
          >
            →
          </Button>
          {visibleCards.map((card, index, cards) => (
            <article key={card.id} className="mb-3 rounded-xl bg-paper-0 p-4 dark:bg-paper-900">
              <button
                className="font-serif text-lg"
                onClick={() => {
                  setBase(card);
                  const empty = blank(card.kind);
                  setEditing({ ...card, data: { ...empty.data, ...card.data } } as WritingCardData);
                }}
              >
                {cardTitle(card) || t.studio.unnamed}
              </button>
              <p className="text-xs text-ink-500">
                {card.confirmed ? t.studio.workbench.confirmed : t.studio.workbench.unconfirmed} ·{' '}
                {card.chapterId
                  ? data.chapters.find((c) => c.id === card.chapterId)?.chapterNo
                  : t.studio.workbench[card.kind]}
              </p>
              {card.kind === 'thread' && (
                <p className="my-2 text-xs">
                  {
                    t.studio.workbench[
                      data.threads.find((e) => e.threadId === card.id)?.kind ?? 'thread_planned'
                    ]
                  }
                </p>
              )}
              <div className="mt-2 flex flex-wrap gap-2">
                <Button
                  size="sm"
                  disabled={siblings(card)[0]?.id === card.id}
                  onClick={() => act(() => moveUp(card))}
                >
                  {t.studio.workbench.up}
                </Button>
                {card.kind === 'scene' && (
                  <>
                    <Button size="sm" onClick={() => act(() => splitScene(card))}>
                      {t.studio.workbench.split}
                    </Button>
                    <Button
                      size="sm"
                      disabled={!cards[index + 1] || cards[index + 1]!.chapterId !== card.chapterId}
                      onClick={() => act(() => mergeScenes(card, cards[index + 1]!))}
                    >
                      {t.studio.workbench.merge}
                    </Button>
                  </>
                )}
              </div>
            </article>
          ))}
        </section>
        <section>
          <h2 className="mb-3 font-sans text-xl">{t.studio.workbench.proposals}</h2>
          {data.proposals.filter(p => p.card.kind !== 'scene').map((p) => (
            <article className="mb-3 rounded-xl bg-paper-0 p-4 dark:bg-paper-900" key={p.id}>
              <p>
                {t.studio.workbench.affected} ·{' '}
                {p.chapterId ? data.chapters.find((c) => c.id === p.chapterId)?.chapterNo : '1–500'}
              </p>
              <h3>{cardTitle(p.card)}</h3>
              <dl>
                {Object.entries(p.card.data).map(([key, value]) => (
                  <div className="my-2" key={key}>
                    <dt className="text-xs text-ink-500">{label(key)}</dt>
                    {p.base && (
                      <dd className="line-through opacity-60">
                        {renderValue(
                          (
                            data.cards.find((c) => c.id === p.base!.id)?.data as unknown as Record<
                              string,
                              unknown
                            >
                          )?.[key],
                        )}
                      </dd>
                    )}
                    <dd className="whitespace-pre-wrap text-sm">{renderValue(value)}</dd>
                  </div>
                ))}
              </dl>
              <Button onClick={() => act(() => acceptPlanProposal(novel.id, p.id))}>
                {t.studio.workbench.accept}
              </Button>
              <Button onClick={() => act(() => discardProposal(p.id))}>{t.studio.workbench.discard}</Button>
            </article>
          ))}
        </section>
      </div>
      {!!data.imports.total && (
        <details className="mt-8">
          <summary>
            {t.studio.workbench.importedMaterials} ({data.imports.total})
          </summary>
          <Button disabled={importPage === 0} onClick={() => setImportPage((p) => p - 1)}>
            ←
          </Button>
          <span>
            {importPage + 1}/{Math.ceil(data.imports.total / 50)}
          </span>
          <Button
            disabled={(importPage + 1) * 50 >= data.imports.total}
            onClick={() => setImportPage((p) => p + 1)}
          >
            →
          </Button>
          {data.imports.entries.map((entry) => (
            <blockquote key={entry.id} className="my-3 border-l-2 border-paper-300 pl-3">
              <p>{entry.card.type === 'plan' ? cardTitle(entry.card.card) : entry.card.type === 'canon' ? entry.card.event.text : t.storyWorkspace.map}</p>
              <p className="text-xs text-ink-500">
                {t.studio.workbench.sources}: {entry.sourceVersionId} · {entry.card.id} → {entry.localId}
              </p>
              {entry.card.type === 'canon' && (
                <>
                  <p>「{entry.card.event.evidence.quote}」</p>
                  <p className="text-xs text-ink-500">
                    {entry.card.sourceVersionId} · {entry.card.event.evidence.from}–
                    {entry.card.event.evidence.to} · {entry.card.contentHash}
                  </p>
                </>
              )}
            </blockquote>
          ))}
        </details>
      )}
      <details className="mt-8">
        <summary>
          {t.studio.workbench.memory} ({data.memory.total})
        </summary>
        <Input
          aria-label={t.common.search}
          value={memoryQuery}
          onChange={(e) => {
            setMemoryPage(0);
            setMemoryQuery(e.target.value);
          }}
        />
        <Button disabled={memoryPage === 0} onClick={() => setMemoryPage((p) => p - 1)}>
          ←
        </Button>
        <span>
          {memoryPage + 1} / {Math.max(1, Math.ceil(data.memory.total / 50))}
        </span>
        <Button
          disabled={(memoryPage + 1) * 50 >= data.memory.total}
          onClick={() => setMemoryPage((p) => p + 1)}
        >
          →
        </Button>
        {data.memory.events.map((e) => (
          <blockquote key={e.id} className="my-3 border-l-2 border-tea-500 pl-3">
            {e.text}
            <p className="text-xs text-ink-500">
              {e.chapterNo} · {e.versionId} · {e.evidence.from}–{e.evidence.to}
            </p>
            <p>「{e.evidence.quote}」</p>
            <Button
              size="sm"
              onClick={() =>
                act(async () => {
                  const v = await getVersion(e.versionId);
                  setSourceText(v?.content ?? t.studio.chaptersTab.diffGone);
                })
              }
            >
              {t.studio.workbench.sources}
            </Button>
          </blockquote>
        ))}
      </details>
      {sourceText && (
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-xl bg-paper-0 p-4 dark:bg-paper-900">
          {sourceText}
        </pre>
      )}
      </fieldset>
    </div>
  );
}
