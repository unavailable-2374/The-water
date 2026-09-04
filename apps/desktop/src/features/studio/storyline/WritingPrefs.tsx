import { useState } from 'react';
import { Check, Sparkles, Trash2 } from 'lucide-react';
import { fmt, t } from '@/i18n';
import { Button, Field, IconButton, Spinner, Textarea, confirm } from '@/components/ui';
import { useAsyncData } from '@/components/data/useAsyncData';
import { toast } from '@/components/Toast';
import {
  FEEDBACK_PROMOTE_THRESHOLD, clearFeedback, dismissFeedback, listFeedback, promoteFeedback, type FeedbackRow,
} from '@/db/repos/feedbackRepo';
import { AUTHOR_NOTE_MAX_CHARS, loadAuthorNote, saveAuthorNote } from '@/llm/prompts/authorNote';
import { useAutosave } from './useAutosave';

const err = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * 「我的写作偏好」（§2.3 第 1 条）。
 *
 * 学习层一直在记：你从 AI 初稿里删掉的短语会被攒起来，删够 N 次就自动进这本书的
 * 「少用词」。以前这些东西只在库里，用户完全看不见 —— 这个面板把它们摊开，
 * 可以看、可以提前用起来、也可以删掉（删掉会同时从少用词里摘出去）。
 */
export function LearnedPhrasesPanel({ novelId, onSaved }: { novelId: string; onSaved: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const { data: rows, error, reload } = useAsyncData<FeedbackRow[]>(
    () => listFeedback(novelId), { key: `feedback:${novelId}` },
  );

  const act = async (phrase: string, fn: () => Promise<void>, ok: string) => {
    setBusy(phrase);
    try { await fn(); toast.success(ok); reload(); onSaved(); }
    catch (e) { toast.error(err(e)); }
    finally { setBusy(null); }
  };

  const clearAll = async () => {
    if (!(await confirm({ title: t.studio.prefs.forgetAllTitle, description: t.studio.prefs.forgetAllDesc, confirmText: t.studio.prefs.forgetAll, tone: 'danger' }))) return;
    await act('*', () => clearFeedback(novelId), t.studio.prefs.forgotAll);
  };

  if (error) return <p className="text-xs text-cinnabar-600" role="alert">{err(error)}</p>;
  if (rows === undefined) return <div className="flex items-center gap-2 text-xs text-ink-400" role="status"><Spinner className="h-3 w-3" />{t.common.loading}</div>;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="font-serif text-xs tracking-[0.2em] text-ink-500">{t.studio.prefs.title} <span className="tracking-normal text-ink-400">{rows.length}</span></span>
        {rows.length > 0 && <Button size="sm" variant="ghost" className="text-cinnabar-600 dark:text-cinnabar-100" onClick={() => void clearAll()}>{t.studio.prefs.forgetAll}</Button>}
      </div>
      {rows.length === 0 ? (
        <p className="text-xs leading-relaxed text-ink-400">{fmt(t.studio.prefs.empty, { n: FEEDBACK_PROMOTE_THRESHOLD })}</p>
      ) : (
        <>
          <p className="text-xs leading-relaxed text-ink-400">{fmt(t.studio.prefs.intro, { n: FEEDBACK_PROMOTE_THRESHOLD })}</p>
          <ul aria-label={t.studio.prefs.list} className="divide-y divide-paper-300/50 rounded-xl bg-paper-100/70 dark:divide-paper-800 dark:bg-paper-800/60">
            {rows.map((r) => (
              <li key={r.phrase} className="flex items-center gap-2 px-3 py-2 text-xs">
                <span className="min-w-0 flex-1 truncate font-serif text-sm text-ink-900 dark:text-paper-100">{r.phrase}</span>
                <span className="shrink-0 text-ink-400">{fmt(t.studio.prefs.deletedTimes, { n: r.count })}</span>
                {r.promoted ? (
                  <span className="inline-flex shrink-0 items-center gap-1 text-tea-700 dark:text-tea-200"><Check size={12} strokeWidth={2} aria-hidden="true" />{t.studio.prefs.alreadySoft}</span>
                ) : (
                  <Button size="sm" variant="ghost" className="shrink-0" disabled={busy !== null} onClick={() => void act(r.phrase, () => promoteFeedback(novelId, r.phrase), fmt(t.studio.prefs.promoted, { phrase: r.phrase }))}>{t.studio.prefs.promote}</Button>
                )}
                <IconButton
                  className="shrink-0 p-1 hover:text-cinnabar-600 disabled:opacity-40"
                  label={fmt(t.studio.prefs.forget, { phrase: r.phrase })}
                  disabled={busy !== null}
                  onClick={() => void act(r.phrase, () => dismissFeedback(novelId, r.phrase), fmt(t.studio.prefs.forgot, { phrase: r.phrase }))}
                >
                  <Trash2 size={14} strokeWidth={1.75} aria-hidden="true" />
                </IconButton>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/**
 * 「作者附加指令」（§2.3 第 6 条后半）：为这一本书追加一段自己的话，
 * 会拼进每一次写作 / 改写 / 调长的系统提示，排在通用创作要求之后、输出格式之前。
 */
export function AuthorNoteForm({ novelId }: { novelId: string }) {
  const { data: initial } = useAsyncData<string>(
    async () => { try { return await loadAuthorNote(novelId); } catch { return ''; } },
    { key: `authorNote:${novelId}` },
  );
  if (initial === undefined) return <div className="flex items-center gap-2 text-xs text-ink-400" role="status"><Spinner className="h-3 w-3" />{t.common.loading}</div>;
  return <AuthorNoteEditor key={`note-${novelId}`} novelId={novelId} initial={initial} />;
}

function AuthorNoteEditor({ novelId, initial }: { novelId: string; initial: string }) {
  const { form, update, flush } = useAutosave(
    { note: initial },
    async (f) => { await saveAuthorNote(novelId, f.note); },
    { key: `authorNote-${novelId}` },
  );
  const used = Array.from(form.note).length;
  return (
    <div onBlur={flush}>
      <Field
        label={t.studio.prefs.authorNote}
        hint={fmt(t.studio.prefs.authorNoteHint, { max: AUTHOR_NOTE_MAX_CHARS, used })}
      >
        <Textarea
          rows={4}
          value={form.note}
          onChange={(e) => update({ note: e.target.value.slice(0, AUTHOR_NOTE_MAX_CHARS + 1) })}
          placeholder={t.studio.prefs.authorNotePlaceholder}
        />
      </Field>
      <p className="mt-1 flex items-center gap-1.5 text-xs text-ink-400">
        <Sparkles size={12} strokeWidth={1.75} aria-hidden="true" />{t.studio.prefs.authorNoteTip}
      </p>
    </div>
  );
}
