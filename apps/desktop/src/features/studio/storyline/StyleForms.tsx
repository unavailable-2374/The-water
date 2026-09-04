import { useEffect, useState } from 'react';
import { Plus, Sparkles, X } from 'lucide-react';
import {
  DERIVATIVE_KIND_LABEL, DerivativeKind, SCENE_TYPE_LABEL, SceneType, VOICE_DIMENSIONS, VOICE_DIMENSION_LABEL, emptyDerivative, emptyStyleProfile,
  type DerivativeDecl, type StyleProfile,
} from '@the-water/shared';
import { Button, cn, confirm, Field, Input, Select, Spinner, Textarea } from '@/components/ui';
import { toast } from '@/components/Toast';
import type { Novel } from '@/db/repos/novelsRepo';
import { getStyleExtras } from '@/db/repos/storylineRepo';
import { saveDerivative, saveStyleProfile, startStyleExtraction } from '@/novel/service';
import { stylePresets } from '@/novel/stylePresets';
import { useAutosave } from './useAutosave';
import { splitLines, splitList } from './types';

const SOURCE_LABEL: Record<StyleProfile['source']['kind'], string> = { preset: '预设', extracted: '从正文提取', manual: '手动' };
const fmtRange = (r: [number, number] | null, pct = false) => (r ? (pct ? `${Math.round(r[0] * 100)}%–${Math.round(r[1] * 100)}%` : `${r[0]}–${r[1]}`) : '—');

// ---------------------------------------------------------------------------
// Style profile
// ---------------------------------------------------------------------------

export function StyleProfileForm({ novel, hasText, refreshKey, onSaved }: { novel: Novel; hasText: boolean; refreshKey?: number; onSaved: () => void }) {
  const [profile, setProfile] = useState<StyleProfile | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  useEffect(() => { void getStyleExtras(novel.id).then((x) => setProfile(x.styleProfile)); }, [novel.id, refreshKey]);

  const extract = async () => {
    setBusy(true);
    try { await startStyleExtraction(novel.id); toast.success('已排入拆书任务，提取完成后会自动更新这里'); }
    catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  if (profile === undefined) return <div className="flex items-center gap-2 text-sm text-ink-400"><Spinner />加载中…</div>;
  if (profile === null) {
    return (
      <div className="space-y-4">
        <p className="text-sm leading-relaxed text-ink-500">还没有文风档案。可以先挑一个预设，也可以让 AI 从正文里拆出这本书的味道。</p>
        <Field label="选一个预设开始">
          <Select defaultValue="" onChange={async (e) => { const p = stylePresets().find((x) => x.id === e.target.value); if (!p) return; await saveStyleProfile(novel.id, p); setProfile(p); onSaved(); }}>
            <option value="">请选择…</option>
            {stylePresets().map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        </Field>
        <div className="flex items-center gap-3">
          <Button variant="ai" disabled={!hasText || busy} onClick={extract}><Sparkles size={14} strokeWidth={1.75} />从正文提取文风</Button>
          <Button variant="ghost" onClick={async () => { const p = emptyStyleProfile({ id: 'manual', name: '我的文风' }); await saveStyleProfile(novel.id, p); setProfile(p); onSaved(); }}>从空白开始</Button>
          {!hasText && <span className="text-xs text-ink-400">有正文之后才能提取</span>}
        </div>
      </div>
    );
  }
  return <StyleProfileEditor key={profile.source.extractedAt ?? profile.id} novel={novel} profile={profile} hasText={hasText} busy={busy} onExtract={extract} onSaved={onSaved} />;
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
    { key: `style-${novel.id}` },
  );
  const p = form.profile;
  const setP = (patch: Partial<StyleProfile>, mode: 'debounce' | 'now' = 'debounce') => update({ profile: { ...p, ...patch } }, mode);
  const setVoice = (dim: (typeof VOICE_DIMENSIONS)[number], text: string) => setP({ voice: { ...p.voice, [dim]: { ...p.voice[dim], text } } });
  const setExemplar = (i: number, patch: Partial<StyleProfile['exemplars'][number]>, mode: 'debounce' | 'now' = 'debounce') =>
    setP({ exemplars: p.exemplars.map((e, j) => (j === i ? { ...e, ...patch } : e)) }, mode);
  const m = p.metrics;
  const t = p.targets;

  return (
    <div className="space-y-4" onBlur={flush}>
      <div className="flex flex-wrap items-center gap-2 text-xs text-ink-500">
        <span>来源：{SOURCE_LABEL[p.source.kind]}</span>
        {p.source.extractedAt && <span>· 提取于 {new Date(p.source.extractedAt).toLocaleString()}</span>}
        {p.source.chaptersSampled.length > 0 && <span>· 取样第 {p.source.chaptersSampled.join('、')} 章</span>}
        <span className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="ai" disabled={!hasText || busy} onClick={onExtract}><Sparkles size={14} strokeWidth={1.75} />{p.source.kind === 'extracted' ? '重新提取' : '从正文提取文风'}</Button>
          <Button size="sm" variant="ghost" className="text-cinnabar-600 dark:text-cinnabar-100" onClick={async () => { if (!(await confirm({ title: '清空文风档案？', description: '已学到的文风偏好会一并清除，无法撤销。', confirmText: '清空', tone: 'danger' }))) return; await saveStyleProfile(novel.id, null); onSaved(); }}>清空</Button>
        </span>
      </div>
      <Field label="名称"><Input value={p.name} onChange={(e) => setP({ name: e.target.value })} /></Field>
      <Field label="硬约束（每行一条）" hint="这是真正进入 AI 系统提示的部分，写成可直接照做的话，3–8 条"><Textarea rows={6} value={form.constraintsText} onChange={(e) => update({ constraintsText: e.target.value })} /></Field>

      {m && (
        <div className="rounded-2xl bg-paper-100/70 p-4 text-xs dark:bg-paper-800/60">
          <div className="mb-2 font-serif tracking-[0.2em] text-ink-500">本地统计（取样 {m.sampledChars.toLocaleString()} 字）· 目标区间</div>
          <dl className="grid grid-cols-[7rem_1fr_1fr] gap-y-1 text-ink-700 dark:text-ink-200">
            <dt className="text-ink-400">指标</dt><dd className="text-ink-400">原著</dd><dd className="text-ink-400">目标</dd>
            <dt>平均句长</dt><dd className="font-serif">{m.sentenceLength.mean} 字</dd><dd className="font-serif">{fmtRange(t.sentenceMean)}</dd>
            <dt>句长起伏</dt><dd className="font-serif">{m.burstiness}</dd><dd className="font-serif">{fmtRange(t.burstiness)}</dd>
            <dt>平均段长</dt><dd className="font-serif">{m.paragraphLength.mean} 字</dd><dd className="font-serif">{fmtRange(t.paragraphMean)}</dd>
            <dt>对白占比</dt><dd className="font-serif">{Math.round(m.dialogueRatio * 100)}%</dd><dd className="font-serif">{fmtRange(t.dialogueRatio, true)}</dd>
            <dt>感叹号 / 千字</dt><dd className="font-serif">{m.punctuationPerK['！'] ?? 0}</dd><dd className="font-serif">{fmtRange(t.exclamationPerK)}</dd>
            <dt>省略号 / 千字</dt><dd className="font-serif">{m.punctuationPerK['……'] ?? 0}</dd><dd className="font-serif">{fmtRange(t.ellipsisPerK)}</dd>
          </dl>
          {m.ngramSignature.length > 0 && <p className="mt-2 text-ink-500">高频词组：{m.ngramSignature.join('、')}</p>}
        </div>
      )}

      <div className="space-y-3">
        <div className="font-serif text-xs tracking-[0.2em] text-ink-500">腔调七维</div>
        {VOICE_DIMENSIONS.map((d) => (
          <Field key={d} label={VOICE_DIMENSION_LABEL[d]} hint={p.voice[d].evidence.length ? `例证：${p.voice[d].evidence.slice(0, 2).map((x) => `「${x}」`).join(' ')}` : undefined}>
            <Textarea rows={2} value={p.voice[d].text} onChange={(e) => setVoice(d, e.target.value)} />
          </Field>
        ))}
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="font-serif text-xs tracking-[0.2em] text-ink-500">示例段 <span className="tracking-normal text-ink-400">{p.exemplars.length}</span></span>
          <Button size="sm" variant="ghost" onClick={() => setP({ exemplars: [...p.exemplars, { id: `ex${Date.now()}`, sceneType: 'other', text: '', illustrates: [] }] }, 'now')}><Plus size={14} strokeWidth={1.75} />添加示例</Button>
        </div>
        {p.exemplars.length === 0 && <p className="text-xs text-ink-400">每次写章时会挑同场景类型的 2–3 段喂给 AI；例子比形容词管用。</p>}
        {p.exemplars.map((e, i) => (
          <div key={e.id} className="rounded-xl bg-paper-100/70 p-3 dark:bg-paper-800/60">
            <div className="mb-2 flex items-center gap-2">
              <Select className="max-w-[10rem]" value={e.sceneType} onChange={(ev) => setExemplar(i, { sceneType: ev.target.value as SceneType }, 'now')}>
                {SceneType.options.map((s) => <option key={s} value={s}>{SCENE_TYPE_LABEL[s]}</option>)}
              </Select>
              {e.illustrates.length > 0 && <span className="text-xs text-ink-400">体现：{e.illustrates.join('、')}</span>}
              <button className="ml-auto rounded-lg p-1 text-ink-400 hover:bg-paper-200 hover:text-cinnabar-600 dark:hover:bg-paper-800" aria-label="删除示例" onClick={() => setP({ exemplars: p.exemplars.filter((_, j) => j !== i) }, 'now')}><X size={14} strokeWidth={1.75} /></button>
            </div>
            <Textarea rows={5} className="font-serif" value={e.text} onChange={(ev) => setExemplar(i, { text: ev.target.value })} placeholder="150–400 字原文摘录" />
          </div>
        ))}
      </div>

      <div className="space-y-3">
        <div className="font-serif text-xs tracking-[0.2em] text-ink-500">负面清单</div>
        <Field label="禁用词" hint="用逗号或顿号分隔；出现即打回"><Input value={form.avoidWordsText} onChange={(e) => update({ avoidWordsText: e.target.value })} /></Field>
        <Field label="少用词" hint={`用逗号或顿号分隔；每千字超过 ${p.negatives.avoidWordsSoft.limitPerK} 次提示`}><Input value={form.avoidSoftText} onChange={(e) => update({ avoidSoftText: e.target.value })} /></Field>
        <Field label="禁用句式（每行一条）" hint="用 … 表示任意内容，如：不是…而是…"><Textarea rows={3} value={form.avoidPatternsText} onChange={(e) => update({ avoidPatternsText: e.target.value })} /></Field>
        <Field label="人物红线（每行一条）" hint="全书层面的红线；单个人物的红线写在人物卡里"><Textarea rows={3} value={form.redlinesText} onChange={(e) => update({ redlinesText: e.target.value })} /></Field>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Derivative declaration
// ---------------------------------------------------------------------------

export function DerivativeForm({ novel, onSaved }: { novel: Novel; onSaved: () => void }) {
  const [decl, setDecl] = useState<DerivativeDecl | undefined>(undefined);
  useEffect(() => { void getStyleExtras(novel.id).then((x) => setDecl(x.derivative ?? emptyDerivative())); }, [novel.id]);
  if (!decl) return <div className="flex items-center gap-2 text-sm text-ink-400"><Spinner />加载中…</div>;
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
    { key: `derivative-${novel.id}` },
  );
  return (
    <div className="space-y-3" onBlur={flush}>
      {novel.origin && <p className="text-xs text-ink-500">改编自《{novel.origin.sourceTitle}》（{novel.origin.sourceAuthorDisplayName}）。这份声明会随发布一起上传，也会进入每一章的 AI 提示。</p>}
      <div className="grid grid-cols-2 gap-3">
        <Field label="二创类型">
          <Select value={form.kind} onChange={(e) => update({ kind: e.target.value as DerivativeKind }, 'now')}>
            {DerivativeKind.options.map((k) => <option key={k} value={k}>{DERIVATIVE_KIND_LABEL[k]}</option>)}
          </Select>
        </Field>
        <Field label="目标读者">
          <div className="flex gap-4 pt-2 text-sm text-ink-800 dark:text-paper-100">
            <label className="inline-flex items-center gap-1.5"><input type="radio" checked={form.audience === 'fans'} onChange={() => update({ audience: 'fans' }, 'now')} />原著读者</label>
            <label className="inline-flex items-center gap-1.5"><input type="radio" checked={form.audience === 'general'} onChange={() => update({ audience: 'general' }, 'now')} />路人也读</label>
          </div>
        </Field>
      </div>
      <Field label="分歧点" hint="从原著哪一章 / 哪个事件之后开始分岔"><Input value={form.divergencePoint} onChange={(e) => update({ divergencePoint: e.target.value })} /></Field>
      <Field label="必须保持不变（每行一条）" hint="如：叙述腔调、主角性格、某条世界规矩、某件已发生的事"><Textarea rows={4} value={form.mustKeepText} onChange={(e) => update({ mustKeepText: e.target.value })} /></Field>
      <Field label="允许改动（每行一条）"><Textarea rows={3} value={form.allowedText} onChange={(e) => update({ allowedText: e.target.value })} /></Field>
      <Field label={`期望风格相似度：${Math.round(form.styleFidelity * 100)}%`} hint="越高，审校时的容差越窄；平行世界可以放宽到 70%">
        <input type="range" min={0.5} max={1} step={0.05} value={form.styleFidelity} onChange={(e) => update({ styleFidelity: Number(e.target.value) })} className={cn('w-full')} />
      </Field>
    </div>
  );
}
