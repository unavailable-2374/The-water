import { useSearchParams, useNavigate } from 'react-router';
import type { FeedQuery } from '@the-water/shared';
import { t } from '@/i18n';
import { Button, cn } from '@/components/ui';
import { PublicTabs } from '@/features/publicArea/PublicTabs';
import { useAccount } from '@/stores/accountStore';
import { FeedList } from './FeedList';

type Scope = FeedQuery['scope'];

export function FeedPage() {
  const nav = useNavigate();
  const account = useAccount((s) => s.account);
  const [params, setParams] = useSearchParams();
  // 未登录时只有「全部」有意义。
  const scope: Scope = account ? ((params.get('scope') as Scope | null) ?? 'following') : 'all';

  return (
    <div className="h-full overflow-y-auto bg-paper-50 dark:bg-paper-950">
      <div className="mx-auto max-w-3xl px-10 py-10">
        <header className="mb-6 flex items-end justify-between gap-6">
          <div>
            <h1 className="font-serif text-3xl font-semibold tracking-wide">{t.community.tabs.feed}</h1>
            <p className="mt-1 text-sm text-ink-500">{t.community.feedSubtitle}</p>
          </div>
          <PublicTabs />
        </header>

        {account && (
          <div role="tablist" aria-label={t.community.feedScopeLabel} className="mb-6 inline-flex gap-1 rounded-full bg-paper-200/70 p-1 text-sm dark:bg-paper-900/70">
            {(['following', 'all'] as const).map((s) => (
              <button
                key={s}
                role="tab"
                aria-selected={scope === s}
                onClick={() => setParams(s === 'following' ? {} : { scope: s }, { replace: true })}
                className={cn(
                  'rounded-full px-4 py-1.5 transition',
                  scope === s ? 'bg-paper-0 font-medium text-ink-900 shadow-soft dark:bg-paper-800 dark:text-paper-50' : 'text-ink-500 hover:text-ink-800 dark:hover:text-paper-100',
                )}
              >
                {s === 'following' ? t.community.feedScopeFollowing : t.community.feedScopeAll}
              </button>
            ))}
          </div>
        )}

        <FeedList
          query={{ scope }}
          emptyTitle={scope === 'following' ? t.community.feedEmptyFollowing : t.community.feedEmptyAll}
          emptyAction={<Button variant="primary" onClick={() => nav('/public')}>{t.community.goBrowse}</Button>}
        />
      </div>
    </div>
  );
}
