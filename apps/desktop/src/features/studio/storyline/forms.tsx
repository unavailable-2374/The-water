import { Plus, X } from 'lucide-react';
import { SettingKind, type Arc, type Beat, type Character, type Setting } from '@the-water/shared';
import { fmt, t } from '@/i18n';
import { Button, Field, IconButton, Input, Select, Textarea } from '@/components/ui';
import { type Chapter, upsertChapterPlan } from '@/db/repos/chaptersRepo';
import { type Novel, updateNovel } from '@/db/repos/novelsRepo';
import { upsertArc, upsertBeat, upsertCharacter, upsertSetting } from '@/db/repos/storylineRepo';
import { useAutosave } from './useAutosave';
import { settingKindLabel, keyValueLines, parseKeyValueLines, splitLines, splitList, type StorylineData } from './types';

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
    {novelId:novel.id},
  );
  return (
    <div className="space-y-3" onBlur={flush}>
      <Field label={t.studio.forms.premise} hint={t.studio.forms.premiseHint}><Textarea rows={12} value={form.premise} onChange={(e) => update({ premise: e.target.value })} /></Field>
      <Field label={t.studio.forms.themes} hint={t.studio.forms.themesHint}><Input value={form.themesText} onChange={(e) => update({ themesText: e.target.value })} /></Field>
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
        id: f.id, name: f.name.trim() || t.studio.forms.unnamed, aliases: splitList(f.aliasesText), role: f.role, description: f.description, arc: f.arc,
        relationships: f.relationships.filter((r) => r.targetId),
        speechSamples: splitLines(f.speechText), verbalTics: splitList(f.ticsText), addressBook: parseKeyValueLines(f.addressText), redlines: splitLines(f.redlinesText),
      }, index);
      onSaved();
    },
    { key: character.id, novelId },
  );
  const others = data.characters.filter((c) => c.id !== character.id);
  const setRel = (i: number, patch: Partial<Character['relationships'][number]>, mode: 'debounce' | 'now') =>
    update({ relationships: form.relationships.map((r, j) => (j === i ? { ...r, ...patch } : r)) }, mode);

  return (
    <div className="space-y-3" onBlur={flush}>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t.studio.forms.name}><Input value={form.name} onChange={(e) => update({ name: e.target.value })} /></Field>
        <Field label={t.studio.forms.role} hint={t.studio.forms.roleHint}><Input value={form.role} onChange={(e) => update({ role: e.target.value })} /></Field>
      </div>
      <Field label={t.studio.forms.aliases} hint={t.studio.forms.aliasesHint}><Input value={form.aliasesText} onChange={(e) => update({ aliasesText: e.target.value })} /></Field>
      <Field label={t.studio.forms.description}><Textarea rows={5} value={form.description} onChange={(e) => update({ description: e.target.value })} /></Field>
      <Field label={t.studio.forms.characterArc}><Textarea rows={4} value={form.arc} onChange={(e) => update({ arc: e.target.value })} /></Field>
      <div className="rounded-2xl bg-paper-100/70 p-4 dark:bg-paper-800/60">
        <div className="mb-3 font-serif text-xs tracking-[0.2em] text-ink-500">{t.studio.forms.speechSpec}</div>
        <div className="space-y-3">
          <Field label={t.studio.forms.speechSamples} hint={t.studio.forms.speechSamplesHint}><Textarea rows={5} value={form.speechText} onChange={(e) => update({ speechText: e.target.value })} /></Field>
          <Field label={t.studio.forms.tics} hint={t.studio.forms.ticsHint}><Input value={form.ticsText} onChange={(e) => update({ ticsText: e.target.value })} /></Field>
          <Field label={t.studio.forms.addressBook} hint={t.studio.forms.addressBookHint}><Textarea rows={3} value={form.addressText} onChange={(e) => update({ addressText: e.target.value })} /></Field>
          <Field label={t.studio.forms.redlines} hint={t.studio.forms.redlinesHint}><Textarea rows={3} value={form.redlinesText} onChange={(e) => update({ redlinesText: e.target.value })} /></Field>
        </div>
      </div>
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium tracking-wide text-ink-600 dark:text-ink-300">{t.studio.forms.relations} <span className="font-serif text-ink-400">{form.relationships.length}</span></span>
          <Button size="sm" variant="ghost" disabled={others.length === 0} onClick={() => update({ relationships: [...form.relationships, { targetId: others[0]?.id ?? '', kind: '', note: '' }] }, 'now')}>
            <Plus size={14} strokeWidth={1.75} aria-hidden="true" />{t.studio.forms.addRelation}
          </Button>
        </div>
        {form.relationships.length === 0 && <p className="text-xs text-ink-400">{others.length === 0 ? t.studio.forms.noOtherCharacter : t.studio.forms.noRelation}</p>}
        {form.relationships.map((r, i) => (
          <div key={i} className="grid grid-cols-[1fr_120px_1fr_28px] items-center gap-2">
            <Select aria-label={t.studio.forms.pickCharacter} value={r.targetId} onChange={(e) => setRel(i, { targetId: e.target.value }, 'now')}>
              {!others.some((c) => c.id === r.targetId) && <option value={r.targetId}>{r.targetId ? t.studio.forms.deletedCharacter : t.studio.forms.pickCharacter}</option>}
              {others.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
            <Input aria-label={t.studio.forms.relationKind} placeholder={t.studio.forms.relationKind} value={r.kind} onChange={(e) => setRel(i, { kind: e.target.value }, 'debounce')} />
            <Input aria-label={t.studio.forms.relationNote} placeholder={t.studio.forms.relationNote} value={r.note} onChange={(e) => setRel(i, { note: e.target.value }, 'debounce')} />
            <IconButton label={t.studio.forms.deleteRelation} className="p-1 hover:text-cinnabar-600" onClick={() => update({ relationships: form.relationships.filter((_, j) => j !== i) }, 'now')}><X size={14} strokeWidth={1.75} aria-hidden="true" /></IconButton>
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
    await upsertSetting(novelId, { id: f.id, name: f.name.trim() || t.studio.forms.unnamed, kind: f.kind, description: f.description, triggerKeys: splitList(f.triggerText), priority: Math.max(0, Math.min(100, f.priority)), constant: f.constant }, index);
    onSaved();
  }, { key: setting.id, novelId });
  return (
    <div className="space-y-3" onBlur={flush}>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t.studio.forms.settingName}><Input value={form.name} onChange={(e) => update({ name: e.target.value })} /></Field>
        <Field label={t.studio.forms.settingKind}>
          <Select value={form.kind} onChange={(e) => update({ kind: e.target.value as Setting['kind'] }, 'now')}>
            {SettingKind.options.map((k) => <option key={k} value={k}>{settingKindLabel(k)}</option>)}
          </Select>
        </Field>
      </div>
      <Field label={t.studio.forms.settingDesc}><Textarea rows={8} value={form.description} onChange={(e) => update({ description: e.target.value })} /></Field>
      <div className="rounded-2xl bg-paper-100/70 p-4 dark:bg-paper-800/60">
        <div className="mb-3 font-serif text-xs tracking-[0.2em] text-ink-500">{t.studio.forms.injectionRule}</div>
        <div className="space-y-3">
          <Field label={t.studio.forms.triggerKeys} hint={t.studio.forms.triggerKeysHint}><Input value={form.triggerText} onChange={(e) => update({ triggerText: e.target.value })} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t.studio.forms.priority} hint={t.studio.forms.priorityHint}><Input type="number" min={0} max={100} value={form.priority} onChange={(e) => update({ priority: toInt(e.target.value, 50) })} /></Field>
            <label className="flex items-center gap-2 pt-6 text-sm text-ink-800 dark:text-paper-100">
              <input type="checkbox" checked={form.constant} onChange={(e) => update({ constant: e.target.checked }, 'now')} />{t.studio.forms.constant}
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
    await upsertArc(novelId, { id: f.id, title: f.title.trim() || t.studio.forms.unnamed, summary: f.summary, startChapterNo: Math.max(1, f.startChapterNo), endChapterNo: Math.max(f.startChapterNo, f.endChapterNo, 1) }, index);
    onSaved();
  }, { key: arc.id, novelId });
  return (
    <div className="space-y-3" onBlur={flush}>
      <Field label={t.studio.forms.entityTitle}><Input value={form.title} onChange={(e) => update({ title: e.target.value })} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t.studio.forms.arcStart}><Input type="number" min={1} value={form.startChapterNo} onChange={(e) => update({ startChapterNo: toInt(e.target.value, 1) })} /></Field>
        <Field label={t.studio.forms.arcEnd}><Input type="number" min={1} value={form.endChapterNo} onChange={(e) => update({ endChapterNo: toInt(e.target.value, 1) })} /></Field>
      </div>
      <Field label={t.studio.forms.summary}><Textarea rows={8} value={form.summary} onChange={(e) => update({ summary: e.target.value })} /></Field>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Beat
// ---------------------------------------------------------------------------

export function BeatForm({ novelId, beat, data, onSaved }: FormProps & { beat: Beat }) {
  const { form, update, flush } = useAutosave(beat, async (f) => {
    await upsertBeat(novelId, { id: f.id, arcId: f.arcId, title: f.title.trim() || t.studio.forms.unnamed, summary: f.summary, chapterNo: f.chapterNo, characterIds: f.characterIds, settingIds: f.settingIds, order: f.order }, f.order);
    onSaved();
  }, { key: beat.id, novelId });
  return (
    <div className="space-y-3" onBlur={flush}>
      <Field label={t.studio.forms.entityTitle}><Input value={form.title} onChange={(e) => update({ title: e.target.value })} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t.studio.forms.beatArc}>
          <Select value={form.arcId ?? ''} onChange={(e) => update({ arcId: e.target.value || null }, 'now')}>
            <option value="">{t.studio.forms.beatArcNone}</option>
            {data.arcs.map((a) => <option key={a.id} value={a.id}>{a.title}</option>)}
          </Select>
        </Field>
        <Field label={t.studio.forms.beatChapter} hint={t.studio.forms.beatChapterHint}><Input type="number" min={1} value={form.chapterNo ?? ''} onChange={(e) => update({ chapterNo: e.target.value === '' ? null : toInt(e.target.value, 1) })} /></Field>
      </div>
      <Field label={t.studio.forms.summary}><Textarea rows={5} value={form.summary} onChange={(e) => update({ summary: e.target.value })} /></Field>
      <Field label={t.studio.forms.involvedCharacters}>
        <CheckList options={data.characters.map((c) => ({ id: c.id, label: c.name }))} value={form.characterIds} onChange={(v) => update({ characterIds: v }, 'now')} empty={t.studio.forms.noCharacter} />
      </Field>
      <Field label={t.studio.forms.involvedSettings}>
        <CheckList options={data.settings.map((s) => ({ id: s.id, label: s.name }))} value={form.settingIds} onChange={(v) => update({ settingIds: v }, 'now')} empty={t.studio.forms.noSetting} />
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
    {novelId},
  );
  const beatOptions = data.beats
    .filter((b) => b.chapterNo === chapter.chapterNo || form.beatIds.includes(b.id))
    .map((b) => ({ id: b.id, label: b.chapterNo === chapter.chapterNo ? b.title : fmt(t.studio.forms.beatInOtherChapter, { title: b.title, n: b.chapterNo ?? t.studio.forms.beatUnknownChapter }) }));
  return (
    <div className="space-y-3" onBlur={flush}>
      <div className="grid grid-cols-[1fr_140px] gap-3">
        <Field label={t.studio.forms.chapterTitle}><Input value={form.title} onChange={(e) => update({ title: e.target.value })} /></Field>
        <Field label={t.studio.forms.chapterTarget}><Input type="number" min={0} step={100} value={form.targetChars} onChange={(e) => update({ targetChars: toInt(e.target.value, 0) })} /></Field>
      </div>
      <Field label={t.studio.forms.chapterGoal} hint={t.studio.forms.chapterGoalHint}><Textarea rows={4} value={form.goal} onChange={(e) => update({ goal: e.target.value })} /></Field>
      <Field label={t.studio.forms.povCharacter}>
        <Select value={form.povCharacterId ?? ''} onChange={(e) => update({ povCharacterId: e.target.value || null }, 'now')}>
          <option value="">{t.studio.forms.povNone}</option>
          {data.characters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
      </Field>
      <Field label={t.studio.forms.includedBeats} hint={t.studio.forms.includedBeatsHint}>
        <CheckList options={beatOptions} value={form.beatIds} onChange={(v) => update({ beatIds: v }, 'now')} empty={t.studio.forms.noBeat} />
      </Field>
      <Field label={t.studio.forms.endHook}><Textarea rows={3} value={form.endHook} onChange={(e) => update({ endHook: e.target.value })} /></Field>
      {chapter.currentVersionId && <p className="text-xs text-ink-400">{t.studio.forms.chapterWritten}</p>}
    </div>
  );
}
