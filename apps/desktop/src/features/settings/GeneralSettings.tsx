import { useEffect, useState } from 'react';
import { Copy, Database, Download, FolderOpen, LifeBuoy, ScrollText, Upload } from 'lucide-react';
import { availableLocales, currentLocale, fmt, setLocale, t, useLocale } from '@/i18n';
import { Button, Card, Dialog, Field, SectionTitle, Select, cn, confirm } from '@/components/ui';
import { toast } from '@/components/Toast';
import { backupDatabase, openDataDir, restoreDatabase } from '@/db/backup';
import { copyText } from '@/platform/clipboard';
import { checkForUpdate, installPendingUpdate, progressPercent, relaunchApp } from '@/platform/updater';
import { exportDiagnosticsBundle } from '@/diagnostics';
import { useSettings } from '@/stores/settingsStore';
import {
  DEFAULT_STYLE_CHECK, STYLE_CHECK_LIMITS, loadStyleCheckConfig, saveStyleCheckConfig, type StyleCheckConfig,
} from '@/novel/config';
import { promptPreviews, type PromptPreview } from '@/llm/prompts/preview';
import type { ThemePref } from '@/app/theme';

interface AppInfo { version: string; tauriVersion: string; dataDir: string; logDir: string }

/** 版本号与目录都要问 Tauri，浏览器里跑（vite dev 直连）时拿不到，静默降级。 */
function useAppInfo(): AppInfo | null {
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => {
    void (async () => {
      try {
        const [app, path] = await Promise.all([import('@tauri-apps/api/app'), import('@tauri-apps/api/path')]);
        const [version, tauriVersion, dataDir, logDir] = await Promise.all([
          app.getVersion(), app.getTauriVersion(), path.appDataDir(), path.appLogDir(),
        ]);
        setInfo({ version, tauriVersion, dataDir, logDir });
      } catch {
        setInfo(null);
      }
    })();
  }, []);
  return info;
}

async function reveal(path: string): Promise<void> {
  try {
    const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
    await revealItemInDir(path);
  } catch (e) {
    toast.error(fmt(t.settings.openDirFail, { message: e instanceof Error ? e.message : String(e) }));
  }
}

function DirRow({ label, path }: { label: string; path: string }) {
  return (
    <div className="flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium tracking-wide text-ink-600 dark:text-ink-300">{label}</div>
        <div className="truncate text-xs text-ink-400" title={path}>{path}</div>
      </div>
      <Button size="sm" variant="ghost" onClick={() => void reveal(path)}><FolderOpen size={16} strokeWidth={1.75} aria-hidden="true" />{t.settings.openDir}</Button>
    </div>
  );
}

/** 本地数据：备份 / 恢复 / 打开数据目录（P0-9）。 */
function DataSection() {
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const restore = async () => {
    const ok = await confirm({
      title: t.settings.restoreConfirmTitle,
      description: t.settings.restoreConfirmDesc,
      confirmText: t.settings.restore,
      tone: 'danger',
    });
    if (!ok) return;
    await run(async () => {
      const r = await restoreDatabase();
      if (r) toast.success(fmt(t.settings.restoreDone, { version: r.version }));
    });
  };
  return (
    <Card>
      <SectionTitle>{t.settings.localData}</SectionTitle>
      <p className="mb-3 text-xs leading-relaxed text-ink-500">{t.settings.localDataHint}</p>
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={() => void run(async () => {
          const path = await backupDatabase();
          if (path) toast.success(fmt(t.settings.backupDone, { path }));
        })}>
          <Database size={16} strokeWidth={1.75} aria-hidden="true" />{t.settings.backup}
        </Button>
        <Button variant="danger" disabled={busy} onClick={() => void restore()}>
          <Upload size={16} strokeWidth={1.75} aria-hidden="true" />{t.settings.restore}
        </Button>
        <Button disabled={busy} onClick={() => void run(async () => { await openDataDir(); })}>
          <FolderOpen size={16} strokeWidth={1.75} aria-hidden="true" />{t.settings.openDataDir}
        </Button>
      </div>
    </Card>
  );
}

/**
 * 风格审校（§2.3 第 3 条）：以前修订轮数写死 1 轮、及格线写死 0.75，
 * 改完一轮无论达没达标都放行。现在轮数与及格线都可调，跑满轮数仍未达标的章节
 * 会在规划页的章节表里标「风格未达标」，可以单章再审。
 */
function StyleCheckSection() {
  const [cfg, setCfg] = useState<StyleCheckConfig | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { void loadStyleCheckConfig().then(setCfg).catch(() => setCfg(DEFAULT_STYLE_CHECK)); }, []);

  const patch = async (p: Partial<StyleCheckConfig>) => {
    setBusy(true);
    try { setCfg(await saveStyleCheckConfig(p)); }
    catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  if (!cfg) return null;
  const [minRev, maxRev] = STYLE_CHECK_LIMITS.maxRevisions;
  return (
    <Card>
      <SectionTitle>{t.settings.styleCheck}</SectionTitle>
      <p className="mb-4 text-xs leading-relaxed text-ink-500">{t.settings.styleCheckDesc}</p>
      <div className="space-y-4">
        <Field label={t.settings.maxRevisions} hint={cfg.maxRevisions === 0 ? t.settings.maxRevisionsZeroHint : t.settings.maxRevisionsHint}>
          <Select disabled={busy} value={String(cfg.maxRevisions)} onChange={(e) => void patch({ maxRevisions: Number(e.target.value) })}>
            {Array.from({ length: maxRev - minRev + 1 }, (_, i) => minRev + i).map((n) => (
              <option key={n} value={n}>{n === 0 ? t.settings.revisionsNone : fmt(t.settings.revisionsN, { n })}</option>
            ))}
          </Select>
        </Field>
        <Field label={fmt(t.settings.fidelityLabel, { n: Math.round(cfg.defaultFidelity * 100) })} hint={t.settings.fidelityHint}>
          <input
            type="range" className="w-full" disabled={busy}
            min={STYLE_CHECK_LIMITS.defaultFidelity[0]} max={STYLE_CHECK_LIMITS.defaultFidelity[1]} step={0.05}
            value={cfg.defaultFidelity}
            onChange={(e) => setCfg({ ...cfg, defaultFidelity: Number(e.target.value) })}
            onMouseUp={(e) => void patch({ defaultFidelity: Number((e.target as HTMLInputElement).value) })}
            onTouchEnd={(e) => void patch({ defaultFidelity: Number((e.target as HTMLInputElement).value) })}
            onKeyUp={(e) => void patch({ defaultFidelity: Number((e.target as HTMLInputElement).value) })}
          />
        </Field>
        <Field label={fmt(t.settings.llmWeightLabel, { n: Math.round(cfg.llmScoreWeight * 100) })} hint={t.settings.llmWeightHint}>
          <input
            type="range" className="w-full" disabled={busy}
            min={STYLE_CHECK_LIMITS.llmScoreWeight[0]} max={STYLE_CHECK_LIMITS.llmScoreWeight[1]} step={0.05}
            value={cfg.llmScoreWeight}
            onChange={(e) => setCfg({ ...cfg, llmScoreWeight: Number(e.target.value) })}
            onMouseUp={(e) => void patch({ llmScoreWeight: Number((e.target as HTMLInputElement).value) })}
            onTouchEnd={(e) => void patch({ llmScoreWeight: Number((e.target as HTMLInputElement).value) })}
            onKeyUp={(e) => void patch({ llmScoreWeight: Number((e.target as HTMLInputElement).value) })}
          />
        </Field>
        <Field label={t.settings.maxInstructions} hint={t.settings.maxInstructionsHint}>
          <Select disabled={busy} value={String(cfg.maxInstructions)} onChange={(e) => void patch({ maxInstructions: Number(e.target.value) })}>
            {[3, 6, 8, 10, 12, 16, 20].map((n) => <option key={n} value={n}>{fmt(t.settings.instructionsN, { n })}</option>)}
          </Select>
        </Field>
      </div>
    </Card>
  );
}

/**
 * 「查看当前提示词」（§2.3 第 6 条）：模板全部硬编码在 `llm/prompts/*`，
 * 这里用一份示例输入把它们真的渲染一遍给用户看 —— 显示的就是代码里那份，不会走样。
 * 想改内容不用改代码：在每本书的「故事线 → 文风」里写「作者附加指令」。
 */
function PromptSection() {
  const [open, setOpen] = useState(false);
  const [previews, setPreviews] = useState<PromptPreview[]>([]);
  const [activeId, setActiveId] = useState<string>('');

  const show = () => {
    const list = promptPreviews();
    setPreviews(list);
    setActiveId(list[0]?.id ?? '');
    setOpen(true);
  };
  const active = previews.find((p) => p.id === activeId) ?? previews[0];

  return (
    <Card>
      <SectionTitle>{t.settings.prompts}</SectionTitle>
      <p className="mb-3 text-xs leading-relaxed text-ink-500">{t.settings.promptsDesc}</p>
      <Button size="sm" variant="secondary" onClick={show}><ScrollText size={16} strokeWidth={1.75} aria-hidden="true" />{t.settings.viewPrompts}</Button>

      <Dialog open={open} onClose={() => setOpen(false)} title={t.settings.promptsTitle} subtitle={t.settings.promptsSubtitle} width="max-w-4xl">
        <div className="grid max-h-[70vh] grid-cols-[190px_1fr] gap-4">
          <ul className="overflow-y-auto pr-1" aria-label={t.settings.promptList}>
            {previews.map((p) => (
              <li key={p.id}>
                <button
                  onClick={() => setActiveId(p.id)}
                  className={cn('mb-0.5 flex w-full flex-col items-start rounded-xl px-3 py-1.5 text-left text-sm transition',
                    p.id === activeId ? 'bg-paper-100 font-medium text-ink-900 dark:bg-paper-800 dark:text-paper-50' : 'text-ink-700 hover:bg-paper-100/60 dark:text-ink-300 dark:hover:bg-paper-800/60')}
                >
                  <span className="w-full truncate">{p.label}</span>
                  <span className="w-full truncate text-[11px] font-normal text-ink-400">{p.id}</span>
                </button>
              </li>
            ))}
          </ul>
          {active && (
            <div className="min-w-0 overflow-y-auto">
              <div className="mb-2 flex items-start gap-3">
                <p className="min-w-0 flex-1 text-xs leading-relaxed text-ink-500">{active.when}　<span className="text-ink-400">{fmt(t.settings.promptTemperature, { value: active.temperature })}</span></p>
                <Button size="sm" variant="ghost" onClick={() => void copyText(`# system\n${active.system}\n\n# user\n${active.user}`).then(
                  () => toast.success(t.common.copied), () => toast.error(t.error.copyFail),
                )}><Copy size={14} strokeWidth={1.75} aria-hidden="true" />{t.common.copy}</Button>
              </div>
              <PromptBlock title={t.settings.promptSystem} body={active.system} />
              <PromptBlock title={t.settings.promptUser} body={active.user} />
            </div>
          )}
        </div>
      </Dialog>
    </Card>
  );
}

function PromptBlock({ title, body }: { title: string; body: string }) {
  if (!body.trim()) return null;
  return (
    <div className="mb-3">
      <div className="mb-1 font-serif text-[11px] tracking-[0.2em] text-ink-500">{title}</div>
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-paper-100 p-3 text-xs leading-relaxed text-ink-700 dark:bg-paper-800 dark:text-ink-200">{body}</pre>
    </div>
  );
}

/**
 * 界面语言。这个偏好由 i18n 自己存 localStorage，不进 settingsStore、也不落库。
 * `useLocale()` 只是为了语言一变就重渲染，值仍然从 `currentLocale()` 取。
 */
function LanguageField() {
  useLocale();
  return (
    <Field label={t.settings.language} hint={t.settings.languageHint}>
      <Select value={currentLocale()} onChange={(e) => setLocale(e.target.value)}>
        {availableLocales().map((l) => <option key={l.code} value={l.code}>{l.nativeName}</option>)}
      </Select>
    </Field>
  );
}

/** 关于卡片里的更新流程：检查 → 提示新版本 → 下载安装 → 重启。 */
function UpdateRow() {
  const [phase, setPhase] = useState<'idle' | 'checking' | 'downloading' | 'installed'>('idle');
  const [hint, setHint] = useState('');
  const [found, setFound] = useState<{ version: string; notes: string } | null>(null);

  const check = async () => {
    setPhase('checking');
    setHint('');
    setFound(null);
    const r = await checkForUpdate();
    setPhase('idle');
    if (r.state === 'available') setFound({ version: r.update.version, notes: r.update.notes });
    else if (r.state === 'up-to-date') setHint(t.settings.upToDate);
    else setHint(r.reason);
  };

  const install = async () => {
    setPhase('downloading');
    try {
      await installPendingUpdate((p) => {
        const pct = progressPercent(p);
        setHint(pct === null ? fmt(t.settings.downloadedKb, { kb: Math.round(p.downloaded / 1024) }) : fmt(t.settings.downloadingPct, { pct }));
      });
      setPhase('installed');
      setHint(t.settings.updateInstalled);
    } catch (e) {
      setPhase('idle');
      setHint(fmt(t.settings.updateFailed, { msg: e instanceof Error ? e.message : String(e) }));
    }
  };

  const busy = phase === 'checking' || phase === 'downloading';
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => void check()}>
          <Download size={16} strokeWidth={1.75} />{phase === 'checking' ? t.settings.checkingUpdate : t.settings.checkUpdate}
        </Button>
        {found && phase !== 'installed' && (
          <Button size="sm" variant="primary" disabled={phase === 'downloading'} onClick={() => void install()}>
            {fmt(t.settings.downloadAndInstall, { version: found.version })}
          </Button>
        )}
        {phase === 'installed' && <Button size="sm" variant="primary" onClick={() => void relaunchApp()}>{t.settings.restartNow}</Button>}
      </div>
      {found && <p className="text-xs leading-relaxed text-ink-500">{fmt(t.settings.updateFound, { version: found.version })}{found.notes ? `：${found.notes}` : ''}</p>}
      {hint && <p role="status" aria-live="polite" className="text-xs leading-relaxed text-ink-400">{hint}</p>}
    </div>
  );
}

export function GeneralSettings() {
  const { settings, providers, update } = useSettings();
  const info = useAppInfo();

  const purposeSelect = (key: 'chat' | 'writing' | 'planning', label: string) => (
    <Field label={label}>
      <Select value={settings.defaultProviderId[key] ?? ''} onChange={(e) => update({ defaultProviderId: { ...settings.defaultProviderId, [key]: e.target.value || null } })}>
        <option value="">{t.settings.followDefaultProvider}</option>
        {providers.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.model}</option>)}
      </Select>
    </Field>
  );

  const [exporting, setExporting] = useState(false);
  const exportBundle = async () => {
    setExporting(true);
    try {
      const path = await exportDiagnosticsBundle();
      if (path) toast.success(fmt(t.settings.diagnosticsExported, { path }));
    } catch (e) {
      toast.error(fmt(t.settings.diagnosticsFailed, { msg: e instanceof Error ? e.message : String(e) }));
    } finally {
      setExporting(false);
    }
  };

  const copyDiagnostics = async () => {
    const lines = [
      `The Water ${info ? info.version : t.settings.unknownVersion}`,
      `${t.settings.tauriVersion} Tauri ${info?.tauriVersion ?? t.settings.unknown}`,
      `${t.settings.diagEnv} ${typeof navigator === 'undefined' ? t.settings.unknown : navigator.userAgent}`,
      `${t.settings.dataDir} ${info?.dataDir ?? t.settings.unknown}`,
      `${t.settings.logDir} ${info?.logDir ?? t.settings.unknown}`,
      fmt(t.settings.diagProviders, { n: providers.length }),
      `${t.settings.theme} ${settings.theme}`,
    ];
    try {
      await copyText(lines.join('\n'));
      toast.success(t.settings.diagnosticsCopied);
    } catch {
      toast.error(t.error.copyFail);
    }
  };

  return (
    <div className="max-w-xl space-y-6">
      <header>
        <h1 className="font-serif text-2xl font-semibold tracking-wide">{t.settings.general}</h1>
        <p className="mt-1 text-sm text-ink-500">{t.settings.generalDesc}</p>
      </header>

      <Card>
        <SectionTitle>{t.settings.purposeSection}</SectionTitle>
        <div className="space-y-4">
          {purposeSelect('chat', t.settings.purposeChat)}
          {purposeSelect('writing', t.settings.purposeWriting)}
          {purposeSelect('planning', t.settings.purposePlanning)}
        </div>
      </Card>

      <Card>
        <SectionTitle>{t.settings.appearance}</SectionTitle>
        <div className="space-y-4">
          <Field label={t.settings.theme}>
            <Select value={settings.theme} onChange={(e) => void update({ theme: e.target.value as ThemePref })}>
              <option value="system">{t.settings.themeSystem}</option>
              <option value="light">{t.settings.themeLight}</option>
              <option value="dark">{t.settings.themeDark}</option>
            </Select>
          </Field>
          <LanguageField />
        </div>
      </Card>

      <Card>
        <SectionTitle>{t.settings.writingSection}</SectionTitle>
        <div className="space-y-4">
          <label className="flex items-center gap-2.5 text-sm text-ink-800 dark:text-paper-100">
            <input type="checkbox" className="h-4 w-4 rounded" checked={settings.autoResumeJobs} onChange={(e) => update({ autoResumeJobs: e.target.checked })} />
            {t.settings.autoResume}
          </label>
        </div>
      </Card>

      <StyleCheckSection />

      <PromptSection />

      <DataSection />

      <Card>
        <SectionTitle>{t.settings.about}</SectionTitle>
        <div className="space-y-4">
          <div className="flex items-baseline gap-3 text-sm">
            <span className="font-serif text-base font-semibold tracking-wide">The Water</span>
            <span className="text-ink-500">{t.settings.version} {info?.version ?? '—'}</span>
            <span className="text-xs text-ink-400">{t.settings.tauriVersion} {info?.tauriVersion ?? '—'}</span>
          </div>
          {info && <DirRow label={t.settings.dataDir} path={info.dataDir} />}
          {info && <DirRow label={t.settings.logDir} path={info.logDir} />}
          <p className="text-xs leading-relaxed text-ink-400">{t.settings.checkUpdateHint}</p>
          <UpdateRow />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={() => void copyDiagnostics()}>{t.settings.copyDiagnostics}</Button>
            <Button size="sm" variant="secondary" disabled={exporting} onClick={() => void exportBundle()}>
              <LifeBuoy size={16} strokeWidth={1.75} />{exporting ? t.settings.exportingDiagnostics : t.settings.exportDiagnostics}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
