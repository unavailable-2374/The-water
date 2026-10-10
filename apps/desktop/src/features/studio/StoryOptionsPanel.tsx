import { useEffect, useRef, useState } from 'react';
import { nanoid } from 'nanoid';
import { canonicalJson, type StoryOptionBatch, type StoryOptionScope } from '@the-water/shared';
import { Button, Dialog, Field, Select, Textarea } from '@/components/ui';
import { ActivityStatus } from '@/components/Activity';
import { t } from '@/i18n';
import { useAsyncData } from '@/components/data/useAsyncData';
import { optionHistory, type OptionOwner } from '@/db/repos/storyOptionsRepo';
import { generateStoryOptions, resumeStoryOptions, retainStoryOption, selectStoryOption, generateStoryOptionPlan, storyOptionSource, combineStoryOptions } from '@/novel/storyOptions';
import { undoStoryOption } from '@/novel/storyOptionAdoption';
import { getNovel, type Novel } from '@/db/repos/novelsRepo';
import { listDocumentPlans } from '@/db/repos/planProposalsRepo';
import type { WizardInput } from '@/novel/service';
import type { StepProviderMap } from '@/jobs/purposes';
import { PlanReview } from './PlanReview';
import { docTypeGuide } from '@/novel/docTypes';
import { INDEPENDENT_OPTIONS_VERSION, storyOptionInputHash } from '@/novel/storyOptionInputs';
import { getDb } from '@/db/db';
import { optionQualityBlocked } from '@/novel/storyOptionQuality';

export function StoryOptionsButton({ novel, scope, onChanged, label }: { novel: Novel; scope: StoryOptionScope; onChanged?: () => void | Promise<void>; label?: string }) {
  const [open, setOpen] = useState(false);
  if (!docTypeGuide(novel.requirements.docType).fiction) return null;
  const title = scope.kind === 'work' ? t.storyOptions.outlineTitle : t.storyOptions.title;
  return <><Button onClick={() => setOpen(true)}>{label ?? `${title} · ${t.storyOptions[scope.kind]}`}</Button><Dialog open={open} onClose={() => setOpen(false)} title={title} width="max-w-5xl">{open && <StoryOptionsPanel key={`${novel.id}:${scope.kind}:${scope.id}`} owner={{ novelId: novel.id }} scope={scope} onChanged={onChanged} />}</Dialog></>;
}

export function StoryOptionsPanel({ owner, scope, draft, providerIds, autoGenerate = false, onSelected, onChanged, initialBatchId }: {
  owner: OptionOwner; scope: StoryOptionScope; draft?: WizardInput; providerIds?: StepProviderMap; autoGenerate?: boolean;
  onSelected?: (id: string) => void; onChanged?: () => void | Promise<void>; initialBatchId?: string;
}) {
  const [tick, setTick] = useState(0), [batchId, setBatchId] = useState(initialBatchId ?? ''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [mode, setMode] = useState<StoryOptionBatch['mode']>(scope.kind === 'work' ? 'restructure' : 'continue'), [amplitude, setAmplitude] = useState<StoryOptionBatch['amplitude']>('moderate'), [feedback, setFeedback] = useState(''), [authorMaterials, setAuthorMaterials] = useState(''), [combineIds, setCombineIds] = useState<string[]>([]);
  const lock = useRef(false), auto = useRef(false);
  const key = canonicalJson({ owner, scope, draft });
  const { data, error: loadError, reload } = useAsyncData(async () => {
    const history = await optionHistory(owner, scope);
    if (draft) { for (const h of history) h.stale = h.batch.dependencyHash !== await storyOptionInputHash(draft, String(h.batch.inputSnapshot.authorMaterials ?? '')); }
    const novel = owner.novelId ? await getNovel(owner.novelId) : null;
    const proposals = owner.novelId ? await listDocumentPlans(owner.novelId) : [];
    const decisions = owner.novelId ? await getDb().select<{ state: string }>("SELECT state FROM story_option_decisions WHERE novel_id=? AND scope_json=?", [owner.novelId, canonicalJson(scope)]) : [];
    return { history, novel, proposals, decisions, source: await storyOptionSource(owner, scope, draft) };
  }, { key: `options:${key}:${tick}` });
  const selected = data?.history.find(h => h.batch.id === batchId) ?? data?.history[0];
  const act = async (fn: () => Promise<unknown>) => {
    if (lock.current) return; lock.current = true; setBusy(true); setError('');
    try { await fn(); await onChanged?.(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { lock.current = false; setBusy(false); setTick(t => t + 1); }
  };
  const generate = (keep = false, requestKey = nanoid()) => act(async () => {
    const id = await generateStoryOptions({ owner, scope, draft, providerIds, mode: scope.kind === 'work' ? 'restructure' : mode, amplitude, feedback, authorMaterials, requestKey, previousBatchId: selected?.batch.id, keep }); setBatchId(id);
  });
  useEffect(() => {
    if (autoGenerate && data && !data.history.length && !auto.current) { auto.current = true; void generate(false, `initial:${data.source.hash}`); }
  }, [autoGenerate, data]);
  // Poll durable state while another page/assistant owns a live request.
  useEffect(() => { if (!busy && !data?.history.some(h => ['candidates','comparison'].includes(h.batch.state) || h.selections.some(s => s.state === 'planning'))) return; const timer = window.setInterval(() => setTick(t => t + 1), 1500); return () => window.clearInterval(timer); }, [data, busy]);
  useEffect(() => { if (selected) setAuthorMaterials(String(selected.batch.inputSnapshot?.authorMaterials ?? '')); }, [selected?.batch.id]);
  const combinationSources = Array.isArray(selected?.batch.inputSnapshot?.combinationSources) ? selected.batch.inputSnapshot.combinationSources as { id: string; title: string }[] : [];
  const isCombination = combinationSources.length > 0;
  useEffect(() => setCombineIds([]), [selected?.batch.id]);
  const boundary = selected?.batch.boundary ?? data?.source.boundary;
  const pending = data?.proposals.filter(p => selected?.selections.some(s => s.proposal_id === p.id)) ?? [];
  return <section className="min-w-0 space-y-4" aria-label={t.storyOptions.title}>
    <p className="text-sm text-ink-500">{scope.kind === 'work' ? t.storyOptions.outlineHint : t.storyOptions.hint}</p>
    <p className="text-sm">{t.storyOptions[scope.kind]}{data?.source.label ? ` · ${data.source.label}` : ''}</p>
    {owner.novelId && scope.kind !== 'work' && boundary && <p className="text-xs">{t.storyOptions.boundary}: {boundary ? `${boundary.chapterNo} · ${boundary.offset}` : t.storyOptions.emptyBoundary}<br />{t.storyOptions.savedOnly}</p>}
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {owner.novelId && scope.kind !== 'work' && <Field label={t.storyOptions.mode}><Select value={mode} onChange={e => setMode(e.target.value as typeof mode)}><option value="continue">{t.storyOptions.continue}</option><option value="restructure">{t.storyOptions.restructure}</option></Select></Field>}
      <Field label={t.storyOptions.amplitude}><Select value={amplitude} onChange={e => setAmplitude(e.target.value as typeof amplitude)}>{(['close','moderate','bold'] as const).map(a => <option value={a} key={a}>{t.storyOptions[a]}</option>)}</Select></Field>
    </div>
    <p className="text-sm text-ink-500">{t.storyOptions.independentHint}</p>
    <details className="text-sm"><summary className="cursor-pointer">{t.storyOptions.inputPreview}</summary><p className="whitespace-pre-wrap">{draft?.premise ?? data?.novel?.premise}</p><p className="whitespace-pre-wrap">{(['genre', 'style', 'pov', 'tense', 'tone', 'audience', 'taboos', 'mustHave', 'extra'] as const).flatMap(key => { const value = (draft ?? data?.novel)?.requirements[key]; return value && (typeof value === 'string' ? value.trim() : value.length) ? [`${t.studio.wizard[key]}: ${Array.isArray(value) ? value.join('、') : value}`] : []; }).join('\n')}</p></details>
    <Field label={t.storyOptions.authorMaterials}><Textarea rows={5} value={authorMaterials} onChange={e => setAuthorMaterials(e.target.value)} /></Field>
    <Field label={t.storyOptions.feedback}><Textarea rows={2} value={feedback} onChange={e => setFeedback(e.target.value)} /></Field>
    <div className="flex flex-wrap gap-2"><Button disabled={busy} onClick={() => void generate()}>{scope.kind === 'work' && !selected?.cards.every(option => option.outline) ? t.storyOptions.generateOutlines : selected ? t.storyOptions.redrawAll : t.storyOptions.generate}</Button>{selected && !isCombination && <Button disabled={busy || selected.stale || selected.batch.keptIds.length === 4} onClick={() => void generate(true)}>{t.storyOptions.redraw}</Button>}</div>
    {selected && !isCombination && <div className="space-y-2"><p className="text-sm text-ink-500">{t.storyOptions.combineHint}</p><Button disabled={busy || selected.batch.state !== 'ready' || combineIds.length < 2} onClick={() => void act(async () => { const id = await combineStoryOptions({ owner, batchId: selected.batch.id, optionIds: combineIds, feedback, authorMaterials, requestKey: nanoid(), draft, providerIds }); setBatchId(id); })}>{t.storyOptions.combine}</Button></div>}
    {isCombination && <p className="text-sm">{t.storyOptions.combinationSources}: {combinationSources.map(c => c.title).join('、')}</p>}
    {!!(error || loadError) && <p role="alert" className="whitespace-pre-wrap text-sm text-cinnabar-600">{error || String(loadError)}<Button onClick={reload}>{t.common.retry}</Button></p>}
    {busy && <ActivityStatus label={t.common.processing} />}
    {!!data?.history.length && <Field label={t.storyOptions.history}><Select value={selected?.batch.id ?? ''} onChange={e => { setBatchId(e.target.value); const h = data.history.find(h => h.batch.id === e.target.value); if(h) { setMode(h.batch.mode); setAmplitude(h.batch.amplitude); } }}>{data.history.map((h, i) => <option key={h.batch.id} value={h.batch.id}>{data.history.length - i} · {new Date(h.batch.createdAt).toLocaleString()} · {t.storyOptions[h.batch.mode]}</option>)}</Select></Field>}
    {selected && selected.batch.inputSnapshot?.sourceVersion !== INDEPENDENT_OPTIONS_VERSION && <p role="status" className="text-amber-700">{t.storyOptions.legacyInputs}</p>}
    {selected?.stale && <p role="status" className="text-amber-700">{t.storyOptions.stale}</p>}
    {data?.decisions.some(d => d.state === 'review') && <p role="status">{t.storyOptions.review}</p>}
    {selected && selected.batch.state !== 'ready' && <div><p>{t.storyOptions.incomplete}</p>{selected.batch.error && <p role="alert">{selected.batch.error}</p>}{!(selected.batch.comparison && (optionQualityBlocked(selected.batch.comparison) || selected.batch.comparison.differences?.some(pair => pair.judgment !== 'substantive'))) && <Button disabled={busy} onClick={() => void act(() => resumeStoryOptions(owner, selected.batch.id))}>{t.storyOptions.retry}</Button>}</div>}
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      {selected?.cards.map(option => {
        const comparison = selected.batch.comparison?.options.find(c => c.optionId === option.id), selection = selected.selections.find(s => s.option_id === option.id);
        return <article key={option.id} className="min-w-0 rounded-xl border border-paper-300 p-4 dark:border-paper-700">
          <h3 className="font-semibold">{option.title}</h3><p className="my-2 whitespace-pre-wrap">{option.mainline}</p>
          {scope.kind === 'work' && <div className="my-3 space-y-2 text-sm"><strong>{t.storyOptions.outline}</strong>{option.outline ? option.outline.map((paragraph, i) => <p className="whitespace-pre-wrap" key={i}>{paragraph}</p>) : <p role="status" className="text-amber-700">{t.storyOptions.legacyOutline}</p>}</div>}
          {option.design && <dl className="my-2 text-sm">{(['causalSpine', 'decisiveChoice', 'resolutionMechanism'] as const).map(key => <div className="mt-2" key={key}><dt className="text-ink-500">{t.storyOptions.designLabels[key]}</dt><dd className="whitespace-pre-wrap">{option.design![key]}</dd></div>)}</dl>}
          <details><summary className="cursor-pointer">{t.storyOptions.details}</summary><dl>{(['conflict','choiceAndCost','growth','turns','ending','aftermath'] as const).map(k => <div className="mt-2" key={k}><dt className="text-xs text-ink-500">{t.storyOptions[k]}</dt><dd className="whitespace-pre-wrap text-sm">{Array.isArray(option[k]) ? option[k].join('\n') : option[k]}</dd></div>)}</dl></details>
          {comparison && <div className="mt-3 space-y-2 text-sm"><strong>{t.storyOptions.comparison}</strong>{(['conflict','character','turns','emotion','ending','tradeoff'] as const).map(k => <p key={k}><span className="text-ink-500">{t.storyOptions[k]}: </span>{comparison[k]}</p>)}{comparison.checks && <details><summary>{t.storyOptions.checks}</summary>{Object.entries(comparison.checks).map(([key, value]) => <p key={key}>{t.storyOptions.checkLabels[key as keyof typeof t.storyOptions.checkLabels]}：{value}</p>)}</details>}{comparison.qualityAudit && <details><summary>{t.storyOptions.audit}</summary>{comparison.qualityAudit.map(a => <div key={a.checkpoint} className="mt-2"><strong>{t.storyOptions.auditLabels[a.checkpoint]} · {t.storyOptions.auditStatuses[a.status]}</strong><p>{a.explanation}</p>{a.evidence.map((e, i) => <p key={i}>“{e.quote}”</p>)}</div>)}</details>}{comparison.concerns.map((v, i) => <p className="text-ink-500" key={`concern:${i}`}>{t.storyOptions.concerns}: {v}</p>)}{comparison.violations.map((v, i) => <p role="alert" key={i}>{v}</p>)}{comparison.requiresWiderScope && <p role="alert">{t.storyOptions.broader}</p>}</div>}
          {!isCombination && <label className="my-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={selected.batch.keptIds.includes(option.id)} disabled={busy} onChange={e => void act(() => retainStoryOption(owner, selected.batch.id, option.id, e.target.checked))} />{t.storyOptions.retain}</label>}
          {!isCombination && <label className="my-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={combineIds.includes(option.id)} disabled={busy || selected.batch.state !== 'ready'} onChange={e => setCombineIds(ids => e.target.checked ? [...ids, option.id] : ids.filter(id => id !== option.id))} />{t.storyOptions.combineCard}</label>}
          <Button disabled={busy || selected.stale || selected.batch.state !== 'ready' || !comparison || !!comparison.violations.length || comparison.requiresWiderScope || !!selection && !['selected','failed'].includes(selection.state)} onClick={() => void act(async () => { const id = await selectStoryOption(owner, selected.batch.id, option.id, draft); onSelected?.(id); })}>{selection ? t.storyOptions.selected : scope.kind === 'work' ? t.storyOptions.chooseOutline : t.storyOptions.choose}</Button>
          {selection?.error && <p role="alert">{selection.error}</p>}
          {owner.novelId && selection && ['selected','failed'].includes(selection.state) && <Button disabled={busy || selected.stale} onClick={() => void act(() => generateStoryOptionPlan(owner.novelId!, selection.id))}>{t.storyOptions.planRetry}</Button>}
          {selection?.state === 'pending' && <p>{scope.kind === 'work' && option.outline ? t.storyOptions.pendingOutline : t.storyOptions.pending}</p>}
          {owner.novelId && selection?.state === 'accepted' && <Button disabled={busy} onClick={() => void act(() => undoStoryOption(owner.novelId!, selection.id))}>{t.storyOptions.undo}</Button>}
        </article>;
      })}
    </div>
    {!!selected?.batch.comparison?.differences?.length && <details className="text-sm"><summary className="cursor-pointer">{t.storyOptions.pairwise}</summary>{selected.batch.comparison.differences.map((pair, i) => <div className="mt-3 space-y-1" key={i}><strong>{selected.cards.find(c => c.id === pair.leftId)?.title} / {selected.cards.find(c => c.id === pair.rightId)?.title} · {t.storyOptions.differenceJudgments[pair.judgment]}</strong>{pair.axes.map(axis => <p key={axis.axis}>{t.storyOptions.designLabels[axis.axis]}：“{axis.leftQuote}” / “{axis.rightQuote}”。{axis.explanation}</p>)}</div>)}</details>}
    {selected?.batch.comparison && <p className="text-sm">{selected.batch.comparison.summary}</p>}
    {data?.novel && pending.length > 0 && <PlanReview key={pending.map(p => p.id).join(',')} novel={data.novel} documents={pending} onResolved={async () => { setTick(t => t + 1); await onChanged?.(); }} />}
  </section>;
}
