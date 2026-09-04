import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { Sparkles, Play, RefreshCw, CheckCircle2, Circle } from 'lucide-react';
import { Button, Card, SectionTitle, Spinner, confirm, cn } from '@/components/ui';
import { toast } from '@/components/Toast';
import type { Novel } from '@/db/repos/novelsRepo';
import { listChapters, type Chapter } from '@/db/repos/chaptersRepo';
import { listArcs, listBeats, listCharacters, listSettings } from '@/db/repos/storylineRepo';
import { BudgetExceededError } from '@/db/repos/usageRepo';
import {
  ConfirmRequiredError, getNovelProviders, setNovelProviders, startChapterTable, startGeneration, startOutline, wantsStyleCheck,
} from '@/novel/service';
import { estimateGeneration, estimatePlanning } from '@/novel/pricing';
import { planChapterCount } from '@/novel/wordBudget';
import { useJobs } from '@/stores/jobsStore';
import { pauseJob } from '@/jobs/runner';
import type { StepProviderMap } from '@/jobs/purposes';
import { CostEstimateLine, previewCostForNovel, UsageCards, type CostPreview } from './UsagePanel';
import { ModelPurposePicker } from './ModelPicker';
import type { Arc, Beat, Character, Setting } from '@the-water/shared';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * 规划流程：大纲 → （审阅）→ 章节表 → （审阅）→ 开工。
 * 大纲与章节表现在都是后台任务（§2.1 第 1 条），所以这一页只负责发起、
 * 显示进度、以及在重排前替用户把「已有章节会被替换」讲清楚。
 */
export function PlanningTab({ novel, onChanged }: { novel: Novel; onChanged: () => Promise<void> }) {
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const [busy, setBusy] = useState(false);
  const [chars, setChars] = useState<Character[]>([]);
  const [settings, setSettings] = useState<Setting[]>([]);
  const [arcs, setArcs] = useState<Arc[]>([]);
  const [beats, setBeats] = useState<Beat[]>([]);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [providerIds, setProviderIds] = useState<StepProviderMap>({});
  const [genCost, setGenCost] = useState<CostPreview | null>(null);
  const [planCost, setPlanCost] = useState<CostPreview | null>(null);

  const allJobs = useJobs((s) => s.jobs);
  const live = useJobs((s) => s.live);
  // 这本书当前在跑的任务（规划任务与写作任务共用这块进度显示）。
  const activeJob = useMemo(
    () => Object.values(allJobs).filter((j) => j.novelId === novel.id && ['queued', 'running', 'pausing'].includes(j.status)).sort((a, b) => b.createdAt - a.createdAt)[0] ?? null,
    [allJobs, novel.id],
  );
  const stepsByJob = useJobs((s) => s.steps);
  const activeKind = useMemo(() => {
    const steps = activeJob ? stepsByJob[activeJob.id] : undefined;
    return steps?.find((s) => s.id === activeJob?.progress.currentStepId)?.kind ?? null;
  }, [activeJob?.id, activeJob?.progress.currentStepId, stepsByJob]);
  useEffect(() => { if (activeJob) void useJobs.getState().loadSteps(activeJob.id); }, [activeJob?.id, activeJob?.progress.done]);

  const load = async () => {
    const [c, s, a, b, ch] = await Promise.all([listCharacters(novel.id), listSettings(novel.id), listArcs(novel.id), listBeats(novel.id), listChapters(novel.id)]);
    setChars(c); setSettings(s); setArcs(a); setBeats(b); setChapters(ch);
  };
  const tick = useJobs((s) => s.novelTick[novel.id] ?? 0);
  useEffect(() => { void load(); }, [novel.id, novel.meta.outlineDone, novel.meta.tableDone, tick]);
  useEffect(() => { void getNovelProviders(novel.id).then(setProviderIds); }, [novel.id]);

  // 费用预估（§2.1 第 3 条）：模型或章节表一变就重算。
  useEffect(() => {
    void (async () => {
      const styleCheck = await wantsStyleCheck(novel.id);
      const list = chapters.length ? chapters : Array.from({ length: planChapterCount(novel.targetChars) }, () => ({ targetChars: Math.round(novel.targetChars / planChapterCount(novel.targetChars)) }));
      setGenCost(await previewCostForNovel(novel.id, estimateGeneration(list, { styleCheck })));
      const planning = estimatePlanning(planChapterCount(novel.targetChars));
      setPlanCost(await previewCostForNovel(novel.id, { writing: { inputTokens: 0, outputTokens: 0 }, auxiliary: planning }));
    })();
  }, [novel.id, novel.targetChars, chapters.length, providerIds]);

  const saveProviders = async (next: StepProviderMap) => {
    setProviderIds(next);
    await setNovelProviders(novel.id, next);
  };

  const start = async (label: string, fn: () => Promise<string>) => {
    setBusy(true);
    try {
      await fn();
      toast.success(label);
      await onChanged();
    } catch (e) {
      if (e instanceof BudgetExceededError) {
        const go = await confirm({ title: '超出预算上限', description: `${e.message}　仍然继续吗？`, confirmText: '继续', tone: 'danger' });
        if (go) { setBusy(false); return start(label, fn); }
      } else {
        toast.error(errMsg(e));
      }
    } finally {
      setBusy(false);
    }
  };

  const doOutline = () => start('AI 开始构思大纲了', () => startOutline(novel.id));
  const doTable = () => start('AI 开始排章节表了', async () => {
    try {
      return await startChapterTable(novel.id);
    } catch (e) {
      if (!(e instanceof ConfirmRequiredError)) throw e;
      // 重排会删掉已有章节，先确认；确认后 chapter_table 步骤会自动落一份故事线快照。
      const ok = await confirm({ title: '重排章节表', description: `${e.message}　继续前会自动保存一份当前故事线快照。`, confirmText: '重排', tone: 'danger' });
      if (!ok) throw new Error('已取消');
      return startChapterTable(novel.id, { confirmReplaceChapters: true });
    }
  });
  const doStart = async () => {
    await start('AI 开始动笔了', () => startGeneration(novel.id));
    nav(`/studio/${novel.id}/chapters`);
  };

  // auto mode from the wizard: outline → table, then let the user review
  useEffect(() => {
    if (params.get('auto') === '1' && !novel.meta.outlineDone && !busy && !activeJob) {
      setParams({});
      void doOutline();
    }
  }, [params]);

  const totalTarget = chapters.reduce((s, c) => s + c.targetChars, 0);
  const outlineDone = novel.meta.outlineDone;
  const tableDone = novel.meta.tableDone;
  const running = !!activeJob || busy;
  const liveText = activeJob ? live[activeJob.id]?.text ?? '' : '';

  return (
    <div className="grid h-full grid-rows-[minmax(0,1fr)] grid-cols-[1fr_340px] bg-paper-50 dark:bg-paper-950">
      <div className="overflow-y-auto">
        <div className="mx-auto max-w-3xl px-8 py-8">
          <section className="mb-8">
            <SectionTitle>故事前提</SectionTitle>
            <Card className="paper-texture">
              <p className="whitespace-pre-wrap font-serif text-[15px] leading-[1.9] text-ink-800 dark:text-paper-100">{novel.premise || '还没有写下故事前提。'}</p>
            </Card>
          </section>

          {outlineDone && (
            <section className="mb-8 space-y-6">
              <div>
                <SectionTitle action={<span className="text-xs text-ink-400">每一项都可以在「故事线」里慢慢改</span>}>大纲</SectionTitle>
                {novel.meta.logline && <p className="font-serif text-base leading-relaxed tracking-wide text-ink-700 dark:text-ink-200">{novel.meta.logline}</p>}
              </div>

              <Group title="人物" count={chars.length}>
                <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  {chars.map((c) => (
                    <li key={c.id} className="rounded-2xl bg-paper-0 p-4 shadow-soft dark:bg-paper-900">
                      <div className="font-serif text-base font-semibold tracking-wide text-ink-900 dark:text-paper-100">{c.name}</div>
                      {c.role && <div className="mt-0.5 font-serif text-xs text-ink-500">{c.role}</div>}
                      {c.description && <p className="mt-2 line-clamp-3 text-xs leading-relaxed text-ink-600 dark:text-ink-300">{c.description}</p>}
                    </li>
                  ))}
                </ul>
              </Group>

              <Group title="设定" count={settings.length}>
                <ul className="grid grid-cols-2 gap-3">
                  {settings.map((s) => (
                    <li key={s.id} className="rounded-2xl bg-paper-100/80 p-4 dark:bg-paper-900/70">
                      <div className="font-serif text-sm font-semibold tracking-wide text-ink-900 dark:text-paper-100">{s.name}</div>
                      {s.description && <p className="mt-1 line-clamp-3 text-xs leading-relaxed text-ink-600 dark:text-ink-300">{s.description}</p>}
                    </li>
                  ))}
                </ul>
              </Group>

              <Group title="故事弧" count={arcs.length}>
                <ol className="flex gap-4 overflow-x-auto pb-2">
                  {arcs.map((a, i) => (
                    <li key={a.id} className="w-60 shrink-0">
                      <div className="mb-3 flex items-center gap-2">
                        <span className="h-2 w-2 shrink-0 rounded-full bg-tea-500" />
                        <span className={cn('h-px flex-1', i < arcs.length - 1 ? 'bg-tea-200 dark:bg-tea-800' : 'bg-transparent')} />
                      </div>
                      <div className="font-serif text-xs text-ink-400">第 {a.startChapterNo}–{a.endChapterNo} 章</div>
                      <div className="mt-0.5 font-serif text-sm font-semibold tracking-wide text-ink-900 dark:text-paper-100">{a.title}</div>
                      {a.summary && <p className="mt-1.5 line-clamp-4 text-xs leading-relaxed text-ink-600 dark:text-ink-300">{a.summary}</p>}
                    </li>
                  ))}
                </ol>
              </Group>

              <Group title="情节点" count={beats.length}>
                <ul className="space-y-2">
                  {beats.map((b) => (
                    <li key={b.id} className="flex gap-3 text-sm">
                      <span className="w-14 shrink-0 pt-px font-serif text-xs text-ink-400">{b.chapterNo ? `第${b.chapterNo}章` : ''}</span>
                      <span className="min-w-0 flex-1 leading-relaxed"><span className="font-serif font-medium text-ink-900 dark:text-paper-100">{b.title}</span>{b.summary && <span className="text-ink-600 dark:text-ink-300">　{b.summary}</span>}</span>
                    </li>
                  ))}
                </ul>
              </Group>
            </section>
          )}

          {tableDone && (
            <section className="mb-8">
              <SectionTitle action={<span className="font-serif text-xs text-ink-500">{chapters.length} 章 · 合计约 {totalTarget.toLocaleString()} 字</span>}>章节表</SectionTitle>
              <Card className="p-2">
                <ol>
                  {chapters.map((c) => (
                    <li key={c.id} className="flex gap-4 border-b border-paper-300/50 px-4 py-3 last:border-0 dark:border-paper-800">
                      <span className="w-10 shrink-0 pt-px font-serif text-sm text-ink-400">{c.chapterNo}</span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline gap-3">
                          <span className="truncate font-serif text-sm font-medium tracking-wide text-ink-900 dark:text-paper-100">{c.title}</span>
                          <span className="ml-auto shrink-0 font-serif text-xs text-ink-500">{c.targetChars.toLocaleString()} 字</span>
                        </div>
                        {c.goal && <p className="mt-0.5 text-xs leading-relaxed text-ink-500">{c.goal}</p>}
                      </div>
                    </li>
                  ))}
                </ol>
              </Card>
            </section>
          )}
        </div>
      </div>

      <aside className="flex min-h-0 flex-col gap-4 overflow-y-auto border-l border-paper-300/60 bg-paper-100/60 p-5 dark:border-paper-800 dark:bg-paper-900/60">
        <Card className="flex min-h-0 flex-col">
          <h2 className="font-serif text-base font-semibold tracking-wide text-ink-800 dark:text-paper-100">书桌便签</h2>
          <p className="mt-0.5 text-xs text-ink-400">三步，把设想变成一本书</p>
          <ol className="mt-5 space-y-5">
            <Step done={outlineDone} running={activeKind === 'outline'} title="让 AI 写一份大纲" hint="人物、设定、故事弧和情节点"
              action={outlineDone
                ? <Button size="sm" variant="ghost" disabled={running} onClick={doOutline}><RefreshCw size={14} strokeWidth={1.75} />重新构思</Button>
                : <><Button variant="ai" className="w-full" disabled={running} onClick={doOutline}><Sparkles size={16} strokeWidth={1.75} />让 AI 先写一份大纲</Button><CostEstimateLine preview={planCost} prefix="大纲与章节表预计" /></>} />
            <Step done={tableDone} running={activeKind === 'chapter_table'} title="排出章节表" hint="每章写什么、大约多少字"
              action={!outlineDone ? null : tableDone
                ? <Button size="sm" variant="ghost" disabled={running} onClick={doTable}><RefreshCw size={14} strokeWidth={1.75} />重新排</Button>
                : <Button variant="ai" className="w-full" disabled={running} onClick={doTable}><Sparkles size={16} strokeWidth={1.75} />让 AI 排出章节表</Button>} />
            <Step done={false} running={activeKind === 'write_chapter'} title="开始逐章写作" hint="AI 会一章一章地写，你随时可以停下来改"
              action={tableDone
                ? <><Button variant="ai" className="w-full" disabled={running} onClick={doStart}><Play size={16} strokeWidth={1.75} />让 AI 开始动笔</Button><CostEstimateLine preview={genCost} prefix="整本预计" /></>
                : null} />
          </ol>
          {activeJob && (
            <div className="mt-5 flex min-h-0 flex-col">
              <div className="mb-2 flex items-center gap-2 text-xs text-tea-700 dark:text-tea-200">
                <Spinner className="h-3 w-3" />{activeJob.progress.message || '正在准备…'}
                <Button size="sm" variant="ghost" className="ml-auto" onClick={() => pauseJob(activeJob.id)}>停下</Button>
              </div>
              <div className="paper-texture max-h-56 min-h-24 flex-1 overflow-auto whitespace-pre-wrap rounded-2xl bg-paper-100 p-4 font-serif text-xs leading-relaxed text-ink-600 dark:bg-paper-800 dark:text-ink-300">
                {liveText}<span className="ml-0.5 inline-block h-3 w-0.5 animate-pulse bg-tea-500 align-middle" />
              </div>
            </div>
          )}
        </Card>

        <Card>
          <h2 className="font-serif text-base font-semibold tracking-wide text-ink-800 dark:text-paper-100">用哪些模型</h2>
          <p className="mt-0.5 mb-4 text-xs text-ink-400">写正文用好模型，总结与审校用便宜的，钱花在刀刃上</p>
          <ModelPurposePicker value={providerIds} onChange={saveProviders} />
        </Card>

        <UsageCards novelId={novel.id} jobId={activeJob?.id ?? null} tick={tick} />
      </aside>
    </div>
  );
}

function Group({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <div>
      <h3 className="mb-2 font-serif text-sm tracking-wide text-ink-600 dark:text-ink-300">{title}<span className="ml-1.5 text-xs text-ink-400">{count}</span></h3>
      {children}
    </div>
  );
}

function Step({ done, running, title, hint, action }: { done: boolean; running: boolean; title: string; hint: string; action: ReactNode }) {
  return (
    <li className="flex items-start gap-3">
      <span className="mt-px flex h-5 w-5 shrink-0 items-center justify-center">
        {running ? <Spinner className="h-4 w-4" /> : done ? <CheckCircle2 size={18} strokeWidth={1.75} className="text-tea-600" /> : <Circle size={18} strokeWidth={1.5} className="text-paper-400" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className={cn('font-serif text-sm tracking-wide', done ? 'text-ink-500' : 'text-ink-900 dark:text-paper-100')}>{title}</div>
        <div className="text-xs text-ink-400">{hint}</div>
        {action && <div className="mt-2 space-y-1.5">{action}</div>}
      </div>
    </li>
  );
}
