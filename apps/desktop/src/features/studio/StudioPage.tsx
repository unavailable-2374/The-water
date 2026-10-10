import { AssistantDock } from '@/assistant/AssistantDock';
import { useAssistant } from '@/assistant/runtime';
import { AsyncNotice } from '@/components/data/AsyncNotice';
import { WritingMaterials } from './WritingMaterials';
import { StoryWorkspace } from './StoryWorkspace';
import { useCallback, useEffect, useState } from 'react';
import { NavLink, Route, Routes, Navigate, useLocation, useNavigate, useParams } from 'react-router';
import { ArrowLeft, Pencil, Upload } from 'lucide-react';
import { fmt, t } from '@/i18n';
import { Button, Badge, IconButton, Input, cn } from '@/components/ui';
import { useAsyncData } from '@/components/data/useAsyncData';
import { getNovel, updateNovel } from '@/db/repos/novelsRepo';
import { useJobs } from '@/stores/jobsStore';
import { ChaptersTab } from './ChaptersTab';
import { JobsTab } from './JobsTab';
import { StorylineTab } from './StorylineTab';
import { PlanningTab } from './PlanningTab';
import { PublishDialog } from '@/features/publicArea/PublishDialog';
import { remoteVersionNumber } from '@/sync/publish';

export function StudioPage() {
  const { novelId = '' } = useParams();
  const nav = useNavigate();
  const assistantOpen=useAssistant(s=>s.open);
  useEffect(()=>{if(useAssistant.getState().context.novelId!==novelId) useAssistant.getState().setContext({novelId,chapterId:null,selection:null,objectIds:[],sourceIds:[]});},[novelId]);
  const { pathname } = useLocation();
  const [editingTitle, setEditingTitle] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const tick = useJobs((s) => s.novelTick[novelId] ?? 0);
  const { data: novel, error, loading, reload: reloadNovel } = useAsyncData(
    () => getNovel(novelId),
    { key: `studioNovel:${novelId}:${tick}`, enabled: !!novelId },
  );
  const reload = useCallback(async () => { reloadNovel(); }, [reloadNovel]);

  if (error || novel === undefined) return <AsyncNotice error={error} retry={reloadNovel} />;
  if (!novel) return <div className="p-8 text-sm text-ink-400">{loading ? t.common.loading : t.error.notFoundTitle}</div>;
  const planned = novel.meta.tableDone;
  // Absolute paths: this page is rendered by a splat route, where a relative `to`
  // resolves against the *current* location and would nest (…/chapters/storyline).
  const base = `/studio/${novel.id}`;
  const defaultTab = `${base}/${planned ? 'chapters' : 'plan'}`;
  const tabs = [
    { to: 'workspace', label: t.storyWorkspace.title, show: true },
    { to: 'plan', label: t.studio.page.tabPlan, show: true },
    { to: 'storyline', label: t.studio.storyline, show: true },
    { to: 'chapters', label: t.studio.chapters, show: true },
    { to: 'materials', label: t.studio.workbench.title, show: true },
    { to: 'jobs', label: t.studio.page.tabJobs, show: true },
  ].filter((x) => x.show);

  return (
    <div className="flex h-full flex-col bg-paper-50 dark:bg-paper-950">
      <header className="app-toolbar flex flex-wrap items-center gap-3 px-5 py-4">
        <IconButton label={t.studio.page.back} onClick={() => nav('/library?tab=novels')}><ArrowLeft size={16} strokeWidth={1.75} aria-hidden="true" /></IconButton>
        {editingTitle ? (
          <Input autoFocus aria-label={t.studio.page.renameTitle} className="max-w-xs" defaultValue={novel.title} onBlur={async (e) => { await updateNovel(novel.id, { title: e.target.value.trim() || novel.title }); setEditingTitle(false); await reload(); }} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
        ) : (
          <button className="group flex min-w-0 max-w-xs items-center gap-1.5 truncate text-lg font-semibold tracking-tight text-ink-900 dark:text-paper-100" onClick={() => setEditingTitle(true)} title={t.studio.page.renameTitle}>
            <span className="truncate">{novel.title}</span>
            {/* 铅笔只是装饰：按钮本身有书名做无障碍名字，聚焦时也让它显出来 */}
            <Pencil size={12} strokeWidth={1.75} aria-hidden="true" className="shrink-0 text-ink-300 opacity-0 transition group-hover:opacity-100 group-focus-visible:opacity-100" />
          </button>
        )}
        <span className="shrink-0 text-xs tabular-nums text-ink-500">{t.studio.target} {fmt(t.studio.page.targetChars, { n: novel.targetChars.toLocaleString() })}</span>
        {novel.origin && <Badge tone="amber">{fmt(t.studio.page.derivedFrom, { title: novel.origin.sourceTitle })}</Badge>}
        {novel.remote?.currentVersionId && <Badge tone="ai" dot>{remoteVersionNumber(novel) ? fmt(t.studio.page.publishedVersion, { n: remoteVersionNumber(novel)! }) : t.studio.page.published}</Badge>}
        <nav aria-label={t.studio.page.tabs} className="segmented-control ml-auto flex flex-wrap items-center gap-0.5 rounded-xl bg-paper-200/60 p-1 dark:bg-paper-800/60">
          {tabs.map((tab) => {
            const to = `${base}/${tab.to}`;
            const isActive = pathname === to;
            return (
              <NavLink key={tab.to} to={to} end className={cn('min-h-8 rounded-lg px-3 py-1.5 text-sm transition-colors', isActive ? 'bg-paper-0 font-medium text-ink-900 shadow-soft dark:bg-paper-900 dark:text-paper-50' : 'text-ink-600 hover:text-ink-900 dark:text-ink-300 dark:hover:text-paper-100')}>{tab.label}</NavLink>
            );
          })}
        </nav>
        <Button size="sm" aria-expanded={assistantOpen} onClick={()=>useAssistant.getState().setOpen(!assistantOpen)}>{t.assistant.title}</Button>
        <Button size="sm" variant="secondary" onClick={() => setPublishOpen(true)} title={t.studio.page.publish}><Upload size={16} strokeWidth={1.75} aria-hidden="true" />{t.studio.page.publish}</Button>
      </header>
      <div className="min-h-0 flex flex-1">
        <div className="min-w-0 flex-1">
        <Routes>
          <Route path="workspace" element={<StoryWorkspace novel={novel} />} />
          <Route index element={<Navigate to={defaultTab} replace />} />
          <Route path="plan" element={<PlanningTab novel={novel} onChanged={reload} />} />
          <Route path="storyline" element={<StorylineTab novel={novel} />} />
          <Route path="chapters" element={<ChaptersTab novel={novel} />} />
          <Route path="materials" element={<WritingMaterials novel={novel} />} />
          <Route path="jobs" element={<JobsTab novel={novel} />} />
          <Route path="*" element={<Navigate to={defaultTab} replace />} />
        </Routes>
        </div>
        <AssistantDock/>
      </div>
      <PublishDialog novel={novel} open={publishOpen} onClose={() => setPublishOpen(false)} onPublished={reload} />
    </div>
  );
}
