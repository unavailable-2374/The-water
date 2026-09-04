import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { Check, Sparkles } from 'lucide-react';
import { fmt, t } from '@/i18n/zh';
import { Button, Card, Field, Input, Select, Textarea, cn } from '@/components/ui';
import { toast } from '@/components/Toast';
import { useSettings } from '@/stores/settingsStore';
import { defaultRequirements, type NovelRequirements } from '@/novel/types';
import { planChapterCount } from '@/novel/wordBudget';
import { createNovelFromWizard, setNovelProviders } from '@/novel/service';
import { estimateGeneration, estimatePlanning } from '@/novel/pricing';
import type { StepProviderMap } from '@/jobs/purposes';
import { CostEstimateLine, previewCost, type CostPreview } from '../UsagePanel';
import { ModelPurposePicker } from '../ModelPicker';
import { DOC_TYPES, DOC_TYPE_IDS } from '@/novel/docTypes';
import { presetsForGenre } from '@/novel/stylePresets';
import { GENRE_PACKS, isEmptyGenre, mergedGenreOf, orderPresetsByGenre, packIdsForGenre } from '@/novel/genrePacks';

const GENRES = ['都市', '玄幻', '仙侠', '科幻', '悬疑', '历史', '言情', '武侠', '奇幻', '现实', '其他'];
const POVS = ['第三人称有限', '第一人称', '第三人称全知'];
const NUMERALS = ['一', '二', '三'];
const STEP_INTRO = ['先定下题材、视角和篇幅。', '你想看一个什么样的故事？', '挑好模型、看一眼预算，然后交给 AI。'];

export function CreateWizard() {
  const nav = useNavigate();
  const providers = useSettings((s) => s.providers);
  const [step, setStep] = useState(0);
  const [title, setTitle] = useState('');
  const [premise, setPremise] = useState('');
  const [target, setTarget] = useState(30000);
  const [req, setReq] = useState<NovelRequirements>(defaultRequirements());
  const [presetId, setPresetId] = useState<string>('');
  const genre = mergedGenreOf(req);
  const presets = orderPresetsByGenre(presetsForGenre(req.genre), genre);
  const preset = presets.find((p) => p.id === presetId) ?? null;
  const [busy, setBusy] = useState(false);
  const [providerIds, setProviderIds] = useState<StepProviderMap>({});
  const [cost, setCost] = useState<CostPreview | null>(null);
  const set = <K extends keyof NovelRequirements>(k: K, v: NovelRequirements[K]) => setReq((r) => ({ ...r, [k]: v }));
  // 选题材时自动带出对应的题材包，之后用户仍可自由增删（科幻 + 悬疑这类组合就是这么来的）。
  const setGenre = (g: string) => setReq((r) => ({ ...r, genre: g, genrePackIds: packIdsForGenre(g) }));
  const togglePack = (id: string) =>
    setReq((r) => ({ ...r, genrePackIds: r.genrePackIds.includes(id) ? r.genrePackIds.filter((x) => x !== id) : [...r.genrePackIds, id] }));
  const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);

  const chapters = planChapterCount(target);

  // 第三步「模型与确认」：模型一换，预估费用就跟着重算（§2.1 第 2、3 条）。
  useEffect(() => {
    if (step !== 2) return;
    void (async () => {
      const per = Math.round(target / chapters);
      const gen = estimateGeneration(Array.from({ length: chapters }, () => ({ targetChars: per })), { styleCheck: !!preset });
      const plan = estimatePlanning(chapters);
      setCost(await previewCost({ writing: gen.writing, auxiliary: { inputTokens: gen.auxiliary.inputTokens + plan.inputTokens, outputTokens: gen.auxiliary.outputTokens + plan.outputTokens } }, providerIds));
    })();
  }, [step, target, chapters, providerIds, presetId]);

  const create = async () => {
    if (!premise.trim()) { toast.error('先写几句故事的设想吧'); setStep(1); return; }
    if (providers.length === 0) { toast.error(t.chat.noProvider); return; }
    setBusy(true);
    try {
      const novel = await createNovelFromWizard({ title: title.trim(), premise: premise.trim(), requirements: req, targetChars: target, styleProfile: preset });
      await setNovelProviders(novel.id, providerIds);
      nav(`/studio/${novel.id}/plan?auto=1`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const steps = [t.studio.wizard.step1, t.studio.wizard.step2, t.studio.wizard.step3];
  const wan = (target / 10000).toLocaleString(undefined, { maximumFractionDigits: 1 });
  return (
    <div className="h-full overflow-y-auto bg-paper-50 dark:bg-paper-950">
      <div className="mx-auto max-w-2xl px-8 py-12">
        <h1 className="font-serif text-3xl font-semibold tracking-wide">开始新故事</h1>
        <p className="mt-2 text-sm leading-relaxed text-ink-500">告诉 AI 题材、人物和结局的走向，它会先给你一份大纲；你满意了，再让它动笔。</p>

        <ol className="mt-8 mb-6 flex items-center">
          {steps.map((s, i) => (
            <li key={s} className={cn('flex items-center', i < steps.length - 1 && 'flex-1')}>
              <span className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-full font-serif text-sm transition', i < step ? 'bg-tea-600 text-paper-0' : i === step ? 'bg-cinnabar-600 text-paper-0 shadow-soft' : 'bg-paper-200 text-ink-400 dark:bg-paper-800')}>
                {i < step ? <Check size={14} strokeWidth={2} /> : NUMERALS[i]}
              </span>
              <span className={cn('ml-2 whitespace-nowrap font-serif text-sm tracking-wide', i === step ? 'text-ink-900 dark:text-paper-100' : 'text-ink-400')}>{s}</span>
              {i < steps.length - 1 && <span className={cn('mx-4 h-px flex-1', i < step ? 'bg-tea-500/70' : 'bg-paper-300 dark:bg-paper-800')} />}
            </li>
          ))}
        </ol>

        <Card className="p-7">
          <h2 className="font-serif text-xl font-semibold tracking-wide">{steps[step]}</h2>
          <p className="mt-1 mb-6 text-sm text-ink-500">{STEP_INTRO[step]}</p>

          {step === 0 && (
            <div className="space-y-5">
              <Field label="文章类型" hint={DOC_TYPES[(req.docType || 'long-webnovel') as keyof typeof DOC_TYPES]?.framework}>
                <Select value={req.docType} onChange={(e) => set('docType', e.target.value)}>
                  {DOC_TYPE_IDS.map((id) => <option key={id} value={id}>{DOC_TYPES[id].label}</option>)}
                </Select>
              </Field>
              <div className="grid grid-cols-2 gap-4">
                <Field label={t.studio.wizard.genre}>
                  <Select value={req.genre} onChange={(e) => setGenre(e.target.value)}>
                    <option value="">请选择</option>
                    {GENRES.map((g) => <option key={g} value={g}>{g}</option>)}
                  </Select>
                </Field>
                <Field label={t.studio.wizard.pov}>
                  <Select value={req.pov} onChange={(e) => set('pov', e.target.value)}>{POVS.map((p) => <option key={p} value={p}>{p}</option>)}</Select>
                </Field>
                <Field label="文风预设">
                  <Select value={presetId} onChange={(e) => setPresetId(e.target.value)}>
                    <option value="">不用预设</option>
                    {presets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </Select>
                </Field>
                <Field label={t.studio.wizard.style} hint="补充说明，会和预设一起交给 AI"><Input value={req.style} onChange={(e) => set('style', e.target.value)} placeholder="如：冷峭克制、幽默轻快、细腻抒情" /></Field>
                <Field label={t.studio.wizard.tone}><Input value={req.tone} onChange={(e) => set('tone', e.target.value)} placeholder="如：温暖治愈 / 黑暗压抑" /></Field>
                <Field label={t.studio.wizard.audience}><Input value={req.audience} onChange={(e) => set('audience', e.target.value)} placeholder="如：成年读者、青少年" /></Field>
                <Field label="时态"><Input value={req.tense} onChange={(e) => set('tense', e.target.value)} /></Field>
              </div>
              <Field label="题材包" hint="决定术语设定、禁忌词与题材质检项；可多选，本书自己的设定永远优先">
                <div className="flex flex-wrap gap-2">
                  {GENRE_PACKS.map((p) => {
                    const on = req.genrePackIds.includes(p.id);
                    return (
                      <button
                        key={p.id}
                        type="button"
                        title={p.summary}
                        onClick={() => togglePack(p.id)}
                        className={cn('rounded-full border px-3 py-1 text-xs transition', on ? 'border-cinnabar-500 bg-cinnabar-50 text-cinnabar-700 dark:border-cinnabar-500 dark:bg-cinnabar-900/30 dark:text-cinnabar-100' : 'border-paper-300 text-ink-500 hover:border-ink-300 dark:border-paper-700')}
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
                  {genre.forbiddenWords.length > 0 && <li>· 题材禁忌词 {genre.forbiddenWords.length} 个，写作时会拦下来</li>}
                  {genre.conflicts.map((c) => <li key={c} className="text-amber-700 dark:text-amber-300">· {c}</li>)}
                </ul>
              )}
              {preset && preset.injection.humanReadableConstraints.length > 0 && (
                <ul className="space-y-0.5 rounded-xl bg-paper-100 px-4 py-3 text-xs leading-relaxed text-ink-500 dark:bg-paper-800">
                  {preset.injection.humanReadableConstraints.slice(0, 3).map((c) => <li key={c}>· {c}</li>)}
                </ul>
              )}
              <div className="rounded-2xl bg-paper-100 p-5 dark:bg-paper-800">
                <div className="flex items-baseline justify-between gap-4">
                  <span className="text-xs font-medium tracking-wide text-ink-600 dark:text-ink-300">{t.studio.wizard.targetChars}</span>
                  <span className="font-serif text-2xl tracking-wide text-ink-900 dark:text-paper-100">约 {wan} 万字 · {chapters} 章</span>
                </div>
                <input type="range" min={10000} max={300000} step={5000} value={target} onChange={(e) => setTarget(Number(e.target.value))} className="mt-4 w-full" />
                <p className="mt-2 text-xs text-ink-400">{fmt(t.studio.wizard.estimate, { n: chapters, per: Math.round(target / chapters) })}</p>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <Field label={t.studio.wizard.taboos}><Textarea rows={3} value={req.taboos.join('\n')} onChange={(e) => set('taboos', lines(e.target.value))} /></Field>
                <Field label={t.studio.wizard.mustHave}><Textarea rows={3} value={req.mustHave.join('\n')} onChange={(e) => set('mustHave', lines(e.target.value))} /></Field>
              </div>
            </div>
          )}
          {step === 1 && (
            <div className="space-y-5">
              <Field label="书名" hint="可以先留空，让 AI 替你拟一个"><Input className="font-serif" value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
              <Field label={t.studio.wizard.premise} hint={t.studio.wizard.premiseHint}><Textarea rows={12} className="font-serif leading-[1.8]" value={premise} onChange={(e) => setPremise(e.target.value)} placeholder="比如：一个在唐代长安城送信的少年，无意间卷入一场关于失踪公主的秘密……" /></Field>
              <Field label={t.studio.wizard.extra}><Textarea rows={3} value={req.extra} onChange={(e) => set('extra', e.target.value)} placeholder="如：每章结尾留悬念；避免大段独白；出现的地名需符合唐代背景" /></Field>
            </div>
          )}
          {step === 2 && (
            <div className="space-y-5 text-sm">
              <dl className="grid grid-cols-[6rem_1fr] gap-y-2.5 rounded-2xl bg-paper-100 p-5 dark:bg-paper-800">
                <dt className="text-ink-500">书名</dt><dd className="font-serif text-ink-900 dark:text-paper-100">{title || '交给 AI 拟定'}</dd>
                <dt className="text-ink-500">文章类型</dt><dd className="text-ink-800 dark:text-paper-100">{DOC_TYPES[(req.docType || 'long-webnovel') as keyof typeof DOC_TYPES]?.label ?? req.docType}</dd>
                <dt className="text-ink-500">题材包</dt><dd className="text-ink-800 dark:text-paper-100">{genre.labels.join(' + ') || '未选'}</dd>
                <dt className="text-ink-500">题材 / 风格</dt><dd className="text-ink-800 dark:text-paper-100">{[req.genre, preset?.name, req.style, req.tone].filter(Boolean).join(' · ') || '—'}</dd>
                <dt className="text-ink-500">视角</dt><dd className="text-ink-800 dark:text-paper-100">{req.pov}</dd>
                <dt className="text-ink-500">篇幅</dt><dd className="font-serif text-ink-800 dark:text-paper-100">约 {wan} 万字 · {chapters} 章</dd>
                <dt className="text-ink-500">不想出现</dt><dd className="text-ink-800 dark:text-paper-100">{req.taboos.join('、') || '—'}</dd>
              </dl>
              <div>
                <h3 className="mb-1 font-serif text-sm tracking-wide text-ink-700 dark:text-ink-200">用哪些模型</h3>
                <p className="mb-4 text-xs text-ink-400">写正文用好模型，总结与审校用便宜的；不选就跟随「设置 → 模型供应商」里的默认。</p>
                <ModelPurposePicker value={providerIds} onChange={setProviderIds} />
              </div>
              <div className="rounded-2xl bg-paper-100 p-5 dark:bg-paper-800">
                <div className="mb-1 text-xs font-medium tracking-wide text-ink-600 dark:text-ink-300">预计花费</div>
                <CostEstimateLine preview={cost} prefix="大纲 + 章节表 + 整本正文约" />
              </div>
              <p className="leading-relaxed text-ink-500">
                {providers.length ? '点下面的按钮后，AI 会先写一份大纲给你看；你满意了，再让它排出章节、逐章动笔。' : t.chat.noProvider}
              </p>
            </div>
          )}

          <div className="mt-8 flex items-center justify-between">
            <Button variant="ghost" onClick={() => (step === 0 ? nav('/library?tab=novels') : setStep(step - 1))}>{step === 0 ? t.common.cancel : t.studio.wizard.prev}</Button>
            {step < 2
              ? <Button variant="primary" onClick={() => setStep(step + 1)}>{t.studio.wizard.next}</Button>
              : <Button variant="ai" size="lg" onClick={create} disabled={busy}><Sparkles size={16} strokeWidth={1.75} />让 AI 先写一份大纲</Button>}
          </div>
        </Card>
      </div>
    </div>
  );
}
