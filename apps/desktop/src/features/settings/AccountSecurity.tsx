/**
 * 账号安全入口（P0-4）：邮箱验证、修改密码、忘记密码、登录设备、数据导出、注销账号。
 * 桌面端没有浏览器回调，所以邮件里同时给链接和验证码，这里让用户粘贴验证码。
 */
import { useEffect, useState } from 'react';
import { save } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';
import { Download, KeyRound, Laptop, MailCheck, Trash2 } from 'lucide-react';
import type { SessionSummary } from '@the-water/shared';
import { Badge, Button, confirm, Dialog, Field, Input, SectionTitle, Select, Spinner } from '@/components/ui';
import { toast } from '@/components/Toast';
import { useAccount } from '@/stores/accountStore';
import { deleteAccount, forgotPassword, getClient, getServerUrl, resetPassword } from '@/sync/account';
import { describeError } from '@/sync/api';

const MIN_PASSWORD = 8;

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
    if (newPassword.length < MIN_PASSWORD) { toast.error(`新密码至少 ${MIN_PASSWORD} 位`); return; }
    if (newPassword !== repeat) { toast.error('两次输入的新密码不一致'); return; }
    setBusy(true);
    try {
      const client = await getClient();
      if (!client) { toast.error('尚未登录'); return; }
      await client.changePassword({ currentPassword, newPassword });
      toast.success('密码已修改，其它设备需要重新登录');
      onClose();
    } catch (e) {
      toast.error(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="修改密码" subtitle="改完之后，除了这台设备，其它登录都会失效。" width="max-w-md">
      <div className="space-y-4">
        <Field label="当前密码">
          <Input type="password" value={currentPassword} autoComplete="current-password" onChange={(e) => setCurrent(e.target.value)} />
        </Field>
        <Field label="新密码" hint={`至少 ${MIN_PASSWORD} 位`}>
          <Input type="password" value={newPassword} autoComplete="new-password" onChange={(e) => setNext(e.target.value)} />
        </Field>
        <Field label="再输一次新密码">
          <Input type="password" value={repeat} autoComplete="new-password" onChange={(e) => setRepeat(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }} />
        </Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={submit} disabled={busy || !currentPassword || !newPassword}>
            {busy && <Spinner className="h-3 w-3" />}保存
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
    if (!email.trim()) { toast.error('请填写邮箱'); return; }
    setBusy(true);
    try {
      await forgotPassword(serverUrl, email);
      setSent(true);
      toast.info('如果这个邮箱注册过，重置邮件已经发出了');
    } catch (e) {
      toast.error(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (password.length < MIN_PASSWORD) { toast.error(`新密码至少 ${MIN_PASSWORD} 位`); return; }
    setBusy(true);
    try {
      await resetPassword(serverUrl, token, password);
      await refresh();
      toast.success('密码已重置，请用新密码重新登录');
      onClose();
    } catch (e) {
      toast.error(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="忘记密码" subtitle="我们会往这个邮箱发一封信，里面有一次性验证码。" width="max-w-md">
      <div className="space-y-4">
        <Field label="邮箱">
          <Input type="email" value={email} autoComplete="username" onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <div className="flex justify-end">
          <Button size="sm" onClick={sendMail} disabled={busy}>{busy && <Spinner className="h-3 w-3" />}{sent ? '重新发送' : '发送重置邮件'}</Button>
        </div>
        {sent && (
          <>
            <Field label="邮件里的验证码" hint="1 小时内有效，只能用一次">
              <Input value={token} spellCheck={false} autoCapitalize="none" onChange={(e) => setToken(e.target.value)} placeholder="tw_…" />
            </Field>
            <Field label="新密码" hint={`至少 ${MIN_PASSWORD} 位`}>
              <Input type="password" value={password} autoComplete="new-password" onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }} />
            </Field>
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" onClick={onClose}>取消</Button>
              <Button variant="primary" onClick={submit} disabled={busy || !token.trim() || !password}>
                {busy && <Spinner className="h-3 w-3" />}重置密码
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
      if (!client) { toast.error('尚未登录'); return; }
      await client.requestEmailVerification();
      setSent(true);
      toast.info('验证邮件已发出（邮箱已验证过的话不会重复发送）');
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
      if (!client) { toast.error('尚未登录'); return; }
      await client.verifyEmail(token.trim());
      toast.success('邮箱已验证');
      onClose();
    } catch (e) {
      toast.error(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="验证邮箱" subtitle="验证过的邮箱才能找回密码。" width="max-w-md">
      <div className="space-y-4">
        <div className="flex justify-end">
          <Button size="sm" onClick={sendMail} disabled={busy}>{busy && <Spinner className="h-3 w-3" />}{sent ? '重新发送' : '发送验证邮件'}</Button>
        </div>
        <Field label="邮件里的验证码" hint="24 小时内有效，只能用一次">
          <Input value={token} spellCheck={false} autoCapitalize="none" onChange={(e) => setToken(e.target.value)} placeholder="tw_…" onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }} />
        </Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>关闭</Button>
          <Button variant="primary" onClick={submit} disabled={busy || !token.trim()}>
            {busy && <Spinner className="h-3 w-3" />}完成验证
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
    if (s.current && !(await confirm({ title: '退出当前设备？', description: '这是你正在使用的设备，退出后需要重新登录。', confirmText: '退出', tone: 'danger' }))) return;
    try {
      const client = await getClient();
      if (!client) return;
      await client.revokeSession(s.id);
      if (s.current) {
        await refresh();
        onClose();
        toast.info('已退出登录');
        return;
      }
      setItems((prev) => (prev ? prev.filter((x) => x.id !== s.id) : prev));
      toast.success('已注销这台设备');
    } catch (e) {
      toast.error(describeError(e));
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="登录设备" subtitle="不认识的设备，直接注销掉。" width="max-w-lg">
      {items === null ? (
        <div className="text-sm text-ink-400">正在加载…</div>
      ) : items.length === 0 ? (
        <div className="text-sm text-ink-400">没有找到登录记录。</div>
      ) : (
        <ul className="space-y-2">
          {items.map((s) => (
            <li key={s.id} className="flex items-center gap-3 rounded-xl bg-paper-100/70 px-3 py-2.5 dark:bg-paper-950/50">
              <Laptop size={16} strokeWidth={1.75} className="shrink-0 text-ink-400" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm text-ink-800 dark:text-paper-100">{s.clientLabel || '未命名设备'}</span>
                  {s.current && <Badge tone="green">当前设备</Badge>}
                </div>
                <div className="mt-0.5 text-xs text-ink-400">最近活动 {formatTime(s.lastUsedAt)} · 登录于 {formatTime(s.createdAt)}</div>
              </div>
              <Button size="sm" variant="ghost" className="hover:text-cinnabar-600" onClick={() => revoke(s)}>注销</Button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={() => void load()} disabled={busy}>刷新</Button>
        <Button size="sm" variant="ghost" onClick={onClose}>关闭</Button>
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
    if (confirmText.trim() !== '注销账号') { toast.error('请输入「注销账号」四个字确认'); return; }
    setBusy(true);
    try {
      await deleteAccount(password, mode);
      await refresh();
      toast.success('账号已注销');
      onClose();
    } catch (e) {
      toast.error(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="注销账号" subtitle="这一步不可撤销，建议先导出数据。" width="max-w-md">
      <div className="space-y-4">
        <Field label="已发布的作品怎么处理">
          <Select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
            <option value="keep_works">保留作品，作者显示为「已注销用户」</option>
            <option value="delete_works">连同作品一起下架</option>
          </Select>
        </Field>
        <p className="text-xs leading-relaxed text-ink-500">
          {mode === 'keep_works'
            ? '读者仍能看到这些故事，但看不到你的昵称、@用户名和简介，也无法再找到你的主页。'
            : '你的全部作品会被下架，读者不再能打开。已经派生出去的二创不受影响。'}
        </p>
        <Field label="当前密码">
          <Input type="password" value={password} autoComplete="current-password" onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Field label="输入「注销账号」确认">
          <Input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder="注销账号" onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }} />
        </Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button variant="danger" onClick={submit} disabled={busy || !password}>
            {busy && <Spinner className="h-3 w-3" />}确认注销
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
      if (!client) { toast.error('尚未登录'); return; }
      const dump = await client.exportAccount();
      const path = await save({
        defaultPath: `the-water-账号数据-${dump.exportedAt.slice(0, 10)}.json`,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (!path) return;
      await writeTextFile(path, JSON.stringify(dump, null, 2));
      const skipped = dump.skipped.length ? `，${dump.skipped.length} 本未包含` : '';
      toast.success(`已导出 ${dump.novels.length} 本作品${skipped}`);
    } catch (e) {
      toast.error(describeError(e));
    } finally {
      setExporting(false);
    }
  };

  return (
    <section>
      <SectionTitle>账号安全</SectionTitle>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => setDialog('verify')}><MailCheck size={16} strokeWidth={1.75} />验证邮箱</Button>
        <Button size="sm" onClick={() => setDialog('password')}><KeyRound size={16} strokeWidth={1.75} />修改密码</Button>
        <Button size="sm" variant="ghost" onClick={() => setDialog('forgot')}>忘记密码</Button>
        <Button size="sm" variant="ghost" onClick={() => setDialog('sessions')}><Laptop size={16} strokeWidth={1.75} />登录设备</Button>
        <Button size="sm" variant="ghost" onClick={doExport} disabled={exporting}>
          {exporting ? <Spinner className="h-3 w-3" /> : <Download size={16} strokeWidth={1.75} />}导出我的数据
        </Button>
        <Button size="sm" variant="danger" onClick={() => setDialog('delete')}><Trash2 size={16} strokeWidth={1.75} />注销账号</Button>
      </div>
      <ChangePasswordDialog open={dialog === 'password'} onClose={() => setDialog(null)} />
      <ForgotPasswordDialog open={dialog === 'forgot'} onClose={() => setDialog(null)} />
      <VerifyEmailDialog open={dialog === 'verify'} onClose={() => setDialog(null)} />
      <SessionsDialog open={dialog === 'sessions'} onClose={() => setDialog(null)} />
      <DeleteAccountDialog open={dialog === 'delete'} onClose={() => setDialog(null)} />
    </section>
  );
}
