import { docTypeGuide } from '@/novel/docTypes';
import { OutlineReviewReport } from './OutlineReviewReport';
import { reviewOutlineProposal } from '@/novel/outlineReview';
import { useRef, useState } from 'react';
import { ActivityStatus } from '@/components/Activity';
import { Button, Badge } from '@/components/ui';
import { toast } from '@/components/Toast';
import { fmt, t } from '@/i18n';
import type { Novel } from '@/db/repos/novelsRepo';
import type { Chapter } from '@/db/repos/chaptersRepo';
import { acceptDocumentPlan, documentPlanIssue, type DocumentPlanProposal } from '@/db/repos/planProposalsRepo';
import { acceptPlanProposal, discardProposal, type PlanProposal } from '@/db/repos/writingRepo';
import { documentChanges, milestoneText } from './documentPlanPreview';

function fieldValue(value: unknown): string {
  if (value == null) return '';
  const milestone = milestoneText(value); if (milestone) return milestone;
  if (value === 'dramatize' || value === 'summarize') return t.studio.storyReview[value];
  if (Array.isArray(value)) return value.map(v => typeof v === 'object' && v && 'chapterNo' in v && 'change' in v ? `${fmt(t.studio.chapterNo, {n:v.chapterNo})}：${v.change}` : fieldValue(v)).filter(Boolean).join('\n');
  return typeof value === 'object' ? '' : String(value);
}

/** A shared review surface on the page that requested the work. */
export function PlanReview({ novel, documents = [], cards = [], chapters = [], onResolved }: {
  novel: Novel; documents?: DocumentPlanProposal[]; cards?: PlanProposal[]; chapters?: Chapter[];
  onResolved?: () => Promise<void> | void;
}) {
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const [resolved, setResolved] = useState<Set<string>>(new Set());
  const act = async (ids: string[], fn: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true; setBusy(true);
    try {
      await fn();
      setResolved(previous => new Set([...previous, ...ids]));
      await onResolved?.();
    } catch (error) { toast.error(error instanceof Error ? error.message : String(error)); }
    finally { lock.current = false; setBusy(false); }
  };
  const review = async (id: string) => {
    if (lock.current) return;
    lock.current = true; setBusy(true);
    try { await reviewOutlineProposal(novel.id, id, { force: true }); }
    catch (error) { toast.error(error instanceof Error ? error.message : String(error)); }
    finally { try { await onResolved?.(); } finally { lock.current = false; setBusy(false); } }
  };
  const pendingDocs = documents.filter(p => !resolved.has(p.id));
  const pendingCards = cards.filter(p => !resolved.has(p.id));
  if (!pendingDocs.length && !pendingCards.length) return null;
  const groups = new Map<string | null, PlanProposal[]>();
  for (const p of pendingCards) groups.set(p.chapterId, [...(groups.get(p.chapterId) ?? []), p]);
  return <section id="generated-review" aria-label={t.studio.workflow.reviewTitle} className="space-y-4">
    {busy && <ActivityStatus label={t.common.processing} />}
    {pendingDocs.map(p => {
      const isTable = p.meta.tableDone === true;
      const title = p.meta.outlineReviewOnly ? t.outlineReview.title : isTable ? t.studio.planning.chapterTable : p.meta.outlineDone ? t.studio.planning.outline : p.label;
      const acceptLabel = isTable ? t.studio.workflow.acceptTable : p.meta.outlineDone ? t.studio.workflow.acceptOutline : t.studio.workbench.adoptPlan;
      const changes = documentChanges(p, { title: novel.title, logline: novel.meta.logline });
      const sections = new Map<string, typeof changes>();
      for (const change of changes) sections.set(change.title, [...(sections.get(change.title) ?? []), change]);
      const issue = documentPlanIssue(p);
      return <article key={p.id} className="rounded-2xl border border-tea-200 bg-paper-0 p-5 shadow-soft dark:border-tea-800 dark:bg-paper-900">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-base font-semibold">{title}</h2><Badge tone="amber">{t.studio.workflow.pendingReview}</Badge>
          <div className="ml-auto flex flex-wrap gap-2">
            <>{p.meta.outlineDone === true && docTypeGuide(novel.requirements.docType).fiction && <Button disabled={busy} onClick={() => void review(p.id)}>{p.meta.outlineReview ? t.outlineReview.retry : t.outlineReview.check}</Button>}</>{!p.meta.outlineReviewOnly && <Button variant="primary" disabled={busy || !!issue} onClick={() => void act([p.id], () => acceptDocumentPlan(novel.id, p.id))}>{acceptLabel}</Button>}
            <Button disabled={busy} onClick={() => void act([p.id], () => discardProposal(p.id))}>{p.meta.outlineReviewOnly ? t.outlineReview.closeReport : t.studio.workbench.discardPlan}</Button>
          </div>
        </div>
        <p className="mt-2 text-xs text-ink-500">{p.meta.outlineReviewOnly ? t.outlineReview.readOnlyHint : t.studio.workflow.reviewHint}</p>
        {p.meta.storyOptionSelectionId != null && <p className="mt-2 text-sm">{t.storyOptions.hint}</p>}
        {Array.isArray(p.meta.downstreamImpact) && p.meta.downstreamImpact.map((impact, i) => <p className="mt-2 text-sm" key={i}>{String(impact)}</p>)}
        {issue && !p.meta.outlineReviewOnly && <p role="alert" className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-200">{issue}</p>}
        {p.meta.outlineDone === true && docTypeGuide(novel.requirements.docType).fiction && <OutlineReviewReport value={p.meta.outlineReview} />}
        <div className="mt-4 space-y-2">
          {[...sections].map(([heading, rows]) => <details key={heading} open={heading === t.studio.workbench.planSections.logline || heading === t.studio.workbench.brief} className="rounded-xl bg-paper-50 p-3 dark:bg-paper-950">
            <summary className="cursor-pointer text-sm font-medium">{heading} <span className="ml-1 text-xs text-ink-400">{rows.length}</span></summary>
            {rows.map((change, i) => <div key={i} className="mt-3 border-t border-paper-200 pt-3 text-sm dark:border-paper-800">
              {change.before && <details className="mb-2 text-ink-500"><summary className="cursor-pointer text-xs">{t.studio.workbench.before}</summary><del className="block whitespace-pre-wrap">{change.before}</del></details>}
              <p className="whitespace-pre-wrap leading-relaxed">{change.after || t.studio.workflow.removed}</p>
            </div>)}
          </details>)}
        </div>
      </article>;
    })}
    {[...groups].map(([chapterId, proposals]) => <article key={chapterId ?? 'general'} className="rounded-2xl border border-tea-200 bg-paper-0 p-5 dark:border-tea-800 dark:bg-paper-900">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-base font-semibold">{chapterId ? fmt(t.studio.chapterNo, { n: chapters.find(c => c.id === chapterId)?.chapterNo ?? '—' }) : t.studio.workbench.proposals}{proposals.every(p => p.card.kind === 'scene') ? ` · ${t.studio.workbench.scene}` : ''}</h2>
        <Badge tone="amber">{t.studio.workflow.pendingReview}</Badge>
        <Button variant="primary" className="ml-auto" disabled={busy} onClick={() => void act(proposals.map(p => p.id), async () => { for (const p of proposals) await acceptPlanProposal(novel.id, p.id); })}>{proposals.every(p => p.card.kind === 'scene') ? t.studio.workflow.acceptScenes : t.studio.workflow.acceptSuggestions}</Button>
      </div>
      <p className="mt-2 text-xs text-ink-500">{proposals.every(p => p.card.kind === 'scene') ? t.studio.workflow.sceneReviewHint : t.studio.workflow.cardReviewHint}</p>
      {proposals.map(p => <div key={p.id} className="mt-4 border-t border-paper-200 pt-3 dark:border-paper-800">
        <h3 className="font-medium">{'title' in p.card.data ? p.card.data.title : t.studio.workbench[p.card.kind]}</h3>
        <dl className="mt-2 space-y-2 text-sm">{Object.entries(p.card.data).filter(([key, value]) => !key.endsWith('Id') && !key.endsWith('Ids') && fieldValue(value)).map(([key, value]) => <div key={key}><dt className="text-xs text-ink-500">{t.studio.workbench.fields[key as keyof typeof t.studio.workbench.fields] ?? key}</dt><dd className="whitespace-pre-wrap">{fieldValue(value)}</dd></div>)}</dl>
        <div className="mt-3 flex gap-2"><Button size="sm" disabled={busy} onClick={() => void act([p.id], () => acceptPlanProposal(novel.id, p.id))}>{t.studio.workbench.accept}</Button><Button size="sm" disabled={busy} onClick={() => void act([p.id], () => discardProposal(p.id))}>{t.studio.workbench.discard}</Button></div>
      </div>)}
    </article>)}
  </section>;
}
