import { getSetting, setSetting } from '@/db/repos/settingsRepo';
import { WizardDraftSchema, upgradeWizardDraft, WIZARD_DRAFT_KEY } from '@/novel/wizardDraft';
import { nanoid } from 'nanoid';
import { StoryOptionsPanel } from '../StoryOptionsPanel';
import { docTypeGuide } from '@/novel/docTypes';
import { ActivityStatus } from '@/components/Activity';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { Check, Sparkles } from 'lucide-react';
import { fmt, t } from '@/i18n';
import { Button, Card, Field, Input, Select, Textarea, cn } from '@/components/ui';
import { useAsyncData } from '@/components/data/useAsyncData';
import { toast } from '@/components/Toast';
import { useSettings } from '@/stores/settingsStore';
import { defaultRequirements, type NovelRequirements } from '@/novel/types';
import { planChapterCount } from '@/novel/wordBudget';
import { createNovelFromWizard } from '@/novel/service';
import { estimateGeneration, estimatePlanning, planningCallCount } from '@/novel/pricing';
import type { StepProviderMap } from '@/jobs/purposes';
import { CostEstimateLine, previewCost, type CostPreview } from '../UsagePanel';
import { ModelPurposePicker } from '../ModelPicker';
import { DOC_TYPES, DOC_TYPE_IDS } from '@/novel/docTypes';
import { presetsForGenre } from '@/novel/stylePresets';
import { GENRE_PACKS, isEmptyGenre, mergedGenreOf, orderPresetsByGenre, packIdsForGenre } from '@/novel/genrePacks';

import { suggestWizardRequirements } from '@/novel/suggestWizardRequirements';
import { applyWizardSuggestion, wizardSourceKey, WIZARD_GENRES, WIZARD_POVS, type SuggestedField } from '@/novel/wizardSuggestions';

/**
 * 题材与视角是**会写进数据库、并原样进 AI 提示词**的取值，不是纯展示文案，
 * 所以留在这里，不进 i18n 词典（翻译它们会改掉已存的书的设定）。
 */
const GENRES = WIZARD_GENRES;
const POVS = WIZARD_POVS;

export function CreateWizard() {
  const nav = useNavigate();
  const providers = useSettings((s) => s.providers);
  const [step, setStep] = useState(0);
  const [draftId, setDraftId] = useState(() => nanoid());
  const [storySelectionId, setStorySelectionId] = useState<string | null>(null);
  const [storySkipped, setStorySkipped] = useState(false);
  const scrollContainer = useRef<HTMLDivElement>(null);
  useEffect(() => { scrollContainer.current?.scrollTo({ top: 0 }); }, [step]);
  const [title, setTitle] = useState('');
  const [premise, setPremise] = useState('');
  const [target, setTarget] = useState(30000);
  const [targetInput, setTargetInput] = useState('30000');
  const [req, setReq] = useState<NovelRequirements>(defaultRequirements());
  const [presetId, setPresetId] = useState<string>('');
  const presetRef = useRef(presetId);
  presetRef.current = presetId;
  const edited = useRef(new Set<SuggestedField>());
  const request = useRef<AbortController | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestionError, setSuggestionError] = useState('');
  const [suggestionReason, setSuggestionReason] = useState('');
  const suggestedSource = useRef('');
  useEffect(() => () => request.current?.abort(), []);
  const genre = mergedGenreOf(req);
  const presets = orderPresetsByGenre(presetsForGenre(req.genre), genre);
  const preset = presets.find((p) => p.id === presetId) ?? null;
  const [busy, setBusy] = useState(false);
  const [providerIds, setProviderIds] = useState<StepProviderMap>({});
  const [draftError, setDraftError] = useState('');
  const [draftLoaded, setDraftLoaded] = useState(false);
  const draftWrites = useRef(Promise.resolve());
  useEffect(() => {
    let active = true;
    void getSetting<unknown>(WIZARD_DRAFT_KEY, null).then(raw => {
      if (!active) return;
      if (raw !== null) {
        const parsed = WizardDraftSchema.safeParse(raw);
        if (!parsed.success) { setDraftError(t.studio.wizard.draftInvalid); return; }
        const draft = upgradeWizardDraft(parsed.data);
        setDraftId(draft.draftId); setStorySelectionId(draft.storySelectionId); setStorySkipped(draft.storySkipped);
        setTitle(draft.title); setPremise(draft.premise); setTarget(draft.target); setTargetInput(String(draft.target));
        setReq(draft.requirements); setPresetId(draft.presetId); setStep(draft.step); setProviderIds(draft.providerIds);
        edited.current = new Set(draft.edited); suggestedSource.current = draft.suggestedSource; setSuggestionReason(draft.suggestionReason);
      }
      setDraftLoaded(true);
    }).catch(error => { if (active) setDraftError(String(error)); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!draftLoaded || busy) return;
    const draft = { version: 2, draftId, storySelectionId, storySkipped, title, premise, target, requirements: req, presetId, step, providerIds,
      edited: [...edited.current].filter(field => ['genre', 'pov', 'presetId', 'style', 'tone', 'audience', 'tense', 'genrePackIds'].includes(field)),
      suggestedSource: suggestedSource.current, suggestionReason };
    draftWrites.current = draftWrites.current.then(() => setSetting(WIZARD_DRAFT_KEY, draft)).catch(error => { toast.error(String(error)); });
  }, [draftLoaded, busy, title, premise, target, req, presetId, step, providerIds, suggestionReason, draftId, storySelectionId, storySkipped]);
  const selectedInput = useRef<string | null>(null);
  useEffect(() => {
    if (!draftLoaded) return;
    const current = JSON.stringify({ title, premise, target, req, presetId });
    if (selectedInput.current !== null && selectedInput.current !== current) {
      setStorySelectionId(null); setStorySkipped(false);
    }
    selectedInput.current = current;
  }, [draftLoaded, title, premise, target, req, presetId]);

  const set = <K extends keyof NovelRequirements>(k: K, v: NovelRequirements[K]) => {
    edited.current.add(k as SuggestedField);
    setReq((r) => ({ ...r, [k]: v }));
  };
  // 选题材时自动带出对应的题材包，之后用户仍可自由增删（科幻 + 悬疑这类组合就是这么来的）。
  const setGenre = (g: string) => { edited.current.add('genre'); edited.current.add('genrePackIds'); setReq((r) => ({ ...r, genre: g, genrePackIds: packIdsForGenre(g) })); };
  const togglePack = (id: string) => {
    edited.current.add('genrePackIds');
    setReq((r) => ({ ...r, genrePackIds: r.genrePackIds.includes(id) ? r.genrePackIds.filter((x) => x !== id) : [...r.genrePackIds, id] }));
  };
  const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);

  const minimumTarget = req.docType === 'short-story' ? 1000 : 10000;
  const chapters = planChapterCount(target,{docType:req.docType});

  // 第三步「模型与确认」：模型一换，预估费用就跟着重算（§2.1 第 2、3 条）。
  const { data: cost } = useAsyncData<CostPreview>(async () => {
    const per = Math.round(target / chapters);
    const gen = estimateGeneration(Array.from({ length: chapters }, () => ({ targetChars: per })), { styleCheck: !!preset });
    const plan = estimatePlanning(chapters);
    const planningCalls = planningCallCount(chapters);
    return previewCost({ ...gen, auxiliary: { inputTokens: gen.auxiliary.inputTokens + plan.inputTokens, outputTokens: gen.auxiliary.outputTokens + plan.outputTokens },byPurpose:{...gen.byPurpose,planning:{inputTokens:(gen.byPurpose?.planning?.inputTokens ?? 0)+plan.inputTokens,outputTokens:(gen.byPurpose?.planning?.outputTokens ?? 0)+plan.outputTokens}},calls:{...gen.calls,planning:(gen.calls?.planning ?? 0)+planningCalls},minimumCalls:(gen.minimumCalls ?? 0)+planningCalls,maximumCalls:(gen.maximumCalls ?? 0)+planningCalls }, providerIds);
  }, { key: `wizardCost:${target}:${chapters}:${presetId}:${JSON.stringify(providerIds)}`, enabled: step === 1 || step === 3 });

  const suggest = async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setSuggesting(true); setSuggestionError(''); setSuggestionReason('');
    const source = { title, premise, requirements: req, targetChars: target };
    try {
      const suggestion = await suggestWizardRequirements(source, providerIds, controller.signal);
      if (controller.signal.aborted || request.current !== controller) return;
      const protectedFields = new Set(edited.current);
      setReq(current => applyWizardSuggestion(current, presetRef.current, suggestion, protectedFields).requirements);
      if (!protectedFields.has('presetId')) setPresetId(suggestion.presetId);
      suggestedSource.current = wizardSourceKey(source);
      setSuggestionReason(suggestion.reason);
    } catch (error) {
      if (!controller.signal.aborted) setSuggestionError(error instanceof Error ? error.message : String(error));
    } finally {
      if (request.current === controller) { request.current = null; setSuggesting(false); }
    }
  };
  const next = () => {
    if (step === 0) {
      if (!premise.trim()) { toast.error(t.studio.wizard.needPremise); return; }
      setStep(1);
      if (suggestedSource.current !== wizardSourceKey({ title, premise, requirements: req, targetChars: target })) void suggest();
    } else if (step === 1) { if (!docTypeGuide(req.docType).fiction) { setStorySkipped(true); setStep(3); } else setStep(2); }
    else setStep(3);
  };
  const back = () => {
    request.current?.abort(); request.current = null; setSuggesting(false);
    if (step === 0) nav('/library?tab=novels');
    else if (step === 3 && !docTypeGuide(req.docType).fiction) setStep(1);
    else setStep(step - 1);
  };

  const create = async () => {
    if (!premise.trim()) { toast.error(t.studio.wizard.needPremise); setStep(0); return; }
    setBusy(true);
    try {
      await useSettings.getState().refreshProviders();
      if (useSettings.getState().providers.length === 0) throw new Error(useSettings.getState().providerError || t.chat.noProvider);
      await draftWrites.current;
      const novel = await createNovelFromWizard({ title, premise, requirements: req, targetChars: target, styleProfile: preset }, { draftId, selectionId: storySkipped ? null : storySelectionId, providerIds });
      nav(`/studio/${novel.id}/plan${!storySkipped && storySelectionId ? `?direction=${storySelectionId}` : '?auto=1'}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const steps = [t.studio.wizard.step1, t.storyOptions.parameters, t.storyOptions.title, t.storyOptions.confirm];
  const intros = [t.studio.wizard.intro1, t.studio.wizard.intro2, t.storyOptions.hint, t.storyOptions.confirmHint];
  const wan = (target / 10000).toLocaleString(undefined, { maximumFractionDigits: 1 });
  const lengthSummary = fmt(t.studio.wizard.lengthSummary, { wan, chapters });
  if (draftError) return <p role="alert" className="p-8">{draftError}</p>;
  if (!draftLoaded) return <ActivityStatus label={t.common.processing} />;
  return (
    <div ref={scrollContainer} className="h-full overflow-y-auto bg-paper-50 dark:bg-paper-950">
      <div className="mx-auto max-w-2xl px-8 py-12">
        <h1 className="font-sans text-3xl font-semibold tracking-tight">{t.studio.wizard.title}</h1>
        <p className="mt-2 text-sm leading-relaxed text-ink-500">{t.studio.wizard.desc}</p>
        <p className="mt-2 text-xs text-ink-400">{t.studio.wizard.draftHint}</p>

        <ol aria-label={t.studio.wizard.steps} className="mt-8 mb-6 flex flex-wrap gap-y-3 items-center">
          {steps.map((s, i) => (
            <li key={s} aria-current={i === step ? 'step' : undefined} className={cn('flex items-center', i < steps.length - 1 && 'flex-1')}>
              <span className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm transition', i < step ? 'bg-tea-600 text-paper-0' : i === step ? 'bg-accent-600 text-white shadow-soft' : 'bg-paper-200 text-ink-400 dark:bg-paper-800')} aria-hidden="true">
                {i < step ? <Check size={14} strokeWidth={2} /> : i + 1}
              </span>
              <span className={cn('ml-2 whitespace-nowrap text-sm', i === step ? 'font-medium text-ink-900 dark:text-paper-100' : 'text-ink-400')}>{s}</span>
              {i < steps.length - 1 && <span className={cn('mx-4 h-px flex-1', i < step ? 'bg-tea-500/70' : 'bg-paper-300 dark:bg-paper-800')} aria-hidden="true" />}
            </li>
          ))}
        </ol>

        <Card className="p-7">
          <h2 className="font-sans text-xl font-semibold tracking-tight">{steps[step]}</h2>
          {step !== 2 && <p className="mt-1 mb-6 text-sm text-ink-500">{intros[step]}</p>}

          {step === 1 && (
            <div className="space-y-5">
              <div className="rounded-xl bg-paper-100 p-4 dark:bg-paper-800" aria-live="polite">
                <p className="text-sm text-ink-500">{t.studio.wizard.suggestionHint}</p>
                {suggesting && <ActivityStatus label={t.studio.wizard.suggesting} />}
                {suggestionReason && <p className="mt-2 text-sm">{suggestionReason}</p>}
                {suggestionError && <p role="alert" className="mt-2 text-sm text-cinnabar-600">{suggestionError}</p>}
                <Button className="mt-3" onClick={() => void suggest()} disabled={suggesting}>{t.studio.wizard.suggestAgain}</Button>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <Field label={t.studio.wizard.genre}>
                  <Select value={req.genre} onChange={(e) => setGenre(e.target.value)}>
                    <option value="">{t.studio.wizard.genrePlaceholder}</option>
                    {GENRES.map((g) => <option key={g} value={g}>{g}</option>)}
                  </Select>
                </Field>
                <Field label={t.studio.wizard.pov}>
                  <Select value={req.pov} onChange={(e) => set('pov', e.target.value)}>{POVS.map((p) => <option key={p} value={p}>{p}</option>)}</Select>
                </Field>
                <Field label={t.studio.wizard.stylePreset}>
                  <Select value={presetId} onChange={(e) => { edited.current.add('presetId'); setPresetId(e.target.value); }}>
                    <option value="">{t.studio.wizard.stylePresetNone}</option>
                    {presets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </Select>
                </Field>
                <Field label={t.studio.wizard.style} hint={t.studio.wizard.styleHint}><Input value={req.style} onChange={(e) => set('style', e.target.value)} placeholder={t.studio.wizard.stylePlaceholder} /></Field>
                <Field label={t.studio.wizard.tone}><Input value={req.tone} onChange={(e) => set('tone', e.target.value)} placeholder={t.studio.wizard.tonePlaceholder} /></Field>
                <Field label={t.studio.wizard.audience}><Input value={req.audience} onChange={(e) => set('audience', e.target.value)} placeholder={t.studio.wizard.audiencePlaceholder} /></Field>
                <Field label={t.studio.wizard.tense}><Input value={req.tense} onChange={(e) => set('tense', e.target.value)} /></Field>
              </div>
              <Field label={t.studio.wizard.genrePacks} hint={t.studio.wizard.genrePacksHint}>
                <div className="flex flex-wrap gap-2">
                  {GENRE_PACKS.map((p) => {
                    const on = req.genrePackIds.includes(p.id);
                    return (
                      <button
                        key={p.id}
                        type="button"
                        title={p.summary}
                        aria-pressed={on}
                        onClick={() => togglePack(p.id)}
                        className={cn('rounded-full border px-3 py-1 text-xs transition focus:outline-none focus-visible:ring-2 focus-visible:ring-tea-500/50', on ? 'border-cinnabar-500 bg-cinnabar-50 text-cinnabar-700 dark:border-cinnabar-500 dark:bg-cinnabar-900/30 dark:text-cinnabar-100' : 'border-paper-300 text-ink-500 hover:border-ink-300 dark:border-paper-700')}
                      >
                        {p.label}
                      </button>
                    );
                  })}
                </div>
              </Field>
              {!isEmptyGenre(genre) && (
                <ul className="space-y-0.5 rounded-xl bg-paper-100 px-4 py-3 text-xs leading-relaxed text-ink-500 dark:bg-paper-800">
                  {genre.entries.slice(0, 3).map((e) => <li key={e.id}>· {e.name}：{e.description.slice(0, 46)}{e.description.length > 46 ? '…' : ''}</li>)}
                  {genre.forbiddenWords.length > 0 && <li>{fmt(t.studio.wizard.genreForbidden, { n: genre.forbiddenWords.length })}</li>}
                  {genre.conflicts.map((c) => <li key={c} className="text-amber-700 dark:text-amber-300">· {c}</li>)}
                </ul>
              )}
              {preset && preset.injection.humanReadableConstraints.length > 0 && (
                <ul className="space-y-0.5 rounded-xl bg-paper-100 px-4 py-3 text-xs leading-relaxed text-ink-500 dark:bg-paper-800">
                  {preset.injection.humanReadableConstraints.slice(0, 3).map((c) => <li key={c}>· {c}</li>)}
                </ul>
              )}
              <ModelPurposePicker value={providerIds} onChange={setProviderIds} />
              <CostEstimateLine preview={cost ?? null} prefix={t.studio.wizard.costPrefix} />
            </div>
          )}
          {step === 0 && (
            <div className="space-y-5">
              <Field label={t.studio.wizard.docType} hint={DOC_TYPES[(req.docType || 'long-webnovel') as keyof typeof DOC_TYPES]?.framework}>
                <Select value={req.docType} onChange={(e) => {
                  const docType=e.target.value; set('docType',docType);
                  const next=Math.max(docType==='short-story' ? 1000 : 10000,target);
                  setTarget(next); setTargetInput(String(next));
                }}>
                  {DOC_TYPE_IDS.map((id) => <option key={id} value={id}>{DOC_TYPES[id].label}</option>)}
                </Select>
              </Field>
              <Field label={t.studio.wizard.novelTitle} hint={t.studio.wizard.novelTitleHint}><Input className="font-serif" value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
              {docTypeGuide(req.docType).fiction && <Field label={t.studio.development.structureMethod}><Input list="story-structure-methods" value={req.structureMethod ?? ''} onChange={e=>set('structureMethod',e.target.value)}/><datalist id="story-structure-methods">{t.studio.development.structureChoices.split(' / ').map(value=><option key={value} value={value}/>)}</datalist></Field>}
              <Field label={t.studio.wizard.premise} hint={t.studio.wizard.premiseHint}><Textarea rows={12} className="font-serif leading-[1.8]" value={premise} onChange={(e) => setPremise(e.target.value)} placeholder={t.studio.wizard.premisePlaceholder} /></Field>
              <Field label={t.studio.wizard.extra}><Textarea rows={3} value={req.extra} onChange={(e) => set('extra', e.target.value)} placeholder={t.studio.wizard.extraPlaceholder} /></Field>
              <div className="rounded-2xl bg-paper-100 p-5 dark:bg-paper-800">
                <div className="flex items-baseline justify-between gap-4">
                  <span className="text-xs font-medium tracking-wide text-ink-600 dark:text-ink-300">{t.studio.wizard.targetChars}</span>
                  <span className="font-serif text-2xl tracking-wide text-ink-900 dark:text-paper-100">{lengthSummary}</span>
                </div>
                <Input type="number" aria-label={t.studio.wizard.targetChars} min={minimumTarget} max={300000} step={1000} value={targetInput} onChange={(e) => {
                  setTargetInput(e.target.value);
                  const value = Number(e.target.value);
                  if (Number.isFinite(value) && value >= minimumTarget && value <= 300000) setTarget(Math.round(value));
                }} onBlur={() => {
                  const value=Number(targetInput);
                  const next=Number.isFinite(value) ? Math.min(300000,Math.max(minimumTarget,Math.round(value))) : target;
                  setTarget(next); setTargetInput(String(next));
                }} className="mt-3" />
                <input type="range" aria-label={t.studio.wizard.targetChars} min={minimumTarget} max={300000} step={1000} value={target} onChange={(e) => {const value=Number(e.target.value);setTarget(value);setTargetInput(String(value));}} className="mt-4 w-full" />
                <p className="mt-2 text-xs text-ink-400">{fmt(t.studio.wizard.estimate, { n: chapters, per: Math.round(target / chapters) })}</p>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <Field label={t.studio.wizard.taboos}><Textarea rows={3} value={req.taboos.join('\n')} onChange={(e) => set('taboos', lines(e.target.value))} /></Field>
                <Field label={t.studio.wizard.mustHave}><Textarea rows={3} value={req.mustHave.join('\n')} onChange={(e) => set('mustHave', lines(e.target.value))} /></Field>
              </div>
            </div>
          )}
          {step === 2 && <><StoryOptionsPanel owner={{ draftId }} scope={{ kind: 'work', id: draftId }} draft={{ title, premise, requirements: req, targetChars: target, styleProfile: preset }} providerIds={providerIds} autoGenerate onSelected={id => { setStorySelectionId(id); setStorySkipped(false); }} /><Button className="mt-4" onClick={() => { setStorySkipped(true); setStorySelectionId(null); setStep(3); }}>{t.storyOptions.skip}</Button></>}
          {step === 3 && (
            <div className="space-y-5 text-sm">
              <dl className="grid grid-cols-[6rem_1fr] gap-y-2.5 rounded-2xl bg-paper-100 p-5 dark:bg-paper-800">
                <dt className="text-ink-500">{t.studio.wizard.novelTitle}</dt><dd className="font-serif text-ink-900 dark:text-paper-100">{title || t.studio.wizard.summaryTitleAuto}</dd>
                <dt className="text-ink-500">{t.studio.wizard.docType}</dt><dd className="text-ink-800 dark:text-paper-100">{DOC_TYPES[(req.docType || 'long-webnovel') as keyof typeof DOC_TYPES]?.label ?? req.docType}</dd>
                <dt className="text-ink-500">{t.studio.wizard.summaryGenrePacks}</dt><dd className="text-ink-800 dark:text-paper-100">{genre.labels.join(' + ') || t.studio.wizard.summaryPacksNone}</dd>
                <dt className="text-ink-500">{t.studio.wizard.summaryGenreStyle}</dt><dd className="text-ink-800 dark:text-paper-100">{[req.genre, preset?.name, req.style, req.tone].filter(Boolean).join(' · ') || t.studio.wizard.summaryNone}</dd>
                <dt className="text-ink-500">{t.studio.wizard.summaryPov}</dt><dd className="text-ink-800 dark:text-paper-100">{req.pov}</dd>
                <dt className="text-ink-500">{t.studio.wizard.audience}</dt><dd className="text-ink-800 dark:text-paper-100">{req.audience || t.studio.wizard.summaryNone}</dd>
                <dt className="text-ink-500">{t.studio.wizard.tense}</dt><dd className="text-ink-800 dark:text-paper-100">{req.tense}</dd>
                <dt className="text-ink-500">{t.studio.wizard.summaryLength}</dt><dd className="font-serif text-ink-800 dark:text-paper-100">{lengthSummary}</dd>
                <dt className="text-ink-500">{t.studio.wizard.summaryTaboos}</dt><dd className="text-ink-800 dark:text-paper-100">{req.taboos.join('、') || t.studio.wizard.summaryNone}</dd>
              </dl>
              <p>{storySelectionId && !storySkipped ? t.storyOptions.draftSelected : t.storyOptions.skip}</p>
              <div>
                <h3 className="mb-1 font-sans text-sm tracking-tight text-ink-700 dark:text-ink-200">{t.studio.wizard.models}</h3>
                <p className="mb-4 text-xs text-ink-400">{t.studio.wizard.modelsHint}</p>
                <ModelPurposePicker value={providerIds} onChange={setProviderIds} />
              </div>
              <div className="rounded-2xl bg-paper-100 p-5 dark:bg-paper-800">
                <div className="mb-1 text-xs font-medium tracking-wide text-ink-600 dark:text-ink-300">{t.studio.wizard.costTitle}</div>
                <CostEstimateLine preview={cost ?? null} prefix={t.studio.wizard.costPrefix} />
              </div>
              <p className="leading-relaxed text-ink-500">
                {providers.length ? t.studio.wizard.ready : t.chat.noProvider}
              </p>
            </div>
          )}

          <div className="mt-8 flex items-center justify-between">
            <Button variant="ghost" onClick={back}>{step === 0 ? t.common.cancel : t.studio.wizard.prev}</Button>
            {step < 3
              ? <Button variant="primary" onClick={next} disabled={suggesting || step === 2 && !storySelectionId && !storySkipped}>{t.studio.wizard.next}</Button>
              : <Button variant="ai" size="lg" onClick={create} disabled={busy || !storySelectionId && !storySkipped}>{busy ? <ActivityStatus label={t.common.processing} /> : <><Sparkles size={16} strokeWidth={1.75} aria-hidden="true" />{t.studio.wizard.submit}</>}</Button>}
          </div>
        </Card>
      </div>
    </div>
  );
}
