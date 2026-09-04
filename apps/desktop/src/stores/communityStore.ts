/**
 * 社区关系的轻量覆盖层：服务端每个响应都带 viewer 关系，这里只记住"我刚刚点过的"，
 * 让同一位作者在书房、动态、榜单里的关注按钮立刻一致。账号或服务器一换就清空。
 */
import { create } from 'zustand';
import type { UserProfile } from '@the-water/shared';
import { getClient } from '@/sync/account';
import { useAccount } from './accountStore';

interface CommunityState {
  me: UserProfile | null;
  following: Record<string, boolean>;
  blocked: Record<string, boolean>;
  /** 未读通知数，侧栏小红点用（§3.1）。未登录恒为 0。 */
  unread: number;
  loadMe: () => Promise<void>;
  learn: (userId: string, v: { following?: boolean; blocked?: boolean }) => void;
  /** 拉一次未读数；没登录或服务器不通就当作 0，不打扰用户。 */
  refreshUnread: () => Promise<void>;
  /** 通知页标已读后直接回填，省一次往返。 */
  setUnread: (n: number) => void;
  reset: () => void;
}

/** 未读数轮询间隔。够快到「点开就看见」，又不至于把服务器当水表用。 */
export const UNREAD_POLL_MS = 60_000;

export const useCommunity = create<CommunityState>((set) => ({
  me: null,
  following: {},
  blocked: {},
  unread: 0,
  loadMe: async () => {
    const account = useAccount.getState().account;
    const client = await getClient();
    if (!account || !client) {
      set({ me: null });
      return;
    }
    const me = await client.getUser(account.userId).then((r) => r.user).catch(() => null);
    set({ me });
  },
  refreshUnread: async () => {
    const account = useAccount.getState().account;
    const client = await getClient();
    if (!account || !client) {
      set({ unread: 0 });
      return;
    }
    try {
      const { unreadCount } = await client.unreadNotificationCount();
      set({ unread: unreadCount });
    } catch {
      // 离线或服务端还没接上通知端点：保持现状，不弹错误。
    }
  },
  setUnread: (n) => set({ unread: Math.max(0, n) }),
  learn: (userId, v) =>
    set((s) => ({
      following: v.following === undefined ? s.following : { ...s.following, [userId]: v.following },
      blocked: v.blocked === undefined ? s.blocked : { ...s.blocked, [userId]: v.blocked },
    })),
  reset: () => set({ me: null, following: {}, blocked: {}, unread: 0 }),
}));

/** 关注状态：优先用本地刚点过的结果，否则用服务端给的值。 */
export function useFollowState(userId: string, serverValue: boolean): boolean {
  return useCommunity((s) => s.following[userId] ?? serverValue);
}

export function useBlockState(userId: string, serverValue: boolean): boolean {
  return useCommunity((s) => s.blocked[userId] ?? serverValue);
}

/** 侧栏小红点读这个。 */
export function useUnreadNotifications(): number {
  return useCommunity((s) => s.unread);
}

let lastKey = '';
let pollTimer: ReturnType<typeof setInterval> | null = null;

function stopPolling(): void {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/**
 * 账号或服务器变化时重置覆盖层并重新拉自己的资料。main.tsx 启动时调用一次。
 * 顺带起未读通知的轮询：登录期间每分钟一次，退出登录就停掉。
 */
export function watchAccountForCommunity(): () => void {
  const apply = (account: { serverUrl: string; userId: string } | null) => {
    const key = account ? `${account.serverUrl}|${account.userId}` : '';
    if (key === lastKey) return;
    lastKey = key;
    useCommunity.getState().reset();
    stopPolling();
    if (!account) return;
    void useCommunity.getState().loadMe();
    void useCommunity.getState().refreshUnread();
    pollTimer = setInterval(() => void useCommunity.getState().refreshUnread(), UNREAD_POLL_MS);
  };
  apply(useAccount.getState().account);
  const unsubscribe = useAccount.subscribe((s) => apply(s.account));
  return () => {
    stopPolling();
    unsubscribe();
  };
}
