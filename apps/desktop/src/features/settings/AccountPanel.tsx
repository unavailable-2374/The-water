import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { ExternalLink, LogOut, Pencil, RefreshCw, Trash2, UserRound } from 'lucide-react';
import { LICENSE_LABELS, validateHandle, type NovelSummary } from '@the-water/shared';
import { fmt, t } from '@/i18n';
import { Badge, Button, Card, cn, confirm, EmptyState, Field, IconButton, Input, SectionTitle, Spinner } from '@/components/ui';
import { usePagedList } from '@/components/data/useAsyncData';
import { Avatar } from '@/components/Avatar';
import { authorPath } from '@/components/UserChip';
import { LevelBadge } from '@/features/community/LevelBadge';
import { ProfileEditDialog } from './ProfileEditDialog';
import { AccountSecuritySection, ForgotPasswordDialog, MIN_PASSWORD } from './AccountSecurity';
import { PointsCard } from './PointsCard';
import { useCommunity } from '@/stores/communityStore';
import { toast } from '@/components/Toast';
import { friendlyError } from '@/community/errors';
import { listNovels, updateNovel } from '@/db/repos/novelsRepo';
import { useAccount } from '@/stores/accountStore';
import { DEFAULT_SERVER_URL, getClient, getServerUrl, login, logout, register, setServerUrl } from '@/sync/account';
import { checkServer, describeError } from '@/sync/api';
import { validateBaseUrl } from './providerAdvanced';

/** 登录 / 注册表单。设置页与公共区的登录弹窗共用。 */
export function LoginForm({ onDone }: { onDone?: () => void }) {
  const refresh = useAccount((s) => s.refresh);
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [serverUrl, setServer] = useState(DEFAULT_SERVER_URL);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [handle, setHandle] = useState('');
  const [forgotOpen, setForgotOpen] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { void getServerUrl().then(setServer); }, []);

  /** 地址不合法就不落库，免得把用户锁在一个打不通的地址上。 */
  const commitServerUrl = async () => {
    const err = validateBaseUrl(serverUrl);
    setServerError(err);
    if (err) return;
    await setServerUrl(serverUrl.replace(/\/+$/, ''));
  };

  const testServer = async () => {
    const err = validateBaseUrl(serverUrl);
    setServerError(err);
    if (err) return;
    setProbing(true);
    try {
      const health = await checkServer(serverUrl);
      await setServerUrl(serverUrl.replace(/\/+$/, ''));
      toast.success(fmt(t.settings.serverOk, { service: health.service, version: health.version }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setServerError(msg);
      toast.error(msg);
    } finally {
      setProbing(false);
    }
  };

  const submit = async () => {
    if (!serverUrl.trim() || !email.trim() || !password) { toast.error(t.settings.loginFieldsRequired); return; }
    if (mode === 'register' && password.length < MIN_PASSWORD) { toast.error(fmt(t.settings.passwordTooShort, { n: MIN_PASSWORD })); return; }
    if (mode === 'register' && !displayName.trim()) { toast.error(t.settings.displayNameRequired); return; }
    const wantedHandle = handle.trim().toLowerCase();
    if (mode === 'register' && wantedHandle) {
      const invalid = validateHandle(wantedHandle);
      if (invalid) { toast.error(invalid); return; }
    }
    setBusy(true);
    try {
      const account = mode === 'login' ? await login(serverUrl, email, password, remember) : await register(serverUrl, email, password, displayName, wantedHandle, remember);
      await refresh();
      if (account.rememberFailed) toast.info(t.settings.rememberLoginFailed);
      else toast.success(fmt(t.settings.loggedInAs, { name: account.displayName }));
      onDone?.();
    } catch (e) {
      toast.error(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex gap-1 rounded-full bg-paper-200/70 p-1 text-sm dark:bg-paper-950/60" role="tablist" aria-label={t.settings.authModeTabs}>
        {(['login', 'register'] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            onClick={() => setMode(m)}
            className={cn('flex-1 rounded-full px-3 py-1.5 transition', mode === m ? 'bg-paper-0 font-medium text-ink-900 shadow-soft dark:bg-paper-800 dark:text-paper-50' : 'text-ink-500 hover:text-ink-800 dark:hover:text-paper-100')}
          >
            {m === 'login' ? t.publicArea.login : t.publicArea.register}
          </button>
        ))}
      </div>
      <Field label={t.publicArea.serverUrl} hint={serverError ?? undefined}>
        <div className="flex gap-2">
          <Input
            className="flex-1"
            value={serverUrl}
            onChange={(e) => { setServer(e.target.value); setServerError(null); }}
            onBlur={() => void commitServerUrl()}
            placeholder={DEFAULT_SERVER_URL}
          />
          <Button variant="ghost" disabled={probing} onClick={() => void testServer()}>
            {probing ? <Spinner /> : null}{t.settings.testConnection}
          </Button>
        </div>
      </Field>
      <Field label={t.settings.email}><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" /></Field>
      <Field label={t.settings.password} hint={mode === 'register' ? fmt(t.settings.passwordHint, { n: MIN_PASSWORD }) : undefined}>
        <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }} />
      </Field>
      {mode === 'register' && (
        <>
          <Field label={t.community.displayName}><Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={32} /></Field>
          <Field label={t.community.handle} hint={t.settings.handleRandomHint}>
            <div className="relative">
              <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-sm text-ink-400" aria-hidden="true">@</span>
              <Input className="pl-7" value={handle} maxLength={20} autoCapitalize="none" spellCheck={false} onChange={(e) => setHandle(e.target.value)} />
            </div>
          </Field>
        </>
      )}
      <div className="space-y-1">
        <label className="flex items-center gap-2 text-sm text-ink-700 dark:text-paper-100">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} disabled={busy} aria-describedby="remember-login-hint" className="h-4 w-4 accent-accent-600" />
          {t.settings.rememberLogin}
        </label>
        <p id="remember-login-hint" className="text-xs text-ink-400">{t.settings.rememberLoginHint}</p>
      </div>
      <div className="flex items-center justify-between pt-1">
        {mode === 'login' ? (
          <button type="button" className="text-xs text-ink-400 underline-offset-2 hover:text-ink-700 hover:underline dark:hover:text-paper-100" onClick={() => setForgotOpen(true)}>
            {t.settings.forgotPasswordLink}
          </button>
        ) : (
          <span aria-hidden="true" />
        )}
        <Button variant="primary" onClick={submit} disabled={busy}>
          {busy && <Spinner className="h-3 w-3" />}
          {mode === 'login' ? t.publicArea.login : t.publicArea.register}
        </Button>
      </div>
      <ForgotPasswordDialog open={forgotOpen} onClose={() => setForgotOpen(false)} defaultEmail={email} />
    </div>
  );
}

export function AccountPanel() {
  const { account, loaded, refresh } = useAccount();
  useEffect(() => { if (!loaded) void refresh(); }, [loaded, refresh]);

  if (!loaded) return <div className="text-sm text-ink-400" role="status">{t.common.loading}</div>;
  if (!account) {
    return (
      <div className="max-w-md space-y-6">
        <header>
          <h1 className="font-sans text-2xl font-semibold tracking-tight">{t.settings.account}</h1>
          <p className="mt-1 text-sm leading-relaxed text-ink-500">{t.settings.accountLoginDesc}</p>
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
  const [editOpen, setEditOpen] = useState(false);
  useEffect(() => { if (!me) void loadMe(); }, [me, loadMe]);

  // 我的发布：游标分页交给 usePagedList（卸载即 abort、乱序丢弃、并发去重）。
  const novels = usePagedList<NovelSummary>(
    async ({ cursor }) => {
      const client = await getClient();
      if (!client) return { items: [], nextCursor: null };
      const page = await client.myNovels({ cursor: cursor ?? undefined, limit: 50 });
      return { items: page.items, nextCursor: page.nextCursor };
    },
    { key: `me:novels:${account?.userId ?? ''}` },
  );

  const doLogout = async () => {
    await logout();
    await refresh();
    toast.info(t.settings.loggedOut);
  };

  const unpublish = async (n: NovelSummary) => {
    if (!(await confirm({
      title: fmt(t.settings.unpublishTitle, { name: n.title }),
      description: t.settings.unpublishDesc,
      confirmText: t.settings.unpublish,
      tone: 'danger',
    }))) return;
    try {
      const client = await getClient();
      if (!client) return;
      await client.deleteNovel(n.id);
      // 本地小说解绑，下次发布会在服务端重新建一条。
      for (const local of await listNovels()) {
        if (local.remote?.novelId === n.id && local.remote.serverUrl === client.baseUrl) await updateNovel(local.id, { remote: null });
      }
      novels.setItems((prev) => prev.filter((x) => x.id !== n.id));
      toast.success(t.settings.unpublished);
    } catch (e) {
      toast.error(friendlyError(e));
    }
  };

  if (!account) return null;
  return (
    <div className="max-w-2xl space-y-8">
      <div className="relative overflow-hidden rounded-2xl bg-paper-0 p-6 shadow-soft dark:bg-paper-900">
        <div className="pointer-events-none absolute inset-0 paper-texture opacity-70" aria-hidden="true" />
        <div className="relative flex items-center gap-5">
          {account.displayName.trim() ? (
            <Avatar seed={account.handle || account.userId} name={account.displayName} size="lg" />
          ) : (
            <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-tea-50 text-tea-700 dark:bg-tea-800/40 dark:text-tea-200" aria-hidden="true">
              <UserRound size={22} strokeWidth={1.75} />
            </div>
          )}
          <div className="min-w-0 flex-1">
            <div className="text-[10px] tracking-[0.2em] text-ink-400">{t.settings.accountCardTag}</div>
            <div className="mt-0.5 flex items-center gap-2">
              <span className="truncate font-serif text-xl font-semibold tracking-wide text-ink-900 dark:text-paper-100">{account.displayName}</span>
              {me && <LevelBadge level={me.level} />}
            </div>
            <div className="mt-0.5 truncate text-xs text-ink-400">{account.handle ? `@${account.handle} · ` : ''}{account.serverUrl}</div>
            {me?.bio && <div className="mt-1 line-clamp-2 text-xs leading-relaxed text-ink-500">{me.bio}</div>}
          </div>
          <Button size="sm" variant="ghost" onClick={doLogout}><LogOut size={16} strokeWidth={1.75} aria-hidden="true" />{t.publicArea.logout}</Button>
        </div>
        <div className="relative mt-4 flex flex-wrap gap-2">
          <Button size="sm" onClick={() => setEditOpen(true)}><Pencil size={16} strokeWidth={1.75} aria-hidden="true" />{t.community.editProfile}</Button>
          {account.handle && (
            <Button size="sm" variant="ghost" onClick={() => nav(authorPath({ id: account.userId, handle: account.handle }))}>
              <ExternalLink size={16} strokeWidth={1.75} aria-hidden="true" />{t.community.myPage}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => nav('/settings/community')}>{t.community.relations}</Button>
        </div>
      </div>

      <PointsCard />

      <AccountSecuritySection />

      <section>
        <SectionTitle action={(
          <Button size="sm" variant="ghost" onClick={novels.reload} disabled={novels.loading}>
            <RefreshCw size={16} strokeWidth={1.75} className={novels.loading ? 'animate-spin' : ''} aria-hidden="true" />{t.settings.refresh}
          </Button>
        )}>{t.settings.myPublished}</SectionTitle>
        {novels.error ? (
          <Card className="flex items-center justify-between gap-3 text-sm text-ink-500" role="alert">
            <span>{friendlyError(novels.error)}</span>
            <Button size="sm" onClick={novels.reload}>{t.common.retry}</Button>
          </Card>
        ) : novels.initializing ? (
          <div className="text-sm text-ink-400" role="status"><Spinner className="mr-2" />{t.common.loading}</div>
        ) : novels.items.length === 0 ? (
          <EmptyState title={t.settings.myPublishedEmpty} description={t.settings.myPublishedEmptyDesc} />
        ) : (
          <ul className="space-y-3" aria-label={t.settings.myPublishedList}>
            {novels.items.map((n) => (
              <li key={n.id} className="flex items-center gap-4 rounded-2xl bg-paper-0 p-4 shadow-soft transition hover:shadow-lift dark:bg-paper-900">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-serif text-base font-semibold tracking-wide text-ink-900 dark:text-paper-100">{n.title}</span>
                    {n.visibility === 'unpublished'
                      ? <Badge tone="amber" dot>{t.settings.visUnpublished}</Badge>
                      : n.visibility === 'unlisted' ? <Badge dot>{t.settings.visUnlisted}</Badge> : <Badge tone="green" dot>{t.settings.visPublic}</Badge>}
                    {n.isDerivative && <Badge tone="amber">{t.community.derivative}</Badge>}
                  </div>
                  <div className="mt-1 text-xs text-ink-500">
                    {fmt(t.settings.novelMeta, {
                      chapters: n.chapterCount, chars: n.charCount.toLocaleString(), license: LICENSE_LABELS[n.license],
                      views: n.viewCount, likes: n.likeCount, forks: n.forkCount,
                    })}
                  </div>
                </div>
                <IconButton label={t.settings.view} onClick={() => nav(`/public/${n.id}`)}><ExternalLink size={16} strokeWidth={1.75} aria-hidden="true" /></IconButton>
                <IconButton label={fmt(t.settings.unpublishTitle, { name: n.title })} className="hover:text-cinnabar-600" onClick={() => unpublish(n)}>
                  <Trash2 size={16} strokeWidth={1.75} aria-hidden="true" />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
        {novels.hasMore && (
          <div className="mt-4 flex justify-center">
            <Button size="sm" variant="ghost" onClick={novels.loadMore} disabled={novels.loadingMore}>
              {novels.loadingMore && <Spinner className="mr-2 h-3 w-3" />}{t.common.loadMore}
            </Button>
          </div>
        )}
      </section>

      <ProfileEditDialog
        open={editOpen}
        onClose={() => setEditOpen(false)}
        initial={{ displayName: account.displayName, handle: account.handle, bio: me?.bio ?? '' }}
      />
    </div>
  );
}
