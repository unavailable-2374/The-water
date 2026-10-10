import { useState } from 'react';
import { Plus, Sparkles, X } from 'lucide-react';
import {
  DERIVATIVE_KIND_LABEL, DerivativeKind, SCENE_TYPE_LABEL, SceneType, VOICE_DIMENSIONS, VOICE_DIMENSION_LABEL, emptyDerivative, emptyStyleProfile,
  type DerivativeDecl, type StyleProfile,
} from '@the-water/shared';
import { fmt, t } from '@/i18n';
import { Button, IconButton, cn, confirm, Field, Input, Select, Spinner, Textarea } from '@/components/ui';
import { useAsyncData } from '@/components/data/useAsyncData';
import { toast } from '@/components/Toast';
import type { Novel } from '@/db/repos/novelsRepo';
import { getStyleExtras } from '@/db/repos/storylineRepo';
import { saveDerivative, saveStyleProfile, startStyleExtraction } from '@/novel/service';
import { stylePresets } from '@/novel/stylePresets';
import { useAutosave } from './useAutosave';
import { AuthorNoteForm, LearnedPhrasesPanel } from './WritingPrefs';
import { splitLines, splitList } from './types';

const fmtRange = (r: [number, number] | null, pct = false) => (r ? (pct ? `${Math.round(r[0] * 100)}%–${Math.round(r[1] * 100)}%` : `${r[0]}–${r[1]}`) : '—');

// ---------------------------------------------------------------------------
// Style profile
// ---------------------------------------------------------------------------

export function StyleProfileForm({ novel, hasText, refreshKey, onSaved }: { novel: Novel; hasText: boolean; refreshKey?: number; onSaved: () => void }) {
  const [busy, setBusy] = useState(false);
  const { data: profile, setData: setProfile, reload: reloadProfile } = useAsyncData<StyleProfile | null>(
    async () => (await getStyleExtras(novel.id)).styleProfile,
    { key: `styleProfileForm:${novel.id}:${refreshKey ?? 0}` },
  );

  const extract = async () => {
    setBusy(true);
    try { await startStyleExtraction(novel.id); toast.success(t.studio.style.extractQueued); }
    catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  if (profile === undefined) return <div className="flex items-center gap-2 text-sm text-ink-400" role="status"><Spinner />{t.common.loading}</div>;
  // 学习层面板与作者附加指令是文风档案的一部分，有没有 profile 都要能看到（§2.3 第 1、6 条）。
  const extras = (
    <div className="mt-6 space-y-6 border-t border-paper-300/60 pt-6 dark:border-paper-800">
      {/* 「用起来」会把短语写进少用词，所以要连带把文风档案重新读一遍 */}
      <LearnedPhrasesPanel novelId={novel.id} onSaved={() => { reloadProfile(); onSaved(); }} />
      <AuthorNoteForm novelId={novel.id} />
    </div>
  );
  if (profile === null) {
    return (
      <>
        <div className="space-y-4">
          <p className="text-sm leading-relaxed text-ink-500">{t.studio.style.none}</p>
          <Field label={t.studio.style.pickPreset}>
            <Select defaultValue="" onChange={async (e) => { const p = stylePresets().find((x) => x.id === e.target.value); if (!p) return; await saveStyleProfile(novel.id, p); setProfile(() => p); onSaved(); }}>
              <option value="">{t.studio.style.pickPresetPlaceholder}</option>
              {stylePresets().map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </Field>
          <div className="flex items-center gap-3">
            <Button variant="ai" disabled={!hasText || busy} onClick={extract}><Sparkles size={14} strokeWidth={1.75} aria-hidden="true" />{t.studio.style.extract}</Button>
            <Button variant="ghost" onClick={async () => { const p = emptyStyleProfile({ id: 'manual', name: t.studio.style.blankName }); await saveStyleProfile(novel.id, p); setProfile(() => p); onSaved(); }}>{t.studio.style.fromBlank}</Button>
            {!hasText && <span className="text-xs text-ink-400">{t.studio.style.needText}</span>}
          </div>
        </div>
        {extras}
      </>
    );
  }
  return (
    <>
      <StyleProfileEditor key={profile.source.extractedAt ?? profile.id} novel={novel} profile={profile} hasText={hasText} busy={busy} onExtract={extract} onSaved={onSaved} />
      {extras}
    </>
  );
}

function StyleProfileEditor({ novel, profile, hasText, busy, onExtract, onSaved }: { novel: Novel; profile: StyleProfile; hasText: boolean; busy: boolean; onExtract: () => void; onSaved: () => void }) {
  const { form, update, flush } = useAutosave(
    {
      profile,
      constraintsText: profile.injection.humanReadableConstraints.join('\n'),
      avoidWordsText: profile.negatives.avoidWords.join('、'),
      avoidSoftText: profile.negatives.avoidWordsSoft.list.join('、'),
      avoidPatternsText: profile.negatives.avoidPatterns.join('\n'),
      redlinesText: profile.negatives.oocRedlines.join('\n'),
    },
    async (f) => {
      const next: StyleProfile = {
        ...f.profile,
        injection: { ...f.profile.injection, humanReadableConstraints: splitLines(f.constraintsText) },
        negatives: {
          ...f.profile.negatives,
          avoidWords: splitList(f.avoidWordsText),
          avoidWordsSoft: { ...f.profile.negatives.avoidWordsSoft, list: splitList(f.avoidSoftText) },
          avoidPatterns: splitLines(f.avoidPatternsText),
          oocRedlines: splitLines(f.redlinesText),
        },
      };
      await saveStyleProfile(novel.id, next);
      onSaved();
    },
    { key: `style-${novel.id}`, novelId:novel.id },
  );
  const p = form.profile;
  const setP = (patch: Partial<StyleProfile>, mode: 'debounce' | 'now' = 'debounce') => update({ profile: { ...p, ...patch } }, mode);
  const setVoice = (dim: (typeof VOICE_DIMENSIONS)[number], text: string) => setP({ voice: { ...p.voice, [dim]: { ...p.voice[dim], text } } });
  const setExemplar = (i: number, patch: Partial<StyleProfile['exemplars'][number]>, mode: 'debounce' | 'now' = 'debounce') =>
    setP({ exemplars: p.exemplars.map((e, j) => (j === i ? { ...e, ...patch } : e)) }, mode);
  const m = p.metrics;
  const target = p.targets;

  return (
    <div className="space-y-4" onBlur={flush}>
      <div className="flex flex-wrap items-center gap-2 text-xs text-ink-500">
        <span>{fmt(t.studio.style.sourceFrom, { kind: t.studio.style.sourceLabel[p.source.kind] })}</span>
        {p.source.extractedAt && <span>{fmt(t.studio.style.extractedAt, { time: new Date(p.source.extractedAt).toLocaleString() })}</span>}
        {p.source.chaptersSampled.length > 0 && <span>{fmt(t.studio.style.sampledChapters, { list: p.source.chaptersSampled.join('、') })}</span>}
        <span className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="ai" disabled={!hasText || busy} onClick={onExtract}><Sparkles size={14} strokeWidth={1.75} aria-hidden="true" />{p.source.kind === 'extracted' ? t.studio.style.reextract : t.studio.style.extract}</Button>
          <Button size="sm" variant="ghost" className="text-cinnabar-600 dark:text-cinnabar-100" onClick={async () => { if (!(await confirm({ title: t.studio.style.clearTitle, description: t.studio.style.clearDesc, confirmText: t.studio.style.clear, tone: 'danger' }))) return; await saveStyleProfile(novel.id, null); onSaved(); }}>{t.studio.style.clear}</Button>
        </span>
      </div>
      <Field label={t.studio.style.profileName}><Input value={p.name} onChange={(e) => setP({ name: e.target.value })} /></Field>
      <Field label={t.studio.style.constraints} hint={t.studio.style.constraintsHint}><Textarea rows={6} value={form.constraintsText} onChange={(e) => update({ constraintsText: e.target.value })} /></Field>

      {m && (
        <div className="rounded-2xl bg-paper-100/70 p-4 text-xs dark:bg-paper-800/60">
          <div className="mb-2 font-serif tracking-[0.2em] text-ink-500">{fmt(t.studio.style.metricsTitle, { n: m.sampledChars.toLocaleString() })}</div>
          <dl className="grid grid-cols-[7rem_1fr_1fr] gap-y-1 text-ink-700 dark:text-ink-200">
            <dt className="text-ink-400">{t.studio.style.metricName}</dt><dd className="text-ink-400">{t.studio.style.metricSource}</dd><dd className="text-ink-400">{t.studio.style.metricTarget}</dd>
            <dt>{t.studio.style.sentenceMean}</dt><dd className="font-serif">{m.sentenceLength.mean}{t.studio.style.charsUnit}</dd><dd className="font-serif">{fmtRange(target.sentenceMean)}</dd>
            <dt>{t.studio.style.burstiness}</dt><dd className="font-serif">{m.burstiness}</dd><dd className="font-serif">{fmtRange(target.burstiness)}</dd>
            <dt>{t.studio.style.paragraphMean}</dt><dd className="font-serif">{m.paragraphLength.mean}{t.studio.style.charsUnit}</dd><dd className="font-serif">{fmtRange(target.paragraphMean)}</dd>
            <dt>{t.studio.style.dialogueRatio}</dt><dd className="font-serif">{Math.round(m.dialogueRatio * 100)}%</dd><dd className="font-serif">{fmtRange(target.dialogueRatio, true)}</dd>
            <dt>{t.studio.style.exclamationPerK}</dt><dd className="font-serif">{m.punctuationPerK['！'] ?? 0}</dd><dd className="font-serif">{fmtRange(target.exclamationPerK)}</dd>
            <dt>{t.studio.style.ellipsisPerK}</dt><dd className="font-serif">{m.punctuationPerK['……'] ?? 0}</dd><dd className="font-serif">{fmtRange(target.ellipsisPerK)}</dd>
          </dl>
          {m.ngramSignature.length > 0 && <p className="mt-2 text-ink-500">{fmt(t.studio.style.ngram, { list: m.ngramSignature.join('、') })}</p>}
        </div>
      )}

      <div className="space-y-3">
        <div className="font-serif text-xs tracking-[0.2em] text-ink-500">{t.studio.style.voiceTitle}</div>
        {VOICE_DIMENSIONS.map((d) => (
          <Field key={d} label={VOICE_DIMENSION_LABEL[d]} hint={p.voice[d].evidence.length ? fmt(t.studio.style.voiceEvidence, { list: p.voice[d].evidence.slice(0, 2).map((x) => `「${x}」`).join(' ') }) : undefined}>
            <Textarea rows={2} value={p.voice[d].text} onChange={(e) => setVoice(d, e.target.value)} />
          </Field>
        ))}
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="font-serif text-xs tracking-[0.2em] text-ink-500">{t.studio.style.exemplars} <span className="tracking-normal text-ink-400">{p.exemplars.length}</span></span>
          <Button size="sm" variant="ghost" onClick={() => setP({ exemplars: [...p.exemplars, { id: `ex${Date.now()}`, sceneType: 'other', text: '', illustrates: [] }] }, 'now')}><Plus size={14} strokeWidth={1.75} aria-hidden="true" />{t.studio.style.addExemplar}</Button>
        </div>
        {p.exemplars.length === 0 && <p className="text-xs text-ink-400">{t.studio.style.exemplarsEmpty}</p>}
        {p.exemplars.map((e, i) => (
          <div key={e.id} className="rounded-xl bg-paper-100/70 p-3 dark:bg-paper-800/60">
            <div className="mb-2 flex items-center gap-2">
              <Select aria-label={t.studio.style.exemplars} className="max-w-[10rem]" value={e.sceneType} onChange={(ev) => setExemplar(i, { sceneType: ev.target.value as SceneType }, 'now')}>
                {SceneType.options.map((s) => <option key={s} value={s}>{SCENE_TYPE_LABEL[s]}</option>)}
              </Select>
              {e.illustrates.length > 0 && <span className="text-xs text-ink-400">{fmt(t.studio.style.exemplarIllustrates, { list: e.illustrates.join('、') })}</span>}
              <IconButton label={t.studio.style.deleteExemplar} className="ml-auto p-1 hover:text-cinnabar-600" onClick={() => setP({ exemplars: p.exemplars.filter((_, j) => j !== i) }, 'now')}><X size={14} strokeWidth={1.75} aria-hidden="true" /></IconButton>
            </div>
            <Textarea rows={5} aria-label={t.studio.style.exemplarPlaceholder} className="font-serif" value={e.text} onChange={(ev) => setExemplar(i, { text: ev.target.value })} placeholder={t.studio.style.exemplarPlaceholder} />
          </div>
        ))}
      </div>

      <div className="space-y-3">
        <div className="font-serif text-xs tracking-[0.2em] text-ink-500">{t.studio.style.negatives}</div>
        <Field label={t.studio.style.avoidWords} hint={t.studio.style.avoidWordsHint}><Input value={form.avoidWordsText} onChange={(e) => update({ avoidWordsText: e.target.value })} /></Field>
        <Field label={t.studio.style.avoidSoft} hint={fmt(t.studio.style.avoidSoftHint, { n: p.negatives.avoidWordsSoft.limitPerK })}><Input value={form.avoidSoftText} onChange={(e) => update({ avoidSoftText: e.target.value })} /></Field>
        <Field label={t.studio.style.avoidPatterns} hint={t.studio.style.avoidPatternsHint}><Textarea rows={3} value={form.avoidPatternsText} onChange={(e) => update({ avoidPatternsText: e.target.value })} /></Field>
        <Field label={t.studio.style.styleRedlines} hint={t.studio.style.styleRedlinesHint}><Textarea rows={3} value={form.redlinesText} onChange={(e) => update({ redlinesText: e.target.value })} /></Field>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Derivative declaration
// ---------------------------------------------------------------------------

export function DerivativeForm({ novel, onSaved }: { novel: Novel; onSaved: () => void }) {
  const { data: decl } = useAsyncData<DerivativeDecl>(
    async () => (await getStyleExtras(novel.id)).derivative ?? emptyDerivative(),
    { key: `derivativeDecl:${novel.id}` },
  );
  if (!decl) return <div className="flex items-center gap-2 text-sm text-ink-400" role="status"><Spinner />{t.common.loading}</div>;
  return <DerivativeEditor novel={novel} decl={decl} onSaved={onSaved} />;
}

function DerivativeEditor({ novel, decl, onSaved }: { novel: Novel; decl: DerivativeDecl; onSaved: () => void }) {
  const { form, update, flush } = useAutosave(
    { ...decl, mustKeepText: decl.mustKeep.join('\n'), allowedText: decl.allowedChanges.join('\n') },
    async (f) => {
      const { mustKeepText, allowedText, ...rest } = f;
      await saveDerivative(novel.id, { ...rest, mustKeep: splitLines(mustKeepText), allowedChanges: splitLines(allowedText) });
      onSaved();
    },
    { key: `derivative-${novel.id}`, novelId:novel.id },
  );
  return (
    <div className="space-y-3" onBlur={flush}>
      {novel.origin && <p className="text-xs text-ink-500">{fmt(t.studio.derivative.intro, { title: novel.origin.sourceTitle, author: novel.origin.sourceAuthorDisplayName })}</p>}
      <div className="grid grid-cols-2 gap-3">
        <Field label={t.studio.derivative.kind}>
          <Select value={form.kind} onChange={(e) => update({ kind: e.target.value as DerivativeKind }, 'now')}>
            {DerivativeKind.options.map((k) => <option key={k} value={k}>{DERIVATIVE_KIND_LABEL[k]}</option>)}
          </Select>
        </Field>
        <Field label={t.studio.derivative.audience}>
          <div className="flex gap-4 pt-2 text-sm text-ink-800 dark:text-paper-100">
            <label className="inline-flex items-center gap-1.5"><input type="radio" checked={form.audience === 'fans'} onChange={() => update({ audience: 'fans' }, 'now')} />{t.studio.derivative.audienceFans}</label>
            <label className="inline-flex items-center gap-1.5"><input type="radio" checked={form.audience === 'general'} onChange={() => update({ audience: 'general' }, 'now')} />{t.studio.derivative.audienceGeneral}</label>
          </div>
        </Field>
      </div>
      <Field label={t.studio.derivative.divergence} hint={t.studio.derivative.divergenceHint}><Input value={form.divergencePoint} onChange={(e) => update({ divergencePoint: e.target.value })} /></Field>
      <Field label={t.studio.derivative.mustKeep} hint={t.studio.derivative.mustKeepHint}><Textarea rows={4} value={form.mustKeepText} onChange={(e) => update({ mustKeepText: e.target.value })} /></Field>
      <Field label={t.studio.derivative.allowed}><Textarea rows={3} value={form.allowedText} onChange={(e) => update({ allowedText: e.target.value })} /></Field>
      <Field label={fmt(t.studio.derivative.fidelity, { pct: Math.round(form.styleFidelity * 100) })} hint={t.studio.derivative.fidelityHint}>
        <input type="range" min={0.5} max={1} step={0.05} value={form.styleFidelity} onChange={(e) => update({ styleFidelity: Number(e.target.value) })} className={cn('w-full')} />
      </Field>
    </div>
  );
}
