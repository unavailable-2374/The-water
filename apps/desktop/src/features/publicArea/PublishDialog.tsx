import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { LICENSE_LABELS, SHARE_ALIKE_LICENSES, LIMITS, type License } from '@the-water/shared';
import { t } from '@/i18n/zh';
import { Button, Dialog, Field, Input, Select, Spinner, Textarea } from '@/components/ui';
import { toast } from '@/components/Toast';
import type { Novel } from '@/db/repos/novelsRepo';
import { useAccount } from '@/stores/accountStore';
import { getClient } from '@/sync/account';
import { describeError } from '@/sync/api';
import { diffAgainstRemote, publishNovel, remoteVersionNumber, resumePublish, type PublishDiff, type PublishOptions } from '@/sync/publish';

interface Props { novel: Novel; open: boolean; onClose: () => void; onPublished?: () => void }

interface Form {
  title: string; summary: string; tags: string; license: License; allowDerivatives: boolean;
  writingStatus: 'ongoing' | 'completed'; visibility: 'public' | 'unlisted'; changeNote: string;
}

const LICENSES = Object.keys(LICENSE_LABELS) as License[];

function initialForm(novel: Novel): Form {
  const locked = novel.origin && SHARE_ALIKE_LICENSES.includes(novel.origin.sourceLicense) ? novel.origin.sourceLicense : null;
  return {
    title: novel.title,
    summary: novel.meta.logline || '',
    tags: novel.meta.themes.slice(0, LIMITS.TAGS_MAX_COUNT).join(', '),
    license: locked ?? 'all-rights-reserved',
    allowDerivatives: locked !== null,
    writingStatus: novel.status === 'complete' ? 'completed' : 'ongoing',
    visibility: 'public',
    changeNote: '',
  };
}

export function parseTags(s: string): string[] {
  const out: string[] = [];
  for (const raw of s.split(/[,，、\n]/)) {
    const tg = raw.trim().slice(0, LIMITS.TAG_MAX);
    if (tg && !out.includes(tg)) out.push(tg);
  }
  return out.slice(0, LIMITS.TAGS_MAX_COUNT);
}

export function PublishDialog({ novel, open, onClose, onPublished }: Props) {
  const nav = useNavigate();
  const { account, loaded, refresh } = useAccount();
  const [f, setF] = useState<Form>(() => initialForm(novel));
  const [diff, setDiff] = useState<PublishDiff | null>(null);
  const [remoteVersion, setRemoteVersion] = useState<number | null>(null);
  const [progress, setProgress] = useState<{ message: string; done: number; total: number } | null>(null);
  const [preparing, setPreparing] = useState(false);

  const lockedLicense = novel.origin && SHARE_ALIKE_LICENSES.includes(novel.origin.sourceLicense) ? novel.origin.sourceLicense : null;
  const remote = novel.remote;
  const hasRemote = !!remote?.novelId;
  const pendingDraft = !!remote?.draftVersionId;
  const busy = progress !== null;

  useEffect(() => { if (!loaded) void refresh(); }, [loaded, refresh]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setF(initialForm(novel));
    setDiff(null);
    setRemoteVersion(remoteVersionNumber(novel));
    setProgress(null);
    setPreparing(true);
    (async () => {
      try {
        if (hasRemote) {
          const [d, client] = await Promise.all([diffAgainstRemote(novel), getClient()]);
          if (cancelled) return;
          setDiff(d);
          if (client && remote && client.baseUrl === remote.serverUrl) {
            const { novel: rn } = await client.getNovel(remote.novelId).catch(() => ({ novel: null }));
            if (cancelled || !rn) return;
            setRemoteVersion(rn.currentVersion?.versionNumber ?? null);
            setF((s) => ({
              ...s,
              title: rn.title, summary: rn.summary, tags: rn.tags.join(', '), license: lockedLicense ?? rn.license,
              allowDerivatives: rn.allowDerivatives, writingStatus: rn.writingStatus,
              visibility: rn.visibility === 'unlisted' ? 'unlisted' : 'public',
            }));
          }
        } else {
          const d = await diffAgainstRemote(novel);
          if (!cancelled) setDiff(d);
        }
      } catch (e) {
        if (!cancelled) toast.error(describeError(e));
      } finally {
        if (!cancelled) setPreparing(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, novel.id, novel.remote?.currentVersionId]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((s) => ({ ...s, [k]: v }));
  const setLicense = (lic: License) => setF((s) => ({ ...s, license: lic, allowDerivatives: lic === 'all-rights-reserved' ? false : s.allowDerivatives }));

  const run = async (resume: boolean) => {
    if (!f.title.trim()) { toast.error('给这本书起个名字吧'); return; }
    if (diff && diff.total === 0) { toast.error('还没有写好的章节可以发布'); return; }
    const opts: PublishOptions = {
      title: f.title.trim(), summary: f.summary.trim(), tags: parseTags(f.tags), license: f.license,
      allowDerivatives: f.license === 'all-rights-reserved' ? false : f.allowDerivatives,
      writingStatus: f.writingStatus, visibility: f.visibility, changeNote: f.changeNote.trim() || undefined,
    };
    setProgress({ message: '准备中…', done: 0, total: 1 });
    try {
      const onProgress = (message: string, done: number, total: number) => setProgress({ message, done, total });
      const v = resume ? await resumePublish(novel.id, onProgress) : await publishNovel(novel.id, opts, onProgress);
      toast.success(`已发布 v${v.versionNumber}（${v.chapterCount} 章，${v.charCount.toLocaleString()} 字）`);
      onPublished?.();
      onClose();
    } catch (e) {
      toast.error(describeError(e));
    } finally {
      setProgress(null);
    }
  };

  return (
    <Dialog open={open} onClose={() => { if (!busy) onClose(); }} title="发布到公共书房" subtitle="让别人也能读到这个故事">
      {!account ? (
        <div className="space-y-3 text-sm">
          <p className="leading-relaxed text-ink-600 dark:text-ink-300">发布到公共书房，需要先登录云端账号。</p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>{t.common.cancel}</Button>
            <Button variant="primary" onClick={() => { onClose(); nav('/settings/account'); }}>去登录</Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="rounded-2xl bg-paper-100 px-4 py-3 text-xs leading-relaxed text-ink-600 dark:bg-paper-800 dark:text-ink-300">
            {preparing ? (
              <span className="flex items-center gap-2"><Spinner className="h-3 w-3" />正在看看哪些章节有变化…</span>
            ) : hasRemote ? (
              <>
                上次发布到 <span className="font-serif">{remoteVersion ? `v${remoteVersion}` : '（未提交）'}</span>，这次会上传 <span className="font-serif text-ink-900 dark:text-paper-100">{diff?.changed ?? '?'}</span> 个有改动的章节（共 {diff?.total ?? '?'} 章{diff?.storylineChanged ? '，故事线也有更新' : ''}）。
                {pendingDraft && <div className="mt-1 text-amber-700 dark:text-amber-300">上次有一次发布没有传完，可以点「接着传」继续，或者重新发布。</div>}
              </>
            ) : (
              <>第一次发布：会上传 <span className="font-serif text-ink-900 dark:text-paper-100">{diff?.total ?? '?'}</span> 章正文，连同故事线和故事圣经。{novel.origin && <> 这本书是《{novel.origin.sourceTitle}》的二创，会在书房里标注来源。</>}</>
            )}
            <div className="mt-1.5 text-ink-400">以 {account.displayName} 的身份发布 · {account.serverUrl}</div>
          </div>

          <Field label="标题"><Input value={f.title} onChange={(e) => set('title', e.target.value)} maxLength={LIMITS.NOVEL_TITLE_MAX} disabled={busy} /></Field>
          <Field label="简介"><Textarea rows={4} value={f.summary} onChange={(e) => set('summary', e.target.value)} maxLength={LIMITS.NOVEL_SUMMARY_MAX} disabled={busy} /></Field>
          <Field label="标签" hint={`逗号分隔，最多 ${LIMITS.TAGS_MAX_COUNT} 个，每个不超过 ${LIMITS.TAG_MAX} 字`}><Input value={f.tags} onChange={(e) => set('tags', e.target.value)} disabled={busy} placeholder="玄幻, 成长, 群像" /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="许可" hint={lockedLicense ? `原作使用 ${LICENSE_LABELS[lockedLicense]}，二创要沿用同一许可` : '决定别人能不能转载、改编你的故事；保留所有权利则只能阅读'}>
              <Select value={f.license} onChange={(e) => setLicense(e.target.value as License)} disabled={busy || lockedLicense !== null}>
                {LICENSES.map((l) => <option key={l} value={l}>{LICENSE_LABELS[l]}</option>)}
              </Select>
            </Field>
            <Field label="状态">
              <Select value={f.writingStatus} onChange={(e) => set('writingStatus', e.target.value as Form['writingStatus'])} disabled={busy}>
                <option value="ongoing">连载中</option>
                <option value="completed">已完结</option>
              </Select>
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className="flex items-center gap-2 self-start pt-6 text-sm text-ink-800 dark:text-paper-100">
              <input type="checkbox" checked={f.allowDerivatives} disabled={busy || f.license === 'all-rights-reserved'} onChange={(e) => set('allowDerivatives', e.target.checked)} />
              允许他人派生二创
              {f.license === 'all-rights-reserved' && <span className="text-xs text-ink-400">（保留所有权利时不能开放）</span>}
            </label>
            <Field label="可见性">
              <Select value={f.visibility} onChange={(e) => set('visibility', e.target.value as Form['visibility'])} disabled={busy}>
                <option value="public">公开（出现在浏览列表）</option>
                <option value="unlisted">不公开列出（仅链接可访问）</option>
              </Select>
            </Field>
          </div>
          <Field label="版本说明（可选）"><Input value={f.changeNote} onChange={(e) => set('changeNote', e.target.value)} maxLength={500} disabled={busy} placeholder="例如：修订第 3–5 章，补全结局" /></Field>

          {progress && (
            <div className="space-y-1">
              <div className="flex justify-between text-xs text-ink-400"><span>{progress.message}</span><span className="font-serif">{Math.round((progress.done / Math.max(1, progress.total)) * 100)}%</span></div>
              <div className="h-0.5 overflow-hidden rounded-full bg-paper-300 dark:bg-paper-800">
                <div className="h-full bg-tea-500 transition-all" style={{ width: `${Math.min(100, (progress.done / Math.max(1, progress.total)) * 100)}%` }} />
              </div>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={onClose} disabled={busy}>{t.common.cancel}</Button>
            {pendingDraft && <Button onClick={() => run(true)} disabled={busy || preparing}>接着传</Button>}
            <Button variant="primary" onClick={() => run(false)} disabled={busy || preparing}>
              {busy && <Spinner className="h-3 w-3 border-paper-0/40 border-t-paper-0" />}{hasRemote ? '发布新版本' : '发布'}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
