import type { FirstReading } from '@/llm/prompts/firstReading';
import { t } from '@/i18n';

export function FirstReadingPanel({ reading }: { reading: FirstReading }) {
  const labels = t.studio.firstReading;
  const evidence = (items: FirstReading['preserve'][number]['evidence']) => items.map((e, i) => <blockquote key={i}>#{e.chapterNo} · 「{e.evidence.quote}」</blockquote>);
  return <section className="space-y-2 text-sm">
    <h4 className="font-semibold">{labels.title}</h4><p className="text-xs text-ink-500">{labels.note}</p>
    {Object.entries(reading.observations).map(([key, item]) => <details key={key}><summary>{labels[key as keyof FirstReading['observations']]} · {labels[item.confidence]}</summary><p>{item.interpretation}</p>{evidence(item.evidence)}</details>)}
    {!!reading.inferenceChecks?.length&&<h5>{labels.inferenceChecks}</h5>}
    {reading.inferenceChecks?.map((item,i)=><details key={`inference-${i}`}><summary>{labels[item.status]} · {item.claim}</summary><p>{item.reason}</p>{evidence(item.evidence)}{evidence(item.basis)}</details>)}
    {reading.confusions.map((item, i) => <div key={i}><strong>{labels[item.effect]} · {item.question}</strong><p>{item.reason}</p>{evidence(item.evidence)}</div>)}
    {!!reading.preserve.length && <h5>{labels.preserve}</h5>}
    {reading.preserve.map((item, i) => <div key={i}><p>{item.reason}</p>{evidence(item.evidence)}</div>)}
  </section>;
}
