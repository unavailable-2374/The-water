import { Plus, X } from 'lucide-react';
import type { Arc, Beat, Character, Setting, SettingKind } from '@the-water/shared';
import { Button, Field, Input, Select, Textarea } from '@/components/ui';
import { type Chapter, upsertChapterPlan } from '@/db/repos/chaptersRepo';
import { type Novel, updateNovel } from '@/db/repos/novelsRepo';
import { upsertArc, upsertBeat, upsertCharacter, upsertSetting } from '@/db/repos/storylineRepo';
import { useAutosave } from './useAutosave';
import { SETTING_KIND_LABEL, keyValueLines, parseKeyValueLines, splitLines, splitList, type StorylineData } from './types';

interface FormProps { novelId: string; data: StorylineData; onSaved: () => void }

const toInt = (raw: string, fallback: number): number => {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
};

export function CheckList({ options, value, onChange, empty }: { options: Array<{ id: string; label: string }>; value: string[]; onChange: (next: string[]) => void; empty: string }) {
  if (options.length === 0) return <p className="text-xs text-ink-400">{empty}</p>;
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1.5 rounded-xl bg-paper-100 px-3 py-2.5 dark:bg-paper-800">
      {options.map((o) => {
        const checked = value.includes(o.id);
        return (
          <label key={o.id} className="inline-flex items-center gap-1.5 text-sm text-ink-800 dark:text-paper-100">
            <input type="checkbox" checked={checked} onChange={() => onChange(checked ? value.filter((v) => v !== o.id) : [...value, o.id])} />
            <span className="truncate">{o.label}</span>
          </label>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Premise & themes
// ---------------------------------------------------------------------------

export function PremiseForm({ novel, onSaved }: { novel: Novel; onSaved: () => void }) {
  const { form, update, flush } = useAutosave(
    { premise: novel.premise, themesText: novel.meta.themes.join('、') },
    async (f) => { await updateNovel(novel.id, { premise: f.premise, meta: { ...novel.meta, themes: splitList(f.themesText) } }); onSaved(); },
  );
  return (
    <div className="space-y-3" onBlur={flush}>
      <Field label="故事前提" hint="改了前提之后，可以点「看看哪些章节需要改」，看看正文要不要跟着动。"><Textarea rows={12} value={form.premise} onChange={(e) => update({ premise: e.target.value })} /></Field>
      <Field label="主题" hint="用逗号或顿号分隔"><Input value={form.themesText} onChange={(e) => update({ themesText: e.target.value })} /></Field>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Character
// ---------------------------------------------------------------------------

export function CharacterForm({ novelId, character, index, data, onSaved }: FormProps & { character: Character; index: number }) {
  const { form, update, flush } = useAutosave(
    { ...character, aliasesText: character.aliases.join('、'), speechText: character.speechSamples.join('\n'), ticsText: character.verbalTics.join('、'), addressText: keyValueLines(character.addressBook), redlinesText: character.redlines.join('\n') },
    async (f) => {
      await upsertCharacter(novelId, {
        id: f.id, name: f.name.trim() || '未命名', aliases: splitList(f.aliasesText), role: f.role, description: f.description, arc: f.arc,
        relationships: f.relationships.filter((r) => r.targetId),
        speechSamples: splitLines(f.speechText), verbalTics: splitList(f.ticsText), addressBook: parseKeyValueLines(f.addressText), redlines: splitLines(f.redlinesText),
      }, index);
      onSaved();
    },
    { key: character.id },
  );
  const others = data.characters.filter((c) => c.id !== character.id);
  const setRel = (i: number, patch: Partial<Character['relationships'][number]>, mode: 'debounce' | 'now') =>
    update({ relationships: form.relationships.map((r, j) => (j === i ? { ...r, ...patch } : r)) }, mode);

  return (
    <div className="space-y-3" onBlur={flush}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="姓名"><Input value={form.name} onChange={(e) => update({ name: e.target.value })} /></Field>
        <Field label="角色定位" hint="如：主角、反派、导师"><Input value={form.role} onChange={(e) => update({ role: e.target.value })} /></Field>
      </div>
      <Field label="别名" hint="用逗号或顿号分隔；改名后，AI 会把正文里的名字一起换掉"><Input value={form.aliasesText} onChange={(e) => update({ aliasesText: e.target.value })} /></Field>
      <Field label="人物描述"><Textarea rows={5} value={form.description} onChange={(e) => update({ description: e.target.value })} /></Field>
      <Field label="人物弧线"><Textarea rows={4} value={form.arc} onChange={(e) => update({ arc: e.target.value })} /></Field>
      <div className="rounded-2xl bg-paper-100/70 p-4 dark:bg-paper-800/60">
        <div className="mb-3 font-serif text-xs tracking-[0.2em] text-ink-500">言行规格 · 二创保味道的关键</div>
        <div className="space-y-3">
          <Field label="说话样本（每行一句原话）" hint="至少 5 句，覆盖平静、愤怒、玩笑、撒谎、对亲近的人"><Textarea rows={5} value={form.speechText} onChange={(e) => update({ speechText: e.target.value })} /></Field>
          <Field label="口头禅 / 惯用句式" hint="用逗号或顿号分隔"><Input value={form.ticsText} onChange={(e) => update({ ticsText: e.target.value })} /></Field>
          <Field label="称呼表（每行 键=值）" hint="如：自称=在下、称呼师父=师父、被师父称呼=小子"><Textarea rows={3} value={form.addressText} onChange={(e) => update({ addressText: e.target.value })} /></Field>
          <Field label="红线（每行一条）" hint="这个人绝不会做的事，审校时直接据此判定出戏"><Textarea rows={3} value={form.redlinesText} onChange={(e) => update({ redlinesText: e.target.value })} /></Field>
        </div>
      </div>
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium tracking-wide text-ink-600 dark:text-ink-300">人物关系 <span className="font-serif text-ink-400">{form.relationships.length}</span></span>
          <Button size="sm" variant="ghost" disabled={others.length === 0} onClick={() => update({ relationships: [...form.relationships, { targetId: others[0]?.id ?? '', kind: '', note: '' }] }, 'now')}>
            <Plus size={14} strokeWidth={1.75} />添加关系
          </Button>
        </div>
        {form.relationships.length === 0 && <p className="text-xs text-ink-400">{others.length === 0 ? '还没有其他人物可建立关系。' : '暂无关系。'}</p>}
        {form.relationships.map((r, i) => (
          <div key={i} className="grid grid-cols-[1fr_120px_1fr_28px] items-center gap-2">
            <Select value={r.targetId} onChange={(e) => setRel(i, { targetId: e.target.value }, 'now')}>
              {!others.some((c) => c.id === r.targetId) && <option value={r.targetId}>{r.targetId ? '（已删除的人物）' : '选择人物…'}</option>}
              {others.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
            <Input placeholder="关系" value={r.kind} onChange={(e) => setRel(i, { kind: e.target.value }, 'debounce')} />
            <Input placeholder="备注" value={r.note} onChange={(e) => setRel(i, { note: e.target.value }, 'debounce')} />
            <button className="rounded-lg p-1 text-ink-400 hover:bg-paper-200 hover:text-cinnabar-600 dark:hover:bg-paper-800" aria-label="删除关系" onClick={() => update({ relationships: form.relationships.filter((_, j) => j !== i) }, 'now')}><X size={14} strokeWidth={1.75} /></button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Setting
// ---------------------------------------------------------------------------

export function SettingForm({ novelId, setting, index, onSaved }: FormProps & { setting: Setting; index: number }) {
  const { form, update, flush } = useAutosave({ ...setting, triggerText: setting.triggerKeys.join('、') }, async (f) => {
    await upsertSetting(novelId, { id: f.id, name: f.name.trim() || '未命名', kind: f.kind, description: f.description, triggerKeys: splitList(f.triggerText), priority: Math.max(0, Math.min(100, f.priority)), constant: f.constant }, index);
    onSaved();
  }, { key: setting.id });
  return (
    <div className="space-y-3" onBlur={flush}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="名称"><Input value={form.name} onChange={(e) => update({ name: e.target.value })} /></Field>
        <Field label="类型">
          <Select value={form.kind} onChange={(e) => update({ kind: e.target.value as SettingKind }, 'now')}>
            {(Object.keys(SETTING_KIND_LABEL) as SettingKind[]).map((k) => <option key={k} value={k}>{SETTING_KIND_LABEL[k]}</option>)}
          </Select>
        </Field>
      </div>
      <Field label="描述"><Textarea rows={8} value={form.description} onChange={(e) => update({ description: e.target.value })} /></Field>
      <div className="rounded-2xl bg-paper-100/70 p-4 dark:bg-paper-800/60">
        <div className="mb-3 font-serif text-xs tracking-[0.2em] text-ink-500">注入规则 · 命中触发词才喂给 AI</div>
        <div className="space-y-3">
          <Field label="触发词" hint="用逗号或顿号分隔；本章计划或前文摘要里出现任一触发词就注入。留空则只在情节点引用时注入"><Input value={form.triggerText} onChange={(e) => update({ triggerText: e.target.value })} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="优先级（0–100）" hint="高者先注入"><Input type="number" min={0} max={100} value={form.priority} onChange={(e) => update({ priority: toInt(e.target.value, 50) })} /></Field>
            <label className="flex items-center gap-2 pt-6 text-sm text-ink-800 dark:text-paper-100">
              <input type="checkbox" checked={form.constant} onChange={(e) => update({ constant: e.target.checked }, 'now')} />常驻（每章必注）
            </label>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Arc
// ---------------------------------------------------------------------------

export function ArcForm({ novelId, arc, index, onSaved }: FormProps & { arc: Arc; index: number }) {
  const { form, update, flush } = useAutosave(arc, async (f) => {
    await upsertArc(novelId, { id: f.id, title: f.title.trim() || '未命名', summary: f.summary, startChapterNo: Math.max(1, f.startChapterNo), endChapterNo: Math.max(f.startChapterNo, f.endChapterNo, 1) }, index);
    onSaved();
  }, { key: arc.id });
  return (
    <div className="space-y-3" onBlur={flush}>
      <Field label="标题"><Input value={form.title} onChange={(e) => update({ title: e.target.value })} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="起始章"><Input type="number" min={1} value={form.startChapterNo} onChange={(e) => update({ startChapterNo: toInt(e.target.value, 1) })} /></Field>
        <Field label="结束章"><Input type="number" min={1} value={form.endChapterNo} onChange={(e) => update({ endChapterNo: toInt(e.target.value, 1) })} /></Field>
      </div>
      <Field label="概要"><Textarea rows={8} value={form.summary} onChange={(e) => update({ summary: e.target.value })} /></Field>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Beat
// ---------------------------------------------------------------------------

export function BeatForm({ novelId, beat, data, onSaved }: FormProps & { beat: Beat }) {
  const { form, update, flush } = useAutosave(beat, async (f) => {
    await upsertBeat(novelId, { id: f.id, arcId: f.arcId, title: f.title.trim() || '未命名', summary: f.summary, chapterNo: f.chapterNo, characterIds: f.characterIds, settingIds: f.settingIds, order: f.order }, f.order);
    onSaved();
  }, { key: beat.id });
  return (
    <div className="space-y-3" onBlur={flush}>
      <Field label="标题"><Input value={form.title} onChange={(e) => update({ title: e.target.value })} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="所属故事弧">
          <Select value={form.arcId ?? ''} onChange={(e) => update({ arcId: e.target.value || null }, 'now')}>
            <option value="">（无）</option>
            {data.arcs.map((a) => <option key={a.id} value={a.id}>{a.title}</option>)}
          </Select>
        </Field>
        <Field label="所在章节" hint="留空表示还没放进章节"><Input type="number" min={1} value={form.chapterNo ?? ''} onChange={(e) => update({ chapterNo: e.target.value === '' ? null : toInt(e.target.value, 1) })} /></Field>
      </div>
      <Field label="概要"><Textarea rows={5} value={form.summary} onChange={(e) => update({ summary: e.target.value })} /></Field>
      <Field label="涉及人物">
        <CheckList options={data.characters.map((c) => ({ id: c.id, label: c.name }))} value={form.characterIds} onChange={(v) => update({ characterIds: v }, 'now')} empty="还没有人物。" />
      </Field>
      <Field label="涉及设定">
        <CheckList options={data.settings.map((s) => ({ id: s.id, label: s.name }))} value={form.settingIds} onChange={(v) => update({ settingIds: v }, 'now')} empty="还没有设定。" />
      </Field>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chapter plan
// ---------------------------------------------------------------------------

export function ChapterPlanForm({ novelId, chapter, data, onSaved }: FormProps & { chapter: Chapter }) {
  const { form, update, flush } = useAutosave(
    { title: chapter.title, goal: chapter.goal, targetChars: chapter.targetChars, povCharacterId: chapter.povCharacterId, beatIds: chapter.beatIds, endHook: chapter.endHook },
    async (f) => { await upsertChapterPlan(novelId, { chapterNo: chapter.chapterNo, ...f, targetChars: Math.max(0, f.targetChars) }); onSaved(); },
  );
  const beatOptions = data.beats
    .filter((b) => b.chapterNo === chapter.chapterNo || form.beatIds.includes(b.id))
    .map((b) => ({ id: b.id, label: b.chapterNo === chapter.chapterNo ? b.title : `${b.title}（第${b.chapterNo ?? '?'}章）` }));
  return (
    <div className="space-y-3" onBlur={flush}>
      <div className="grid grid-cols-[1fr_140px] gap-3">
        <Field label="标题"><Input value={form.title} onChange={(e) => update({ title: e.target.value })} /></Field>
        <Field label="目标字数"><Input type="number" min={0} step={100} value={form.targetChars} onChange={(e) => update({ targetChars: toInt(e.target.value, 0) })} /></Field>
      </div>
      <Field label="本章目标" hint="改了目标，这一章就需要重写"><Textarea rows={4} value={form.goal} onChange={(e) => update({ goal: e.target.value })} /></Field>
      <Field label="视角人物">
        <Select value={form.povCharacterId ?? ''} onChange={(e) => update({ povCharacterId: e.target.value || null }, 'now')}>
          <option value="">（未指定）</option>
          {data.characters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
      </Field>
      <Field label="包含情节点" hint="这里列出放在本章的情节点；到「情节点」里改所在章节，可以加入更多">
        <CheckList options={beatOptions} value={form.beatIds} onChange={(v) => update({ beatIds: v }, 'now')} empty="本章尚无情节点。" />
      </Field>
      <Field label="结尾钩子"><Textarea rows={3} value={form.endHook} onChange={(e) => update({ endHook: e.target.value })} /></Field>
      {chapter.currentVersionId && <p className="text-xs text-ink-400">这一章已经有正文了。改完计划后，点「看看哪些章节需要改」让正文跟上。</p>}
    </div>
  );
}
