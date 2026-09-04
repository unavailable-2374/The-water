import { useEffect, useState } from 'react';
import { Database, FolderOpen, Upload } from 'lucide-react';
import { fmt, t } from '@/i18n/zh';
import { Button, Card, Field, SectionTitle, Select, confirm } from '@/components/ui';
import { toast } from '@/components/Toast';
import { backupDatabase, openDataDir, restoreDatabase } from '@/db/backup';
import { copyText } from '@/platform/clipboard';
import { useSettings } from '@/stores/settingsStore';
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
    toast.error(`打不开目录：${e instanceof Error ? e.message : String(e)}`);
  }
}

function DirRow({ label, path }: { label: string; path: string }) {
  return (
    <div className="flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium tracking-wide text-ink-600 dark:text-ink-300">{label}</div>
        <div className="truncate text-xs text-ink-400" title={path}>{path}</div>
      </div>
      <Button size="sm" variant="ghost" onClick={() => void reveal(path)}><FolderOpen size={16} strokeWidth={1.75} />{t.settings.openDir}</Button>
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
          <Database size={16} strokeWidth={1.75} />{t.settings.backup}
        </Button>
        <Button variant="danger" disabled={busy} onClick={() => void restore()}>
          <Upload size={16} strokeWidth={1.75} />{t.settings.restore}
        </Button>
        <Button disabled={busy} onClick={() => void run(async () => { await openDataDir(); })}>
          <FolderOpen size={16} strokeWidth={1.75} />{t.settings.openDataDir}
        </Button>
      </div>
    </Card>
  );
}

export function GeneralSettings() {
  const { settings, providers, update } = useSettings();
  const info = useAppInfo();

  const purposeSelect = (key: 'chat' | 'writing' | 'planning', label: string) => (
    <Field label={label}>
      <Select value={settings.defaultProviderId[key] ?? ''} onChange={(e) => update({ defaultProviderId: { ...settings.defaultProviderId, [key]: e.target.value || null } })}>
        <option value="">（跟随默认供应商）</option>
        {providers.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.model}</option>)}
      </Select>
    </Field>
  );

  const copyDiagnostics = async () => {
    const lines = [
      `The Water ${info ? info.version : '未知版本'}`,
      `运行时 Tauri ${info?.tauriVersion ?? '未知'}`,
      `环境 ${typeof navigator === 'undefined' ? '未知' : navigator.userAgent}`,
      `数据目录 ${info?.dataDir ?? '未知'}`,
      `日志目录 ${info?.logDir ?? '未知'}`,
      `供应商 ${providers.length} 个`,
      `主题 ${settings.theme}`,
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
        <p className="mt-1 text-sm text-ink-500">决定不同场景下，由哪个模型来陪你。</p>
      </header>

      <Card>
        <SectionTitle>各场景使用的模型</SectionTitle>
        <div className="space-y-4">
          {purposeSelect('chat', t.settings.purposeChat)}
          {purposeSelect('writing', t.settings.purposeWriting)}
          {purposeSelect('planning', t.settings.purposePlanning)}
        </div>
      </Card>

      <Card>
        <SectionTitle>外观</SectionTitle>
        <Field label={t.settings.theme}>
          <Select value={settings.theme} onChange={(e) => void update({ theme: e.target.value as ThemePref })}>
            <option value="system">{t.settings.themeSystem}</option>
            <option value="light">{t.settings.themeLight}</option>
            <option value="dark">{t.settings.themeDark}</option>
          </Select>
        </Field>
      </Card>

      <Card>
        <SectionTitle>写作</SectionTitle>
        <div className="space-y-4">
          <label className="flex items-center gap-2.5 text-sm text-ink-800 dark:text-paper-100">
            <input type="checkbox" className="h-4 w-4 rounded" checked={settings.autoResumeJobs} onChange={(e) => update({ autoResumeJobs: e.target.checked })} />
            {t.settings.autoResume}
          </label>
          <Field label={t.settings.countMode}>
            <Select value={settings.countMode} onChange={(e) => update({ countMode: e.target.value as 'all' | 'han' })}>
              <option value="all">{t.settings.countAll}</option>
              <option value="han">{t.settings.countHan}</option>
            </Select>
          </Field>
        </div>
      </Card>

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
          <Button size="sm" variant="secondary" onClick={() => void copyDiagnostics()}>{t.settings.copyDiagnostics}</Button>
        </div>
      </Card>
    </div>
  );
}
