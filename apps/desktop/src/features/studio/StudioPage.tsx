import { useEffect, useState } from 'react';
import { NavLink, Route, Routes, Navigate, useNavigate, useParams } from 'react-router';
import { ArrowLeft, Pencil, Upload } from 'lucide-react';
import { t } from '@/i18n/zh';
import { Button, Badge, Input, cn } from '@/components/ui';
import { getNovel, updateNovel, type Novel } from '@/db/repos/novelsRepo';
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
  const [novel, setNovel] = useState<Novel | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const tick = useJobs((s) => s.novelTick[novelId] ?? 0);
  const reload = async () => setNovel(await getNovel(novelId));
  useEffect(() => { void reload(); }, [novelId, tick]);

  if (!novel) return <div className="p-8 text-sm text-ink-400">{t.common.loading}</div>;
  const planned = novel.meta.tableDone;
  // Absolute paths: this page is rendered by a splat route, where a relative `to`
  // resolves against the *current* location and would nest (…/chapters/storyline).
  const base = `/studio/${novel.id}`;
  const defaultTab = `${base}/${planned ? 'chapters' : 'plan'}`;
  const tabs = [
    { to: 'plan', label: '规划', show: true },
    { to: 'storyline', label: t.studio.storyline, show: planned || novel.meta.outlineDone },
    { to: 'chapters', label: t.studio.chapters, show: planned },
    { to: 'jobs', label: '进展', show: true },
  ].filter((x) => x.show);

  return (
    <div className="flex h-full flex-col bg-paper-50 dark:bg-paper-950">
      <header className="flex items-center gap-3 border-b border-paper-300/60 bg-paper-100/80 px-5 py-3 backdrop-blur dark:border-paper-800 dark:bg-paper-900/80">
        <Button size="sm" variant="ghost" className="px-2" onClick={() => nav('/library?tab=novels')} title="回到我的故事"><ArrowLeft size={16} strokeWidth={1.75} /></Button>
        {editingTitle ? (
          <Input autoFocus className="max-w-xs font-serif" defaultValue={novel.title} onBlur={async (e) => { await updateNovel(novel.id, { title: e.target.value.trim() || novel.title }); setEditingTitle(false); await reload(); }} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
        ) : (
          <button className="group flex min-w-0 items-center gap-1.5 truncate font-serif text-lg font-semibold tracking-wide text-ink-900 dark:text-paper-100" onClick={() => setEditingTitle(true)} title="改书名">
            <span className="truncate">{novel.title}</span>
            <Pencil size={12} strokeWidth={1.75} className="shrink-0 text-ink-300 opacity-0 transition group-hover:opacity-100" />
          </button>
        )}
        <span className="shrink-0 font-serif text-sm text-ink-500">{t.studio.target} {novel.targetChars.toLocaleString()} 字</span>
        {novel.origin && <Badge tone="amber">二创自《{novel.origin.sourceTitle}》</Badge>}
        {novel.remote?.currentVersionId && <Badge tone="ai" dot>已发布{remoteVersionNumber(novel) ? ` v${remoteVersionNumber(novel)}` : ''}</Badge>}
        <nav className="ml-auto flex items-center gap-0.5 rounded-full bg-paper-200/60 p-1 dark:bg-paper-800/60">
          {tabs.map((tab) => (
            <NavLink key={tab.to} to={`${base}/${tab.to}`} end className={({ isActive }) => cn('rounded-full px-3.5 py-1 text-sm transition', isActive ? 'bg-paper-0 font-medium text-ink-900 shadow-soft dark:bg-paper-900 dark:text-paper-50' : 'text-ink-600 hover:text-ink-900 dark:text-ink-300 dark:hover:text-paper-100')}>{tab.label}</NavLink>
          ))}
        </nav>
        <Button size="sm" variant="secondary" onClick={() => setPublishOpen(true)} title="发布到公共书房"><Upload size={16} strokeWidth={1.75} />发布到公共书房</Button>
      </header>
      <div className="min-h-0 flex-1">
        <Routes>
          <Route index element={<Navigate to={defaultTab} replace />} />
          <Route path="plan" element={<PlanningTab novel={novel} onChanged={reload} />} />
          <Route path="storyline" element={<StorylineTab novel={novel} />} />
          <Route path="chapters" element={<ChaptersTab novel={novel} />} />
          <Route path="jobs" element={<JobsTab novel={novel} />} />
          <Route path="*" element={<Navigate to={defaultTab} replace />} />
        </Routes>
      </div>
      <PublishDialog novel={novel} open={publishOpen} onClose={() => setPublishOpen(false)} onPublished={reload} />
    </div>
  );
}
