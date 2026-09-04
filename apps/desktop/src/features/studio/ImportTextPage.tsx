import { useState } from 'react';
import { useNavigate } from 'react-router';
import { open } from '@tauri-apps/plugin-dialog';
import { readTextFile } from '@tauri-apps/plugin-fs';
import { FileText } from 'lucide-react';
import { splitChapters } from '@the-water/shared';
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
    const p = await open({ multiple: false, filters: [{ name: '文本', extensions: ['txt', 'md'] }] });
    if (!p || Array.isArray(p)) return;
    const content = await readTextFile(p);
    setText(content);
    if (!title) setTitle((p.split(/[\\/]/).pop() ?? '').replace(/\.(txt|md)$/i, ''));
  };
  const doImport = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      const novel = await importTextNovel({ title: title.trim() || '导入的小说', text, requirements: defaultRequirements() });
      toast.success(`已导入 ${preview.length} 章`);
      await queueStyleExtraction(novel.id, (msg) => toast.success(msg));
      nav(`/studio/${novel.id}/chapters`);
    } catch (e) { toast.error(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  return (
    <div className="h-full overflow-y-auto bg-paper-50 dark:bg-paper-950">
      <div className="mx-auto max-w-2xl px-8 py-12">
        <h1 className="font-serif text-3xl font-semibold tracking-wide">把写好的书带进来</h1>
        <p className="mt-2 text-sm leading-relaxed text-ink-500">会按「第X章」这样的标题自动分章。放进来之后，可以在「故事线」里补上人物和设定，再请 AI 帮你改写。</p>
        <Card className="mt-8 space-y-5 p-7">
          <Field label="书名"><Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="留空则用文件名" /></Field>
          <div className="flex items-center gap-3">
            <Button onClick={pick}><FileText size={16} strokeWidth={1.75} />选择 .txt / .md 文件</Button>
            <span className="text-xs text-ink-400">或者直接把全文粘贴到下面</span>
          </div>
          <Textarea rows={12} value={text} onChange={(e) => setText(e.target.value)} placeholder="粘贴全文…" className="font-serif leading-[1.8]" />
          {preview.length > 0 && <p className="text-xs text-ink-500">认出了 <span className="font-serif">{preview.length}</span> 章，共 <span className="font-serif">{text.length.toLocaleString()}</span> 字。第一章：{preview[0]!.title}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={() => nav('/library?tab=novels')}>取消</Button>
            <Button variant="primary" disabled={busy || !text.trim()} onClick={doImport}>放上书桌</Button>
          </div>
        </Card>
      </div>
    </div>
  );
}
