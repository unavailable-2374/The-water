import { useState } from 'react';
import { useNavigate } from 'react-router';
import { open } from '@tauri-apps/plugin-dialog';
import { readTextFile } from '@tauri-apps/plugin-fs';
import { FileText } from 'lucide-react';
import { splitChapters } from '@the-water/shared';
import { fmt, t } from '@/i18n';
import { Button, Card, Field, Input, Textarea } from '@/components/ui';
import { toast } from '@/components/Toast';
import { defaultRequirements } from '@/novel/types';
import { importTextNovel } from '@/novel/service';
import { queueStyleExtraction } from '@/sync/fork';

export function ImportTextPage() {
  const nav = useNavigate();
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const preview = text ? splitChapters(text) : [];
  const pick = async () => {
    const p = await open({ multiple: false, filters: [{ name: t.studio.importText.fileFilter, extensions: ['txt', 'md'] }] });
    if (!p || Array.isArray(p)) return;
    const content = await readTextFile(p);
    setText(content);
    if (!title) setTitle((p.split(/[\\/]/).pop() ?? '').replace(/\.(txt|md)$/i, ''));
  };
  const doImport = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      const novel = await importTextNovel({ title: title.trim() || t.studio.importText.fallbackTitle, text, requirements: defaultRequirements() });
      toast.success(fmt(t.studio.importText.imported, { n: preview.length }));
      await queueStyleExtraction(novel.id, (msg) => toast.success(msg));
      nav(`/studio/${novel.id}/chapters`);
    } catch (e) { toast.error(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  return (
    <div className="h-full overflow-y-auto bg-paper-50 dark:bg-paper-950">
      <div className="mx-auto max-w-2xl px-8 py-12">
        <h1 className="font-serif text-3xl font-semibold tracking-wide">{t.studio.importText.title}</h1>
        <p className="mt-2 text-sm leading-relaxed text-ink-500">{t.studio.importText.desc}</p>
        <Card className="mt-8 space-y-5 p-7">
          <Field label={t.studio.importText.novelTitle}><Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t.studio.importText.titlePlaceholder} /></Field>
          <div className="flex items-center gap-3">
            <Button onClick={pick}><FileText size={16} strokeWidth={1.75} aria-hidden="true" />{t.studio.importText.pickFile}</Button>
            <span className="text-xs text-ink-400">{t.studio.importText.orPaste}</span>
          </div>
          <Textarea rows={12} aria-label={t.studio.importText.textPlaceholder} value={text} onChange={(e) => setText(e.target.value)} placeholder={t.studio.importText.textPlaceholder} className="font-serif leading-[1.8]" />
          {preview.length > 0 && (
            <p className="text-xs text-ink-500" role="status">
              {fmt(t.studio.importText.preview, { chapters: preview.length, chars: text.length.toLocaleString(), first: preview[0]!.title })}
            </p>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={() => nav('/library?tab=novels')}>{t.common.cancel}</Button>
            <Button variant="primary" disabled={busy || !text.trim()} onClick={doImport}>{t.studio.importText.submit}</Button>
          </div>
        </Card>
      </div>
    </div>
  );
}
