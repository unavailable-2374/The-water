/**
 * 账号安全入口（P0-4）：邮箱验证、修改密码、忘记密码、登录设备、数据导出、注销账号。
 * 桌面端没有浏览器回调，所以邮件里同时给链接和验证码，这里让用户粘贴验证码。
 */
import { useEffect, useState } from 'react';
import { save } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';
import { Download, KeyRound, Laptop, MailCheck, Trash2 } from 'lucide-react';
import type { SessionSummary } from '@the-water/shared';
import { fmt, t } from '@/i18n';
import { Badge, Button, confirm, Dialog, Field, Input, SectionTitle, Select, Spinner } from '@/components/ui';
import { toast } from '@/components/Toast';
import { useAccount } from '@/stores/accountStore';
import { deleteAccount, forgotPassword, getClient, getServerUrl, resetPassword } from '@/sync/account';
import { describeError } from '@/sync/api';

/** 密码最少位数，与服务端保持一致。 */
export const MIN_PASSWORD = 8;

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/** 修改密码：旧密码 + 新密码，成功后其它设备被登出。 */
function ChangePasswordDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [currentPassword, setCurrent] = useState('');
  const [newPassword, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setCurrent('');
    setNext('');
    setRepeat('');
  }, [open]);

  const submit = async () => {
    if (newPassword.length < MIN_PASSWORD) { toast.error(fmt(t.settings.newPasswordTooShort, { n: MIN_PASSWORD })); return; }
    if (newPassword !== repeat) { toast.error(t.settings.passwordMismatch); return; }
    setBusy(true);
    try {
      const client = await getClient();
      if (!client) { toast.error(t.settings.notLoggedIn); return; }
      await client.changePassword({ currentPassword, newPassword });
      toast.success(t.settings.passwordChanged);
      onClose();
    } catch (e) {
      toast.error(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title={t.settings.changePassword} subtitle={t.settings.changePasswordDesc} width="max-w-md">
      <div className="space-y-4">
        <Field label={t.settings.currentPassword}>
          <Input type="password" value={currentPassword} autoComplete="current-password" onChange={(e) => setCurrent(e.target.value)} />
        </Field>
        <Field label={t.settings.newPassword} hint={fmt(t.settings.passwordHint, { n: MIN_PASSWORD })}>
          <Input type="password" value={newPassword} autoComplete="new-password" onChange={(e) => setNext(e.target.value)} />
        </Field>
        <Field label={t.settings.repeatPassword}>
          <Input type="password" value={repeat} autoComplete="new-password" onChange={(e) => setRepeat(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }} />
        </Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>{t.common.cancel}</Button>
          <Button variant="primary" onClick={submit} disabled={busy || !currentPassword || !newPassword}>
            {busy && <Spinner className="h-3 w-3" />}{t.common.save}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/**
 * 忘记密码：先发邮件，再用邮件里的验证码设置新密码。
 * 登录页与设置页共用；服务端不会告诉我们这个邮箱有没有注册过，所以文案要中立。
 */
export function ForgotPasswordDialog({ open, onClose, defaultEmail = '' }: { open: boolean; onClose: () => void; defaultEmail?: string }) {
  const refresh = useAccount((s) => s.refresh);
  const [serverUrl, setServerUrl] = useState('');
  const [email, setEmail] = useState(defaultEmail);
  const [token, setToken] = useState('');
  const [password, setPassword] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setEmail(defaultEmail);
    setToken('');
    setPassword('');
    setSent(false);
    void getServerUrl().then(setServerUrl);
  }, [open, defaultEmail]);

  const sendMail = async () => {
    if (!email.trim()) { toast.error(t.settings.emailRequired); return; }
    setBusy(true);
    try {
      await forgotPassword(serverUrl, email);
      setSent(true);
      toast.info(t.settings.resetMailSent);
    } catch (e) {
      toast.error(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (password.length < MIN_PASSWORD) { toast.error(fmt(t.settings.newPasswordTooShort, { n: MIN_PASSWORD })); return; }
    setBusy(true);
    try {
      await resetPassword(serverUrl, token, password);
      await refresh();
      toast.success(t.settings.passwordReset);
      onClose();
    } catch (e) {
      toast.error(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title={t.settings.forgotPassword} subtitle={t.settings.forgotPasswordDesc} width="max-w-md">
      <div className="space-y-4">
        <Field label={t.settings.email}>
          <Input type="email" value={email} autoComplete="username" onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <div className="flex justify-end">
          <Button size="sm" onClick={sendMail} disabled={busy}>{busy && <Spinner className="h-3 w-3" />}{sent ? t.settings.resendMail : t.settings.sendResetMail}</Button>
        </div>
        {sent && (
          <>
            <Field label={t.settings.mailCode} hint={t.settings.mailCodeHint1h}>
              <Input value={token} spellCheck={false} autoCapitalize="none" onChange={(e) => setToken(e.target.value)} placeholder="tw_…" />
            </Field>
            <Field label={t.settings.newPassword} hint={fmt(t.settings.passwordHint, { n: MIN_PASSWORD })}>
              <Input type="password" value={password} autoComplete="new-password" onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }} />
            </Field>
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" onClick={onClose}>{t.common.cancel}</Button>
              <Button variant="primary" onClick={submit} disabled={busy || !token.trim() || !password}>
                {busy && <Spinner className="h-3 w-3" />}{t.settings.resetPassword}
              </Button>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}

/** 邮箱验证：发信 + 粘贴验证码。 */
function VerifyEmailDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [token, setToken] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setToken('');
    setSent(false);
  }, [open]);

  const sendMail = async () => {
    setBusy(true);
    try {
      const client = await getClient();
      if (!client) { toast.error(t.settings.notLoggedIn); return; }
      await client.requestEmailVerification();
      setSent(true);
      toast.info(t.settings.verifyMailSent);
    } catch (e) {
      toast.error(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    setBusy(true);
    try {
      const client = await getClient();
      if (!client) { toast.error(t.settings.notLoggedIn); return; }
      await client.verifyEmail(token.trim());
      toast.success(t.settings.emailVerified);
      onClose();
    } catch (e) {
      toast.error(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title={t.settings.verifyEmail} subtitle={t.settings.verifyEmailDesc} width="max-w-md">
      <div className="space-y-4">
        <div className="flex justify-end">
          <Button size="sm" onClick={sendMail} disabled={busy}>{busy && <Spinner className="h-3 w-3" />}{sent ? t.settings.resendMail : t.settings.sendVerifyMail}</Button>
        </div>
        <Field label={t.settings.mailCode} hint={t.settings.mailCodeHint24h}>
          <Input value={token} spellCheck={false} autoCapitalize="none" onChange={(e) => setToken(e.target.value)} placeholder="tw_…" onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }} />
        </Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>{t.common.close}</Button>
          <Button variant="primary" onClick={submit} disabled={busy || !token.trim()}>
            {busy && <Spinner className="h-3 w-3" />}{t.settings.finishVerify}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/** 登录设备列表：看得到每台设备，也能单独踢掉。 */
function SessionsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const refresh = useAccount((s) => s.refresh);
  const [items, setItems] = useState<SessionSummary[] | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setBusy(true);
    try {
      const client = await getClient();
      if (!client) { setItems([]); return; }
      setItems((await client.listSessions()).sessions);
    } catch (e) {
      toast.error(describeError(e));
      setItems([]);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => { if (open) void load(); }, [open]);

  const revoke = async (s: SessionSummary) => {
    if (s.current && !(await confirm({ title: t.settings.revokeCurrentTitle, description: t.settings.revokeCurrentDesc, confirmText: t.settings.signOut, tone: 'danger' }))) return;
    try {
      const client = await getClient();
      if (!client) return;
      await client.revokeSession(s.id);
      if (s.current) {
        await refresh();
        onClose();
        toast.info(t.settings.loggedOut);
        return;
      }
      setItems((prev) => (prev ? prev.filter((x) => x.id !== s.id) : prev));
      toast.success(t.settings.sessionRevoked);
    } catch (e) {
      toast.error(describeError(e));
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title={t.settings.sessions} subtitle={t.settings.sessionsDesc} width="max-w-lg">
      {items === null ? (
        <div className="text-sm text-ink-400" role="status">{t.common.loading}</div>
      ) : items.length === 0 ? (
        <div className="text-sm text-ink-400">{t.settings.sessionsEmpty}</div>
      ) : (
        <ul className="space-y-2" aria-label={t.settings.sessionsList}>
          {items.map((s) => (
            <li key={s.id} className="flex items-center gap-3 rounded-xl bg-paper-100/70 px-3 py-2.5 dark:bg-paper-950/50">
              <Laptop size={16} strokeWidth={1.75} className="shrink-0 text-ink-400" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm text-ink-800 dark:text-paper-100">{s.clientLabel || t.settings.unnamedDevice}</span>
                  {s.current && <Badge tone="green">{t.settings.currentDevice}</Badge>}
                </div>
                <div className="mt-0.5 text-xs text-ink-400">{fmt(t.settings.sessionMeta, { last: formatTime(s.lastUsedAt), created: formatTime(s.createdAt) })}</div>
              </div>
              <Button size="sm" variant="ghost" className="hover:text-cinnabar-600" onClick={() => revoke(s)}>{t.settings.revoke}</Button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={() => void load()} disabled={busy}>{t.settings.refresh}</Button>
        <Button size="sm" variant="ghost" onClick={onClose}>{t.common.close}</Button>
      </div>
    </Dialog>
  );
}

/** 注销账号：先让用户想清楚作品怎么处理，再输密码确认。 */
function DeleteAccountDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const refresh = useAccount((s) => s.refresh);
  const [mode, setMode] = useState<'keep_works' | 'delete_works'>('keep_works');
  const [password, setPassword] = useState('');
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setMode('keep_works');
    setPassword('');
    setConfirmText('');
  }, [open]);

  const submit = async () => {
    if (confirmText.trim() !== t.settings.deleteAccount) { toast.error(fmt(t.settings.deleteAccountConfirmTip, { word: t.settings.deleteAccount })); return; }
    setBusy(true);
    try {
      await deleteAccount(password, mode);
      await refresh();
      toast.success(t.settings.accountDeleted);
      onClose();
    } catch (e) {
      toast.error(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title={t.settings.deleteAccount} subtitle={t.settings.deleteAccountDesc} width="max-w-md">
      <div className="space-y-4">
        <Field label={t.settings.worksHandling}>
          <Select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
            <option value="keep_works">{t.settings.keepWorks}</option>
            <option value="delete_works">{t.settings.deleteWorks}</option>
          </Select>
        </Field>
        <p className="text-xs leading-relaxed text-ink-500">
          {mode === 'keep_works' ? t.settings.keepWorksDesc : t.settings.deleteWorksDesc}
        </p>
        <Field label={t.settings.currentPassword}>
          <Input type="password" value={password} autoComplete="current-password" onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Field label={fmt(t.settings.deleteAccountConfirmLabel, { word: t.settings.deleteAccount })}>
          <Input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder={t.settings.deleteAccount} onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }} />
        </Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>{t.common.cancel}</Button>
          <Button variant="danger" onClick={submit} disabled={busy || !password}>
            {busy && <Spinner className="h-3 w-3" />}{t.settings.confirmDeleteAccount}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/** 设置页里的「账号安全」区块。 */
export function AccountSecuritySection() {
  const [dialog, setDialog] = useState<'password' | 'forgot' | 'verify' | 'sessions' | 'delete' | null>(null);
  const [exporting, setExporting] = useState(false);

  const doExport = async () => {
    setExporting(true);
    try {
      const client = await getClient();
      if (!client) { toast.error(t.settings.notLoggedIn); return; }
      const dump = await client.exportAccount();
      const path = await save({
        defaultPath: fmt(t.settings.exportFileName, { date: dump.exportedAt.slice(0, 10) }),
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (!path) return;
      await writeTextFile(path, JSON.stringify(dump, null, 2));
      const skipped = dump.skipped.length ? fmt(t.settings.exportSkipped, { n: dump.skipped.length }) : '';
      toast.success(fmt(t.settings.exportDone, { n: dump.novels.length, skipped }));
    } catch (e) {
      toast.error(describeError(e));
    } finally {
      setExporting(false);
    }
  };

  return (
    <section>
      <SectionTitle>{t.settings.security}</SectionTitle>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => setDialog('verify')}><MailCheck size={16} strokeWidth={1.75} aria-hidden="true" />{t.settings.verifyEmail}</Button>
        <Button size="sm" onClick={() => setDialog('password')}><KeyRound size={16} strokeWidth={1.75} aria-hidden="true" />{t.settings.changePassword}</Button>
        <Button size="sm" variant="ghost" onClick={() => setDialog('forgot')}>{t.settings.forgotPassword}</Button>
        <Button size="sm" variant="ghost" onClick={() => setDialog('sessions')}><Laptop size={16} strokeWidth={1.75} aria-hidden="true" />{t.settings.sessions}</Button>
        <Button size="sm" variant="ghost" onClick={doExport} disabled={exporting}>
          {exporting ? <Spinner className="h-3 w-3" /> : <Download size={16} strokeWidth={1.75} aria-hidden="true" />}{t.settings.exportData}
        </Button>
        <Button size="sm" variant="danger" onClick={() => setDialog('delete')}><Trash2 size={16} strokeWidth={1.75} aria-hidden="true" />{t.settings.deleteAccount}</Button>
      </div>
      <ChangePasswordDialog open={dialog === 'password'} onClose={() => setDialog(null)} />
      <ForgotPasswordDialog open={dialog === 'forgot'} onClose={() => setDialog(null)} />
      <VerifyEmailDialog open={dialog === 'verify'} onClose={() => setDialog(null)} />
      <SessionsDialog open={dialog === 'sessions'} onClose={() => setDialog(null)} />
      <DeleteAccountDialog open={dialog === 'delete'} onClose={() => setDialog(null)} />
    </section>
  );
}
