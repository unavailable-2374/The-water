import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, GitCompareArrows, History, Plus, Save, Trash2, ChevronUp } from 'lucide-react';
import { emptyStoryline, type ChapterPlan, type StorylineDoc } from '@the-water/shared';
import { fmt, t } from '@/i18n';
import { Button, Card, IconButton, cn, confirm, EmptyState, Spinner } from '@/components/ui';
import { useAsyncData } from '@/components/data/useAsyncData';
import { toast } from '@/components/Toast';
import type { Novel } from '@/db/repos/novelsRepo';
import { listChapters, upsertChapterPlan } from '@/db/repos/chaptersRepo';
import {
  buildStorylineDoc, createSnapshot, deleteEntity, listArcs, listBeats, listCharacters, listSettings, listSnapshots,
  upsertArc, upsertBeat, upsertCharacter, upsertSetting, type StorylineSnapshot,
} from '@/db/repos/storylineRepo';
import { diffStoryline } from '@/novel/storyline/diff';
import { emitJobEvent } from '@/jobs/events';
import { useJobs } from '@/stores/jobsStore';
import { RewritePlanDialog } from './RewritePlanDialog';
import { ArcForm, BeatForm, ChapterPlanForm, CharacterForm, PremiseForm, SettingForm } from './storyline/forms';
import { DerivativeForm, StyleProfileForm } from './storyline/StyleForms';
import { discardPendingSaves } from './storyline/useAutosave';
import { formatTime, settingKindLabel, snapshotReasonLabel, type EntityKind, type Selection, type StorylineData } from './storyline/types';

const TABLE: Record<EntityKind, 'characters' | 'settings' | 'arcs' | 'beats'> = { character: 'characters', setting: 'settings', arc: 'arcs', beat: 'beats' };

/** 分区名字现取现用，不在模块顶层拷贝文案。 */
function kindLabel(kind: EntityKind): string {
  return { character: t.studio.characters, setting: t.studio.settings, arc: t.studio.arcs, beat: t.studio.beats }[kind];
}

const toPlan = (c: StorylineData['chapters'][number]): ChapterPlan => ({
  chapterNo: c.chapterNo, title: c.title, goal: c.goal, beatIds: c.beatIds, povCharacterId: c.povCharacterId, targetChars: c.targetChars, endHook: c.endHook,
});

const sameSelection = (a: Selection, b: Selection): boolean => {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'premise' || a.kind === 'style' || a.kind === 'derivative') return true;
  if (a.kind === 'chapter') return b.kind === 'chapter' && a.chapterNo === b.chapterNo;
  return 'id' in b && a.id === b.id;
};

interface Loaded { data: StorylineData; snapshots: StorylineSnapshot[] }

/** Storyline editor: tree of entities on the left, autosaving form on the right, snapshot toolbar on top. */
export function StorylineTab({ novel }: { novel: Novel }) {
  const tick = useJobs((s) => s.novelTick[novel.id] ?? 0);
  const [sel, setSel] = useState<Selection>({ kind: 'premise' });
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [rewriteOpen, setRewriteOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const { data: loaded, error, loading, reload } = useAsyncData<Loaded>(async () => {
    const [characters, settings, arcs, beats, chapters, snaps] = await Promise.all([
      listCharacters(novel.id), listSettings(novel.id), listArcs(novel.id), listBeats(novel.id), listChapters(novel.id), listSnapshots(novel.id),
    ]);
    return { data: { characters, settings, arcs, beats, chapters }, snapshots: snaps };
  }, { key: `storyline:${novel.id}:${tick}` });
  const data = loaded?.data ?? null;
  const snapshots = useMemo(() => loaded?.snapshots ?? [], [loaded]);

  const notify = useCallback(() => emitJobEvent({ type: 'novel:storylineUpdated', novelId: novel.id }), [novel.id]);
  const refresh = useCallback(async () => { reload(); notify(); }, [reload, notify]);

  const currentDoc = useMemo<StorylineDoc | null>(() => data && ({
    ...emptyStoryline(), premise: novel.premise, themes: novel.meta.themes,
    characters: data.characters, settings: data.settings, arcs: data.arcs, beats: data.beats, chapters: data.chapters.map(toPlan),
  }), [data, novel.premise, novel.meta.themes]);
  const latest = snapshots[0];
  const hasUnsaved = useMemo(() => (latest && currentDoc ? !diffStoryline(latest.doc, currentDoc).isEmpty : false), [latest, currentDoc]);

  // ---- toolbar actions ----
  const saveVersion = async () => {
    setSaving(true);
    try {
      const doc = await buildStorylineDoc(novel.id, novel.premise, novel.meta.themes);
      await createSnapshot(novel.id, doc, 'user_commit');
      toast.success(t.studio.storylineTab.saved);
      await refresh();
    } catch (e) { toast.error(e instanceof Error ? e.message : String(e)); } finally { setSaving(false); }
  };

  // ---- entity CRUD ----
  const run = async (fn: () => Promise<void>) => {
    try { await fn(); } catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
  };
  const add = (kind: EntityKind | 'chapter') => run(async () => {
    if (!data) return;
    let next: Selection;
    if (kind === 'character') next = { kind, id: (await upsertCharacter(novel.id, { name: t.studio.storylineTab.newCharacter }, data.characters.length)).id };
    else if (kind === 'setting') next = { kind, id: (await upsertSetting(novel.id, { name: t.studio.storylineTab.newSetting, kind: 'other' }, data.settings.length)).id };
    else if (kind === 'arc') {
      const last = data.chapters.at(-1)?.chapterNo ?? 1;
      next = { kind, id: (await upsertArc(novel.id, { title: t.studio.storylineTab.newArc, startChapterNo: 1, endChapterNo: last }, data.arcs.length)).id };
    } else if (kind === 'beat') {
      const chapterNo = sel.kind === 'chapter' ? sel.chapterNo : sel.kind === 'beat' ? data.beats.find((b) => b.id === sel.id)?.chapterNo ?? null : null;
      next = { kind, id: (await upsertBeat(novel.id, { title: t.studio.storylineTab.newBeat, chapterNo }, data.beats.length)).id };
    } else {
      const chapterNo = (data.chapters.at(-1)?.chapterNo ?? 0) + 1;
      const avg = data.chapters.length ? Math.round(data.chapters.reduce((s, c) => s + c.targetChars, 0) / data.chapters.length / 100) * 100 : 3000;
      await upsertChapterPlan(novel.id, { chapterNo, title: fmt(t.studio.chapterNo, { n: chapterNo }), targetChars: avg || 3000 });
      next = { kind: 'chapter', chapterNo };
    }
    await refresh();
    setSel(next);
  });

  const remove = (kind: EntityKind, id: string) => run(async () => {
    if (!data || !(await confirm({ title: t.common.confirmDelete, confirmText: t.common.confirm, tone: 'danger' }))) return;
    const list = data[TABLE[kind]] as Array<{ id: string }>;
    const i = list.findIndex((x) => x.id === id);
    const neighbour = list[i + 1] ?? list[i - 1];
    discardPendingSaves(id);
    setSel(neighbour ? { kind, id: neighbour.id } : { kind: 'premise' });
    await deleteEntity(TABLE[kind], id);
    await refresh();
  });

  const move = (kind: EntityKind, id: string, dir: -1 | 1) => run(async () => {
    if (!data) return;
    const list = [...(data[TABLE[kind]] as Array<{ id: string }>)];
    const i = list.findIndex((x) => x.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j]!, list[i]!];
    // Normalize sort_order for the whole section so the swap is stable even when orders were all 0.
    if (kind === 'character') { const ordered = list.map((x) => data.characters.find((c) => c.id === x.id)!); for (let k = 0; k < ordered.length; k++) await upsertCharacter(novel.id, ordered[k]!, k); }
    if (kind === 'setting') { const ordered = list.map((x) => data.settings.find((c) => c.id === x.id)!); for (let k = 0; k < ordered.length; k++) await upsertSetting(novel.id, ordered[k]!, k); }
    if (kind === 'arc') { const ordered = list.map((x) => data.arcs.find((c) => c.id === x.id)!); for (let k = 0; k < ordered.length; k++) await upsertArc(novel.id, ordered[k]!, k); }
    if (kind === 'beat') { const ordered = list.map((x) => data.beats.find((c) => c.id === x.id)!); for (let k = 0; k < ordered.length; k++) await upsertBeat(novel.id, { ...ordered[k]!, order: k }, k); }
    await refresh();
  });

  if (error) return <div className="flex h-full items-center justify-center text-sm text-cinnabar-600" role="alert">{error instanceof Error ? error.message : String(error)}</div>;
  if (!data) return <div className="flex h-full items-center justify-center text-sm text-ink-400" role="status"><Spinner className="mr-2" />{t.common.loading}</div>;

  // ---- right pane ----
  let header: ReactNode = null;
  let body: ReactNode = null;
  let actions: ReactNode = null;
  const entityActions = (kind: EntityKind, id: string, index: number, length: number) => (
    <div className="flex items-center gap-1">
      <IconButton label={t.studio.storylineTab.moveUp} disabled={index <= 0} className="disabled:opacity-40" onClick={() => move(kind, id, -1)}><ChevronUp size={16} strokeWidth={1.75} aria-hidden="true" /></IconButton>
      <IconButton label={t.studio.storylineTab.moveDown} disabled={index >= length - 1} className="disabled:opacity-40" onClick={() => move(kind, id, 1)}><ChevronDown size={16} strokeWidth={1.75} aria-hidden="true" /></IconButton>
      <Button size="sm" variant="ghost" className="text-cinnabar-600 hover:text-cinnabar-700 dark:text-cinnabar-100" onClick={() => remove(kind, id)}><Trash2 size={16} strokeWidth={1.75} aria-hidden="true" />{t.common.delete}</Button>
    </div>
  );
  const common = { novelId: novel.id, data, onSaved: notify };
  if (sel.kind === 'premise') {
    header = t.studio.storylineTab.premise;
    body = <PremiseForm key={novel.id} novel={novel} onSaved={notify} />;
  } else if (sel.kind === 'style') {
    header = t.studio.storylineTab.style;
    body = <StyleProfileForm key={`style-${novel.id}`} novel={novel} refreshKey={tick} hasText={data.chapters.some((c) => c.currentVersionId)} onSaved={notify} />;
  } else if (sel.kind === 'derivative') {
    header = t.studio.storylineTab.derivative;
    body = <DerivativeForm key={`derivative-${novel.id}`} novel={novel} onSaved={notify} />;
  } else if (sel.kind === 'chapter') {
    const ch = data.chapters.find((c) => c.chapterNo === sel.chapterNo);
    if (ch) {
      header = <>{fmt(t.studio.chapterNo, { n: ch.chapterNo })} <span className="font-normal text-ink-500">{ch.title || t.studio.unnamed}</span></>;
      body = <ChapterPlanForm key={ch.id} chapter={ch} {...common} />;
    }
  } else {
    const kind = sel.kind;
    const list = data[TABLE[kind]] as Array<{ id: string }>;
    const index = list.findIndex((x) => x.id === sel.id);
    const c = data.characters[index]; const s = data.settings[index]; const a = data.arcs[index]; const b = data.beats[index];
    if (index >= 0) {
      actions = entityActions(kind, sel.id, index, list.length);
      if (kind === 'character' && c) { header = <><span className="font-normal text-ink-500">{kindLabel(kind)} · </span>{c.name}</>; body = <CharacterForm key={c.id} character={c} index={index} {...common} />; }
      if (kind === 'setting' && s) { header = <><span className="font-normal text-ink-500">{kindLabel(kind)} · </span>{s.name}</>; body = <SettingForm key={s.id} setting={s} index={index} {...common} />; }
      if (kind === 'arc' && a) { header = <><span className="font-normal text-ink-500">{kindLabel(kind)} · </span>{a.title}</>; body = <ArcForm key={a.id} arc={a} index={index} {...common} />; }
      if (kind === 'beat' && b) { header = <><span className="font-normal text-ink-500">{kindLabel(kind)} · </span>{b.title}</>; body = <BeatForm key={b.id} beat={b} {...common} />; }
    }
  }

  const charName = (id: string | null) => (id ? data.characters.find((c) => c.id === id)?.name ?? null : null);

  return (
    <div className="flex h-full flex-col bg-paper-50 dark:bg-paper-950">
      <div className="flex items-center gap-3 border-b border-paper-300/50 px-6 py-3 dark:border-paper-800">
        <h2 className="font-serif text-base font-semibold tracking-wide text-ink-800 dark:text-paper-100">{t.studio.storyline}</h2>
        {hasUnsaved && <span className="inline-flex items-center gap-1.5 text-xs text-ink-500" role="status"><span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden="true" />{t.studio.storylineTab.unsaved}</span>}
        {!latest && <span className="text-xs text-ink-400">{t.studio.storylineTab.noVersion}</span>}
        <div className="ml-auto flex items-center gap-2">
          <div className="relative">
            <Button size="sm" aria-expanded={versionsOpen} aria-haspopup="true" onClick={() => setVersionsOpen((v) => !v)}><History size={16} strokeWidth={1.75} aria-hidden="true" />{t.studio.storylineTab.versions} <span className="font-serif">{snapshots.length}</span><ChevronDown size={12} aria-hidden="true" /></Button>
            {versionsOpen && (
              <>
                <div className="fixed inset-0 z-30" aria-hidden="true" onMouseDown={() => setVersionsOpen(false)} />
                <div className="absolute right-0 z-40 mt-2 w-72 rounded-2xl bg-paper-0 p-2 shadow-lift dark:bg-paper-900">
                  {snapshots.length === 0 && <p className="px-3 py-2 text-xs text-ink-400">{t.studio.storylineTab.versionsEmpty}</p>}
                  <ul aria-label={t.studio.storylineTab.versions} className="max-h-72 overflow-y-auto">
                    {snapshots.map((s, i) => (
                      <li key={s.id} className="flex items-center justify-between gap-2 rounded-xl px-3 py-2 text-xs hover:bg-paper-100 dark:hover:bg-paper-800">
                        <span className="inline-flex items-center gap-1.5 text-ink-700 dark:text-paper-100"><span className={cn('h-1.5 w-1.5 rounded-full', s.reason === 'user_commit' ? 'bg-tea-500' : 'bg-ink-300')} aria-hidden="true" />{snapshotReasonLabel(s.reason)}{i === 0 && <span className="text-ink-400">{t.studio.storylineTab.latest}</span>}</span>
                        <span className="font-serif text-ink-400">{formatTime(s.createdAt)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </>
            )}
          </div>
          <Button size="sm" disabled={saving} onClick={saveVersion}>{saving ? <Spinner className="h-3 w-3" /> : <Save size={16} strokeWidth={1.75} aria-hidden="true" />}{t.studio.storylineTab.saveVersion}</Button>
          <Button size="sm" variant="primary" disabled={!latest} title={latest ? undefined : t.studio.storylineTab.computeRewriteDisabled} onClick={() => setRewriteOpen(true)}><GitCompareArrows size={16} strokeWidth={1.75} aria-hidden="true" />{t.studio.storylineTab.computeRewrite}</Button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)] grid-cols-[280px_1fr]">
        <aside aria-label={t.studio.storylineTab.tree} className="overflow-y-auto border-r border-paper-300/60 bg-paper-100/60 px-3 py-3 dark:border-paper-800 dark:bg-paper-900/60">
          <ul>
            <TreeItem active={sel.kind === 'premise'} onClick={() => setSel({ kind: 'premise' })} label={t.studio.storylineTab.premise} sub={novel.meta.themes.join('、') || undefined} />
            <TreeItem active={sel.kind === 'style'} onClick={() => setSel({ kind: 'style' })} label={t.studio.storylineTab.style} sub={t.studio.storylineTab.styleSub} />
            {novel.origin && <TreeItem active={sel.kind === 'derivative'} onClick={() => setSel({ kind: 'derivative' })} label={t.studio.storylineTab.derivative} sub={fmt(t.studio.storylineTab.derivativeSub, { title: novel.origin.sourceTitle })} />}
          </ul>
          <Section title={t.studio.characters} count={data.characters.length} onAdd={() => add('character')}>
            {data.characters.map((c) => <TreeItem key={c.id} active={sameSelection(sel, { kind: 'character', id: c.id })} onClick={() => setSel({ kind: 'character', id: c.id })} label={c.name} sub={c.role || undefined} />)}
          </Section>
          <Section title={t.studio.settings} count={data.settings.length} onAdd={() => add('setting')}>
            {data.settings.map((s) => <TreeItem key={s.id} active={sameSelection(sel, { kind: 'setting', id: s.id })} onClick={() => setSel({ kind: 'setting', id: s.id })} label={s.name} sub={settingKindLabel(s.kind)} />)}
          </Section>
          <Section title={t.studio.arcs} count={data.arcs.length} onAdd={() => add('arc')}>
            {data.arcs.map((a) => <TreeItem key={a.id} active={sameSelection(sel, { kind: 'arc', id: a.id })} onClick={() => setSel({ kind: 'arc', id: a.id })} label={a.title} sub={fmt(t.studio.planning.arcRange, { from: a.startChapterNo, to: a.endChapterNo })} />)}
          </Section>
          <Section title={t.studio.beats} count={data.beats.length} onAdd={() => add('beat')}>
            {data.beats.map((b) => <TreeItem key={b.id} active={sameSelection(sel, { kind: 'beat', id: b.id })} onClick={() => setSel({ kind: 'beat', id: b.id })} label={b.title} sub={b.chapterNo ? fmt(t.studio.chapterNo, { n: b.chapterNo }) : t.studio.storylineTab.beatUnplaced} />)}
          </Section>
          <Section title={t.studio.chapterPlans} count={data.chapters.length} onAdd={() => add('chapter')}>
            {data.chapters.map((c) => (
              <TreeItem key={c.id} active={sameSelection(sel, { kind: 'chapter', chapterNo: c.chapterNo })} onClick={() => setSel({ kind: 'chapter', chapterNo: c.chapterNo })}
                label={`${fmt(t.studio.chapterNo, { n: c.chapterNo })} ${c.title}`} sub={[charName(c.povCharacterId), c.targetChars ? fmt(t.studio.storylineTab.charCount, { n: c.targetChars }) : null, c.status === 'stale' ? t.studio.stale : null].filter(Boolean).join(' · ') || undefined} />
            ))}
          </Section>
        </aside>

        <section className="flex min-h-0 flex-col overflow-hidden">
          {body ? (
            <>
              <div className="flex items-center justify-between gap-4 px-8 pt-6 pb-3">
                <h3 className="truncate font-serif text-lg font-semibold tracking-wide text-ink-900 dark:text-paper-100">{header}</h3>
                {actions}
              </div>
              <div className="flex-1 overflow-y-auto px-8 pb-8">
                <Card className="mx-auto max-w-2xl p-6">{body}</Card>
                <p className="mx-auto mt-3 max-w-2xl text-xs text-ink-400">{t.studio.storylineTab.autosaveHint}</p>
              </div>
            </>
          ) : loading ? (
            /* 新建一条之后要等重新读完才看得见它，这一小段别闪「已经不在了」 */
            <div className="flex flex-1 items-center justify-center text-sm text-ink-400" role="status"><Spinner className="mr-2" />{t.common.loading}</div>
          ) : (
            <EmptyState title={t.studio.storylineTab.goneTitle} description={t.studio.storylineTab.goneDesc} action={<Button size="sm" onClick={() => setSel({ kind: 'premise' })}>{t.studio.storylineTab.goneAction}</Button>} />
          )}
        </section>
      </div>

      <RewritePlanDialog novel={novel} open={rewriteOpen} onClose={() => setRewriteOpen(false)} onStarted={() => void refresh()} />
    </div>
  );
}

function Section({ title, count, onAdd, children }: { title: string; count: number; onAdd: () => void; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="mt-4">
      <div className="flex items-center gap-1 px-1">
        <button aria-expanded={open} className="flex flex-1 items-center gap-1 rounded-lg px-2 py-1 font-serif text-[11px] tracking-[0.2em] text-ink-500 hover:text-ink-800 dark:hover:text-paper-100" onClick={() => setOpen((v) => !v)}>
          {open ? <ChevronDown size={12} strokeWidth={1.75} aria-hidden="true" /> : <ChevronRight size={12} strokeWidth={1.75} aria-hidden="true" />}{title}<span className="ml-1 tracking-normal text-ink-400">{count}</span>
        </button>
        <IconButton label={`${t.common.add}${title}`} className="p-1" onClick={onAdd}><Plus size={14} strokeWidth={1.75} aria-hidden="true" /></IconButton>
      </div>
      {open && <ul className="mt-1" aria-label={title}>{children}</ul>}
    </div>
  );
}

function TreeItem({ active, onClick, label, sub }: { active: boolean; onClick: () => void; label: string; sub?: string }) {
  return (
    <li>
      <button aria-current={active ? 'true' : undefined} onClick={onClick} className={cn('mb-0.5 flex w-full flex-col items-start rounded-xl px-3 py-1.5 text-left text-sm transition', active ? 'bg-paper-0 font-medium text-ink-900 shadow-soft dark:bg-paper-800 dark:text-paper-50' : 'text-ink-700 hover:bg-paper-200/60 dark:text-ink-300 dark:hover:bg-paper-800/60')}>
        <span className="w-full truncate">{label || t.studio.unnamed}</span>
        {sub && <span className="w-full truncate text-[11px] font-normal text-ink-400">{sub}</span>}
      </button>
    </li>
  );
}
