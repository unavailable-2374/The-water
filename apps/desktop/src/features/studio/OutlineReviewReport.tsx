import { OutlineReviewStateSchema } from '@the-water/shared';
import { t } from '@/i18n';

export function OutlineReviewReport({ value }: { value: unknown }) {
  const parsed = OutlineReviewStateSchema.safeParse(value);
  if (!parsed.success) return <p className="mt-3 text-sm text-ink-500">{t.outlineReview.notReviewed}</p>;
  const { state, report, error } = parsed.data;
  if (state !== 'complete' || !report) return <div className="mt-3 text-sm" role="status"><p>{state === 'running' ? t.outlineReview.running : t.outlineReview.incomplete}</p>{error && <p role="alert" className="whitespace-pre-wrap">{error}</p>}</div>;
  const evidence = (rows: { location: string; excerpt: string }[]) => rows.map((e, i) => <p className="mt-1 text-xs text-ink-500" key={i}>{t.outlineReview.evidence} · {e.location}：“{e.excerpt}”</p>);
  return <section aria-label={t.outlineReview.title} className="mt-4 space-y-3 rounded-xl bg-paper-50 p-3 dark:bg-paper-950">
    <h3 className="font-medium">{t.outlineReview.title}</h3><p className="text-xs text-ink-500">{t.outlineReview.editorial}</p><p className="whitespace-pre-wrap text-sm">{report.summary}</p>
    <details><summary>{t.outlineReview.premise}</summary><dl className="mt-2 space-y-1 text-sm">{Object.entries(report.premise).map(([key, value]) => <div key={key}><dt className="text-ink-500">{t.outlineReview[key as keyof typeof t.outlineReview]}</dt><dd>{Array.isArray(value) ? value.join('；') : value}</dd></div>)}</dl></details>
    <details open={report.findings.length > 0}><summary>{t.outlineReview.findings} · {report.findings.length}</summary>{report.findings.map((f, i) => <article key={i} className="mt-3 border-t border-paper-200 pt-2 text-sm dark:border-paper-800"><h4 className="font-medium">{t.outlineReview[f.kind]} · {t.outlineReview[f.priority]} · {t.outlineReview[f.dimension]}</h4><p>{t.outlineReview.location}：{f.location}</p><p className="whitespace-pre-wrap">{f.problem}</p>{evidence(f.evidence)}<p>{t.outlineReview.impact}：{f.impact}</p><p>{t.outlineReview.suggestion}：{f.suggestion}</p></article>)}</details>
    <details><summary>{t.outlineReview.checks}</summary>{report.checks.map(c => <article className="mt-3 text-sm" key={c.dimension}><h4 className="font-medium">{t.outlineReview[c.dimension]} · {t.outlineReview[c.status]}</h4><p>{c.assessment}</p>{evidence(c.evidence)}</article>)}</details>
    <details><summary>{t.outlineReview.chains}</summary>{report.causalChains.map((c, i) => <div className="mt-3 text-sm" key={i}><strong>{c.location}</strong>{(['priorConditions','action','change','consequence'] as const).map(key => <p key={key}>{t.outlineReview[key]}：{c[key]}</p>)}</div>)}</details>
    <details><summary>{t.outlineReview.timeline}</summary>{report.timeline.map((e, i) => <div className="mt-3 text-sm" key={i}><strong>{e.event}</strong>{(['happensAt','characterLearnsAt','readerLearnsAt','materialOriginAndTransfer'] as const).map(key => <p key={key}>{t.outlineReview[key]}：{e[key]}</p>)}</div>)}</details>
    <details><summary>{t.outlineReview.prose}</summary>{report.proseValidation.map((v, i) => <p className="mt-2 text-sm" key={i}>{v}</p>)}</details>
  </section>;
}
