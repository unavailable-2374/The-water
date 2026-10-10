import type { DocumentPlanProposal } from '@/db/repos/planProposalsRepo';
import { fmt, t } from '@/i18n';

export function milestoneText(v: unknown): string | null {
  if (!v || typeof v !== 'object' || !('chapterNo' in v) || !('kind' in v) || !('detail' in v)) return null;
  const kind = v.kind === 'setup' ? t.studio.workbench.fields.setup : v.kind === 'progress' ? t.studio.workbench.fields.progression : v.kind === 'payoff' ? t.studio.workbench.fields.payoff : null;
  return kind && typeof v.detail === 'string' ? `${fmt(t.studio.chapterNo,{n:String(v.chapterNo)})} · ${kind}：${v.detail}` : null;
}

export interface PlanChange { title: string; before: string; after: string; empty?: boolean }
/** Human-readable changes; identifiers and raw serialized objects never become prose. */
export function documentChanges(p: DocumentPlanProposal, current: { title: string; logline: string }): PlanChange[] {
  const labels = t.studio.workbench.planSections;
  const value = (v: unknown): string => {
    if (v == null) return '';
    const milestone = milestoneText(v); if (milestone) return milestone;
    if (v === 'dramatize' || v === 'summarize') return t.studio.storyReview[v];
    if (Array.isArray(v)) return v.map(value).filter(Boolean).join('；');
    if (typeof v === 'object') return Object.entries(v).filter(([k]) => !k.endsWith('Id') && !k.endsWith('Ids') && k !== 'id').map(([, x]) => value(x)).filter(Boolean).join(' · ');
    return String(v);
  };
  const text = (row: object) => Object.entries(row)
    .filter(([k]) => !k.endsWith('Id') && !k.endsWith('Ids') && k !== 'id')
    .map(([, v]) => value(v)).filter(Boolean).join(' · ');
  const changes: PlanChange[] = [];
  const add = (key: keyof typeof labels, before: unknown, after: unknown) => {
    if (JSON.stringify(before) !== JSON.stringify(after)) changes.push({ title: labels[key], before: value(before), after: value(after) });
  };
  if (p.title?.trim()) add('title', current.title, p.title);
  if (typeof p.meta.logline === 'string') add('logline', current.logline, p.meta.logline);
  add('premise', p.before.premise, p.after.premise);
  add('themes', p.before.themes, p.after.themes);
  for (const key of ['characters', 'settings', 'arcs', 'beats', 'chapters'] as const) {
    for (const row of p.after[key]) {
      const before = p.before[key].find(r => 'id' in r && 'id' in row ? r.id === row.id : 'chapterNo' in r && 'chapterNo' in row && r.chapterNo === row.chapterNo);
      if (JSON.stringify(row) !== JSON.stringify(before)) changes.push({ title: labels[key], before: before ? text(before) : '', after: text(row) });
    }
    for (const row of p.before[key]) {
      const retained = p.after[key].some(r => 'id' in r && 'id' in row ? r.id === row.id : 'chapterNo' in r && 'chapterNo' in row && r.chapterNo === row.chapterNo);
      if (!retained) changes.push({ title: labels[key], before: text(row), after: '' });
    }
  }
  if (JSON.stringify(p.before.styleProfile) !== JSON.stringify(p.after.styleProfile)) changes.push({ title: labels.styleProfile, before: value(p.before.styleProfile), after: value(p.after.styleProfile) });
  for (const card of p.cards ?? []) {
    const fields = Object.entries(card.after.data).filter(([key]) => key !== 'rollingChapters');
    if (!fields.some(([, v]) => value(v).trim())) {
      changes.push({ title: t.studio.workbench[card.after.kind], before: '', after: t.studio.workbench.emptyPlanField, empty: true });
      continue;
    }
    const beforeData = card.before?.data as Record<string, unknown> | undefined;
    const readable = (data: Record<string, unknown>) => Object.entries(data).filter(([key, v]) => !key.endsWith('Id') && !key.endsWith('Ids') && key !== 'rollingChapters' && value(v).trim()).map(([key, v]) => `${t.studio.workbench.fields[key as keyof typeof t.studio.workbench.fields] ?? key}：${value(v)}`).join('\n');
    changes.push({ title: t.studio.workbench[card.after.kind], before: beforeData ? readable(beforeData) : '', after: readable(card.after.data as Record<string, unknown>) });
  }
  for (const card of p.retiredCards ?? []) changes.push({title:t.studio.workbench[card.before.kind],before:value(card.before.data),after:''});
  return changes;
}
