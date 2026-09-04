import { useState } from 'react';
import { UserMinus, UserPlus } from 'lucide-react';
import { Button, Spinner } from '@/components/ui';
import { toast } from '@/components/Toast';
import { friendlyError } from '@/community/errors';
import { getClient } from '@/sync/account';
import { useCommunity, useFollowState } from '@/stores/communityStore';
import { t } from '@/i18n';

interface Props {
  userId: string;
  following: boolean;
  followerCount?: number;
  onCount?: (n: number) => void;
  requireLogin: () => boolean;
  size?: 'sm' | 'md';
  /** 互相屏蔽时不显示关注入口。 */
  hidden?: boolean;
}

/** 关注按钮：先本地翻转，出错再翻回来。 */
export function FollowButton({ userId, following: serverValue, onCount, requireLogin, size = 'sm', hidden }: Props) {
  const following = useFollowState(userId, serverValue);
  const learn = useCommunity((s) => s.learn);
  const [busy, setBusy] = useState(false);
  if (hidden) return null;

  const toggle = async () => {
    if (!requireLogin()) return;
    const next = !following;
    learn(userId, { following: next });
    setBusy(true);
    try {
      const client = await getClient();
      if (!client) return;
      const res = next ? await client.follow(userId) : await client.unfollow(userId);
      learn(userId, { following: res.following });
      onCount?.(res.followerCount);
    } catch (e) {
      learn(userId, { following: !next });
      toast.error(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button size={size} variant={following ? 'secondary' : 'ai'} onClick={toggle} disabled={busy} aria-pressed={following}>
      {busy ? <Spinner className="h-3.5 w-3.5" /> : following ? <UserMinus size={16} strokeWidth={1.75} aria-hidden="true" /> : <UserPlus size={16} strokeWidth={1.75} aria-hidden="true" />}
      {following ? t.community.following : t.community.follow}
    </Button>
  );
}
