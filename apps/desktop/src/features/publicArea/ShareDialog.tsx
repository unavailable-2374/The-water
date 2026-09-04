import { useEffect, useRef, useState } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { Copy, ExternalLink, ImageDown, Link2 } from 'lucide-react';
import { t, fmt } from '@/i18n/zh';
import { Button, Dialog, Spinner } from '@/components/ui';
import { toast } from '@/components/Toast';
import { copyText } from '@/platform/clipboard';
import { friendlyError } from '@/community/errors';
import { renderShareCard, saveShareCardPng, type ShareCardData } from '@/community/shareImage';
import type { ShareTarget } from '@/community/shareCard';

interface Props {
  open: boolean;
  onClose: () => void;
  title: string;
  target: ShareTarget;
  /** 有封面数据时画分享图；作者主页传 null，只提供链接与文字。 */
  cover: ShareCardData | null;
}

/** 分享面板：复制链接 / 复制文字卡片 / 保存分享图 / 在浏览器打开。 */
export function ShareDialog({ open, onClose, title, target, cover }: Props) {
  const holder = useRef<HTMLDivElement>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || !cover || !holder.current) return;
    const node = holder.current;
    node.replaceChildren();
    const canvas = renderShareCard(cover, window.devicePixelRatio || 1);
    canvas.style.width = '100%';
    canvas.style.height = 'auto';
    canvas.className = 'rounded-xl shadow-soft';
    node.append(canvas);
  }, [open, cover]);

  const copy = async (text: string, message: string) => {
    try {
      await copyText(text);
      toast.success(message);
    } catch (e) {
      toast.error(friendlyError(e));
    }
  };

  const savePng = async () => {
    if (!cover) return;
    setSaving(true);
    try {
      const path = await saveShareCardPng(cover, target.fileName);
      if (path) toast.success(fmt(t.community.pngSaved, { path }));
    } catch (e) {
      toast.error(friendlyError(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title={title} subtitle="链接指向网页版，任何人都能打开" width="max-w-xl">
      <div className="space-y-4">
        {cover && <div ref={holder} />}
        <div className="rounded-xl bg-paper-100 px-3 py-2 font-mono text-xs break-all text-ink-600 dark:bg-paper-950 dark:text-ink-300">{target.url}</div>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" onClick={() => copy(target.url, t.community.linkCopied)}><Link2 size={16} strokeWidth={1.75} />{t.community.copyLink}</Button>
          <Button onClick={() => copy(target.text, t.community.cardCopied)}><Copy size={16} strokeWidth={1.75} />{t.community.copyCard}</Button>
          {cover && (
            <Button onClick={savePng} disabled={saving}>
              {saving ? <Spinner className="h-3.5 w-3.5" /> : <ImageDown size={16} strokeWidth={1.75} />}
              {t.community.savePng}
            </Button>
          )}
          <Button variant="ghost" onClick={() => void openUrl(target.url).catch((e) => toast.error(friendlyError(e)))}>
            <ExternalLink size={16} strokeWidth={1.75} />{t.community.openInBrowser}
          </Button>
        </div>
        <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-xl bg-paper-100 p-3 text-xs leading-relaxed text-ink-600 dark:bg-paper-950 dark:text-ink-300">{target.text}</pre>
      </div>
    </Dialog>
  );
}
