import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  LICENSE_LABELS,
  SHARE_ALIKE_LICENSES,
  LIMITS,
  licenseMeta,
  nonCommercialNotice,
  type License,
} from '@the-water/shared';
import { fmt, t } from '@/i18n';
import { Badge, Button, Dialog, Field, Input, Select, Spinner, Textarea } from '@/components/ui';
import { toast } from '@/components/Toast';
import type { Novel } from '@/db/repos/novelsRepo';
import { listPendingRewrites } from '@/db/repos/chaptersRepo';
import { useAsyncData } from '@/components/data/useAsyncData';
import { useAccount } from '@/stores/accountStore';
import { getClient } from '@/sync/account';
import { describeError } from '@/sync/api';
import { diffAgainstRemote, publishNovel, remoteVersionNumber, resumePublish, type PublishDiff, type PublishOptions } from '@/sync/publish';

interface Props { novel: Novel; open: boolean; onClose: () => void; onPublished?: () => void }

interface Form {
  shareCreationMaterials: boolean;
  title: string; summary: string; tags: string; license: License; allowDerivatives: boolean;
  writingStatus: 'ongoing' | 'completed'; visibility: 'public' | 'unlisted'; changeNote: string;
}

const LICENSES = Object.keys(LICENSE_LABELS) as License[];

function initialForm(novel: Novel): Form {
  const locked = novel.origin && SHARE_ALIKE_LICENSES.includes(novel.origin.sourceLicense) ? novel.origin.sourceLicense : null;
  return {
    shareCreationMaterials: false,
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

/**
 * §3.7：二创发布前必须把原作署名摆在眼前 —— 不是可折叠的小字，也不能跳过。
 * 这段文字与服务端写进 bundle 的机器可读署名块同源（都用 shared 的许可元数据）。
 */
function SourceAttribution({ origin }: { origin: NonNullable<Novel['origin']> }) {
  const meta = licenseMeta(origin.sourceLicense);
  return (
    <div className="rounded-2xl border border-amber-300/70 bg-amber-50/70 px-4 py-3 text-xs leading-relaxed text-ink-700 dark:border-amber-700/50 dark:bg-amber-900/20 dark:text-ink-200">
      <div className="mb-1.5 flex items-center gap-2">
        <Badge tone="amber">{t.community.derivative}</Badge>
        <span className="font-medium text-ink-800 dark:text-paper-100">{t.publicArea.attributionTitle}</span>
      </div>
      <div className="font-serif">
        {fmt(t.publicArea.attributionSource, { title: origin.sourceTitle, version: origin.sourceVersionNumber, author: origin.sourceAuthorDisplayName })}
      </div>
      <div className="mt-1">
        {fmt(t.publicArea.sourceLicenseLabel, { label: meta.label })}
        {meta.url && (
          <>
            {' · '}
            <a className="underline hover:text-tea-700 dark:hover:text-tea-200" href={meta.url} target="_blank" rel="noreferrer">
              {t.publicArea.licenseFullText}
            </a>
          </>
        )}
      </div>
      {meta.shareAlike && <div className="mt-1">{t.publicArea.shareAlikeNote}</div>}
      {meta.nonCommercial && <div className="mt-1">{nonCommercialNotice(origin.sourceLicense)}</div>}
      <div className="mt-1 text-ink-500 dark:text-ink-400">
        {t.publicArea.attributionNote}
      </div>
    </div>
  );
}

export function PublishDialog({ novel, open, onClose, onPublished }: Props) {
  const nav = useNavigate();
  const { account, loaded, refresh } = useAccount();
  const [f, setF] = useState<Form>(() => initialForm(novel));
  const [diff, setDiff] = useState<PublishDiff | null>(null);
  const [remoteVersion, setRemoteVersion] = useState<number | null>(null);
  const [progress, setProgress] = useState<{ message: string; done: number; total: number } | null>(null);
  const [preparing, setPreparing] = useState(false);
  // 发布只读取已提交版本；候选数量用于提示作者。
  const { data: pendingCount } = useAsyncData<number>(
    async () => (await listPendingRewrites(novel.id)).length,
    { key: `publishPending:${novel.id}`, enabled: open },
  );

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
    if (!f.title.trim()) { toast.error(t.publicArea.needTitle); return; }
    if (diff && diff.total === 0) { toast.error(t.publicArea.noPublishableChapters); return; }
    const opts: PublishOptions = {
      title: f.title.trim(), summary: f.summary.trim(), tags: parseTags(f.tags), license: f.license,
      allowDerivatives: f.license === 'all-rights-reserved' ? false : f.allowDerivatives,
      shareCreationMaterials: f.shareCreationMaterials,
      writingStatus: f.writingStatus, visibility: f.visibility, changeNote: f.changeNote.trim() || undefined,
    };
    setProgress({ message: t.publicArea.preparing, done: 0, total: 1 });
    try {
      const onProgress = (message: string, done: number, total: number) => setProgress({ message, done, total });
      const v = resume ? await resumePublish(novel.id, onProgress) : await publishNovel(novel.id, opts, onProgress);
      toast.success(fmt(t.publicArea.published, { version: v.versionNumber, chapters: v.chapterCount, chars: v.charCount.toLocaleString() }));
      onPublished?.();
      onClose();
    } catch (e) {
      toast.error(describeError(e));
    } finally {
      setProgress(null);
    }
  };

  return (
    <Dialog open={open} onClose={() => { if (!busy) onClose(); }} title={t.publicArea.publishTitle} subtitle={t.publicArea.publishSubtitle}>
      {!account ? (
        <div className="space-y-3 text-sm">
          <p className="leading-relaxed text-ink-600 dark:text-ink-300">{t.publicArea.publishNeedLogin}</p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>{t.common.cancel}</Button>
            <Button variant="primary" onClick={() => { onClose(); nav('/settings/account'); }}>{t.publicArea.goLogin}</Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {!!pendingCount && (
            <p role="alert" className="rounded-xl bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
              {fmt(t.publicArea.publishPendingWarning, { n: pendingCount })}
            </p>
          )}
          <div className="rounded-2xl bg-paper-100 px-4 py-3 text-xs leading-relaxed text-ink-600 dark:bg-paper-800 dark:text-ink-300">
            {preparing ? (
              <span className="flex items-center gap-2" role="status"><Spinner className="h-3 w-3" />{t.publicArea.diffing}</span>
            ) : hasRemote ? (
              <>
                {t.publicArea.lastPublishedTo}<span className="font-serif">{remoteVersion ? `v${remoteVersion}` : t.publicArea.versionNotCommitted}</span>{t.publicArea.diffChangedPrefix}<span className="font-serif text-ink-900 dark:text-paper-100">{diff?.changed ?? '?'}</span>{fmt(t.publicArea.diffChangedSuffix, { total: diff?.total ?? '?', storyline: diff?.storylineChanged ? t.publicArea.diffStoryline : '' })}
                {pendingDraft && <div className="mt-1 text-amber-700 dark:text-amber-300">{t.publicArea.pendingDraftNote}</div>}
              </>
            ) : (
              <>{t.publicArea.firstPublishPrefix}<span className="font-serif text-ink-900 dark:text-paper-100">{diff?.total ?? '?'}</span>{t.publicArea.firstPublishSuffix}{novel.origin && fmt(t.publicArea.firstPublishFork, { title: novel.origin.sourceTitle })}</>
            )}
            <div className="mt-1.5 text-ink-400">{fmt(t.publicArea.publishAs, { name: account.displayName, server: account.serverUrl })}</div>
          </div>

          {novel.origin && <SourceAttribution origin={novel.origin} />}

          <Field label={t.publicArea.fieldTitle}><Input value={f.title} onChange={(e) => set('title', e.target.value)} maxLength={LIMITS.NOVEL_TITLE_MAX} disabled={busy} /></Field>
          <Field label={t.publicArea.fieldSummary}><Textarea rows={4} value={f.summary} onChange={(e) => set('summary', e.target.value)} maxLength={LIMITS.NOVEL_SUMMARY_MAX} disabled={busy} /></Field>
          <Field label={t.publicArea.fieldTags} hint={fmt(t.publicArea.tagsHint, { max: LIMITS.TAGS_MAX_COUNT, len: LIMITS.TAG_MAX })}><Input value={f.tags} onChange={(e) => set('tags', e.target.value)} disabled={busy} placeholder={t.publicArea.tagsPlaceholder} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t.publicArea.fieldLicense} hint={lockedLicense ? fmt(t.publicArea.licenseLocked, { license: LICENSE_LABELS[lockedLicense] }) : t.publicArea.licenseHint}>
              <Select value={f.license} onChange={(e) => setLicense(e.target.value as License)} disabled={busy || lockedLicense !== null}>
                {LICENSES.map((l) => <option key={l} value={l}>{LICENSE_LABELS[l]}</option>)}
              </Select>
              {/* §3.7：许可不再只是一个字符串，全文链接与「非商业」提示都摆出来。 */}
              <div className="mt-1.5 space-y-0.5 text-[11px] leading-relaxed text-ink-400">
                {licenseMeta(f.license).url && (
                  <a className="underline hover:text-tea-700 dark:hover:text-tea-200" href={licenseMeta(f.license).url!} target="_blank" rel="noreferrer">
                    {t.publicArea.viewLicenseFullText}
                  </a>
                )}
                {nonCommercialNotice(f.license) && <div className="text-amber-700 dark:text-amber-300">{nonCommercialNotice(f.license)}</div>}
              </div>
            </Field>
            <Field label={t.publicArea.fieldStatus}>
              <Select value={f.writingStatus} onChange={(e) => set('writingStatus', e.target.value as Form['writingStatus'])} disabled={busy}>
                <option value="ongoing">{t.publicArea.statusOngoing}</option>
                <option value="completed">{t.publicArea.statusCompleted}</option>
              </Select>
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className="flex items-center gap-2 self-start pt-6 text-sm text-ink-800 dark:text-paper-100">
              <input type="checkbox" checked={f.allowDerivatives} disabled={busy || f.license === 'all-rights-reserved'} onChange={(e) => set('allowDerivatives', e.target.checked)} />
              {t.publicArea.allowDerivativesLabel}
              {f.license === 'all-rights-reserved' && <span className="text-xs text-ink-400">{t.publicArea.allowDerivativesLocked}</span>}
            </label>
            <Field label={t.publicArea.fieldVisibility}>
              <Select value={f.visibility} onChange={(e) => set('visibility', e.target.value as Form['visibility'])} disabled={busy}>
                <option value="public">{t.publicArea.visibilityPublic}</option>
                <option value="unlisted">{t.publicArea.visibilityUnlisted}</option>
              </Select>
            </Field>
          </div>
<label className="block text-sm"><input type="checkbox" checked={f.shareCreationMaterials} disabled={busy} onChange={e => set('shareCreationMaterials', e.target.checked)} /> {t.studio.workbench.share}<p className="mt-1 text-xs text-ink-500">{t.studio.workbench.private}</p></label>
          <Field label={t.publicArea.fieldChangeNote}><Input value={f.changeNote} onChange={(e) => set('changeNote', e.target.value)} maxLength={500} disabled={busy} placeholder={t.publicArea.changeNotePlaceholder} /></Field>

          {progress && (
            <div className="space-y-1" role="status" aria-live="polite" aria-label={t.publicArea.publishProgress}>
              <div className="flex justify-between text-xs text-ink-400"><span>{progress.message}</span><span className="font-serif">{Math.round((progress.done / Math.max(1, progress.total)) * 100)}%</span></div>
              <div className="h-0.5 overflow-hidden rounded-full bg-paper-300 dark:bg-paper-800">
                <div className="h-full bg-tea-500 transition-all" style={{ width: `${Math.min(100, (progress.done / Math.max(1, progress.total)) * 100)}%` }} />
              </div>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={onClose} disabled={busy}>{t.common.cancel}</Button>
            {pendingDraft && <Button onClick={() => run(true)} disabled={busy || preparing}>{t.publicArea.resumeUpload}</Button>}
            <Button variant="primary" onClick={() => run(false)} disabled={busy || preparing}>
              {busy && <Spinner className="h-3 w-3 border-paper-0/40 border-t-paper-0" />}{hasRemote ? t.publicArea.publishNewVersion : t.publicArea.publishSubmit}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
