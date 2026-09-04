import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { ExternalLink, LogOut, Pencil, RefreshCw, Trash2, UserRound } from 'lucide-react';
import { LICENSE_LABELS, type NovelSummary } from '@the-water/shared';
import { t } from '@/i18n/zh';
import { Badge, Button, Card, EmptyState, Field, Input, SectionTitle, Spinner, cn } from '@/components/ui';
import { Avatar } from '@/components/Avatar';
import { authorPath } from '@/components/UserChip';
import { LevelBadge } from '@/features/community/LevelBadge';
import { ProfileEditDialog } from './ProfileEditDialog';
import { PointsCard } from './PointsCard';
import { useCommunity } from '@/stores/communityStore';
import { toast } from '@/components/Toast';
import { listNovels, updateNovel } from '@/db/repos/novelsRepo';
import { useAccount } from '@/stores/accountStore';
import { DEFAULT_SERVER_URL, getClient, getServerUrl, login, logout, register, setServerUrl } from '@/sync/account';
import { describeError } from '@/sync/api';

/** Login / register form. Reused by the settings panel and the public-area login dialog. */
export function LoginForm({ onDone }: { onDone?: () => void }) {
  const refresh = useAccount((s) => s.refresh);
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [serverUrl, setServer] = useState(DEFAULT_SERVER_URL);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { void getServerUrl().then(setServer); }, []);

  const submit = async () => {
    if (!serverUrl.trim() || !email.trim() || !password) { toast.error('请填写服务器地址、邮箱和密码'); return; }
    if (mode === 'register' && password.length < 8) { toast.error('密码至少 8 位'); return; }
    if (mode === 'register' && !displayName.trim()) { toast.error('请填写昵称'); return; }
    setBusy(true);
    try {
      const account = mode === 'login' ? await login(serverUrl, email, password) : await register(serverUrl, email, password, displayName);
      await refresh();
      toast.success(`已登录：${account.displayName}`);
      onDone?.();
    } catch (e) {
      toast.error(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex gap-1 rounded-full bg-paper-200/70 p-1 text-sm dark:bg-paper-950/60">
        {(['login', 'register'] as const).map((m) => (
          <button key={m} type="button" onClick={() => setMode(m)} className={cn('flex-1 rounded-full px-3 py-1.5 transition', mode === m ? 'bg-paper-0 font-medium text-ink-900 shadow-soft dark:bg-paper-800 dark:text-paper-50' : 'text-ink-500 hover:text-ink-800 dark:hover:text-paper-100')}>
            {m === 'login' ? t.publicArea.login : t.publicArea.register}
          </button>
        ))}
      </div>
      <Field label={t.publicArea.serverUrl}>
        <Input value={serverUrl} onChange={(e) => setServer(e.target.value)} onBlur={() => void setServerUrl(serverUrl)} placeholder={DEFAULT_SERVER_URL} />
      </Field>
      <Field label="邮箱"><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" /></Field>
      <Field label="密码" hint={mode === 'register' ? '至少 8 位' : undefined}>
        <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }} />
      </Field>
      {mode === 'register' && <Field label="昵称"><Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={32} /></Field>}
      <div className="flex justify-end pt-1">
        <Button variant="primary" onClick={submit} disabled={busy}>
          {busy && <Spinner className="h-3 w-3" />}
          {mode === 'login' ? t.publicArea.login : t.publicArea.register}
        </Button>
      </div>
    </div>
  );
}

export function AccountPanel() {
  const { account, loaded, refresh } = useAccount();
  useEffect(() => { if (!loaded) void refresh(); }, [loaded, refresh]);

  if (!loaded) return <div className="text-sm text-ink-400">{t.common.loading}</div>;
  if (!account) {
    return (
      <div className="max-w-md space-y-6">
        <header>
          <h1 className="font-serif text-2xl font-semibold tracking-wide">{t.settings.account}</h1>
          <p className="mt-1 text-sm leading-relaxed text-ink-500">登录后，可以把写好的故事放进公共书房，也能为喜欢的故事点赞、续写。</p>
        </header>
        <Card>
          <LoginForm />
        </Card>
      </div>
    );
  }
  return <LoggedIn />;
}

function LoggedIn() {
  const { account, refresh } = useAccount();
  const nav = useNavigate();
  const me = useCommunity((s) => s.me);
  const loadMe = useCommunity((s) => s.loadMe);
  const [items, setItems] = useState<NovelSummary[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  useEffect(() => { if (!me) void loadMe(); }, [me, loadMe]);

  const load = async (append = false) => {
    setBusy(true);
    try {
      const client = await getClient();
      if (!client) return;
      const page = await client.myNovels({ cursor: append && cursor ? cursor : undefined, limit: 50 });
      setItems((prev) => (append && prev ? [...prev, ...page.items] : page.items));
      setCursor(page.nextCursor);
    } catch (e) {
      toast.error(describeError(e));
      setItems((prev) => prev ?? []);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => { void load(); }, []);

  const doLogout = async () => {
    await logout();
    await refresh();
    toast.info('已退出登录');
  };

  const unpublish = async (n: NovelSummary) => {
    if (!confirm(`确定下架《${n.title}》？读者将无法再看到它，已派生的二创不受影响。`)) return;
    try {
      const client = await getClient();
      if (!client) return;
      await client.deleteNovel(n.id);
      // Detach the local novel so the next publish creates a fresh remote entry.
      for (const local of await listNovels()) {
        if (local.remote?.novelId === n.id && local.remote.serverUrl === client.baseUrl) await updateNovel(local.id, { remote: null });
      }
      setItems((prev) => (prev ? prev.filter((x) => x.id !== n.id) : prev));
      toast.success('已下架');
    } catch (e) {
      toast.error(describeError(e));
    }
  };

  if (!account) return null;
  return (
    <div className="max-w-2xl space-y-8">
      <div className="relative overflow-hidden rounded-2xl bg-paper-0 p-6 shadow-soft dark:bg-paper-900">
        <div className="pointer-events-none absolute inset-0 paper-texture opacity-70" />
        <div className="relative flex items-center gap-5">
          {account.displayName.trim() ? (
            <Avatar seed={account.handle || account.userId} name={account.displayName} size="lg" />
          ) : (
            <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-tea-50 text-tea-700 dark:bg-tea-800/40 dark:text-tea-200">
              <UserRound size={22} strokeWidth={1.75} />
            </div>
          )}
          <div className="min-w-0 flex-1">
            <div className="text-[10px] tracking-[0.2em] text-ink-400">THE WATER · 读者</div>
            <div className="mt-0.5 flex items-center gap-2">
              <span className="truncate font-serif text-xl font-semibold tracking-wide text-ink-900 dark:text-paper-100">{account.displayName}</span>
              {me && <LevelBadge level={me.level} />}
            </div>
            <div className="mt-0.5 truncate text-xs text-ink-400">{account.handle ? `@${account.handle} · ` : ''}{account.serverUrl}</div>
            {me?.bio && <div className="mt-1 line-clamp-2 text-xs leading-relaxed text-ink-500">{me.bio}</div>}
          </div>
          <Button size="sm" variant="ghost" onClick={doLogout}><LogOut size={16} strokeWidth={1.75} />{t.publicArea.logout}</Button>
        </div>
        <div className="relative mt-4 flex flex-wrap gap-2">
          <Button size="sm" onClick={() => setEditOpen(true)}><Pencil size={16} strokeWidth={1.75} />{t.community.editProfile}</Button>
          {account.handle && (
            <Button size="sm" variant="ghost" onClick={() => nav(authorPath({ id: account.userId, handle: account.handle }))}>
              <ExternalLink size={16} strokeWidth={1.75} />{t.community.myPage}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => nav('/settings/community')}>{t.community.relations}</Button>
        </div>
      </div>

      <PointsCard />

      <section>
        <SectionTitle action={<Button size="sm" variant="ghost" onClick={() => load()} disabled={busy}><RefreshCw size={16} strokeWidth={1.75} className={busy ? 'animate-spin' : ''} />刷新</Button>}>我的发布</SectionTitle>
        {items === null ? (
          <div className="text-sm text-ink-400">{t.common.loading}</div>
        ) : items.length === 0 ? (
          <EmptyState title="还没有发布过故事" description="在故事工坊里点「发布到公共书房」，它就会出现在这里。" />
        ) : (
          <ul className="space-y-3">
            {items.map((n) => (
              <li key={n.id} className="flex items-center gap-4 rounded-2xl bg-paper-0 p-4 shadow-soft transition hover:shadow-lift dark:bg-paper-900">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-serif text-base font-semibold tracking-wide text-ink-900 dark:text-paper-100">{n.title}</span>
                    {n.visibility === 'unpublished' ? <Badge tone="amber" dot>未提交</Badge> : n.visibility === 'unlisted' ? <Badge dot>不公开列出</Badge> : <Badge tone="green" dot>公开</Badge>}
                    {n.isDerivative && <Badge tone="amber">二创</Badge>}
                  </div>
                  <div className="mt-1 text-xs text-ink-500">
                    {n.chapterCount} 章 · {n.charCount.toLocaleString()} 字 · {LICENSE_LABELS[n.license]} · 浏览 {n.viewCount} · 赞 {n.likeCount} · 二创 {n.forkCount}
                  </div>
                </div>
                <Button size="sm" variant="ghost" title="查看" onClick={() => nav(`/public/${n.id}`)}><ExternalLink size={16} strokeWidth={1.75} /></Button>
                <Button size="sm" variant="ghost" title="下架" className="hover:text-cinnabar-600" onClick={() => unpublish(n)}><Trash2 size={16} strokeWidth={1.75} /></Button>
              </li>
            ))}
          </ul>
        )}
        {cursor && <div className="mt-4 flex justify-center"><Button size="sm" variant="ghost" onClick={() => load(true)} disabled={busy}>加载更多</Button></div>}
      </section>

      <ProfileEditDialog
        open={editOpen}
        onClose={() => setEditOpen(false)}
        initial={{ displayName: account.displayName, handle: account.handle, bio: me?.bio ?? '' }}
      />
    </div>
  );
}
