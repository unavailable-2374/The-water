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
  loadMe: () => Promise<void>;
  learn: (userId: string, v: { following?: boolean; blocked?: boolean }) => void;
  reset: () => void;
}

export const useCommunity = create<CommunityState>((set) => ({
  me: null,
  following: {},
  blocked: {},
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
  learn: (userId, v) =>
    set((s) => ({
      following: v.following === undefined ? s.following : { ...s.following, [userId]: v.following },
      blocked: v.blocked === undefined ? s.blocked : { ...s.blocked, [userId]: v.blocked },
    })),
  reset: () => set({ me: null, following: {}, blocked: {} }),
}));

/** 关注状态：优先用本地刚点过的结果，否则用服务端给的值。 */
export function useFollowState(userId: string, serverValue: boolean): boolean {
  return useCommunity((s) => s.following[userId] ?? serverValue);
}

export function useBlockState(userId: string, serverValue: boolean): boolean {
  return useCommunity((s) => s.blocked[userId] ?? serverValue);
}

let lastKey = '';
/** 账号或服务器变化时重置覆盖层并重新拉自己的资料。main.tsx 启动时调用一次。 */
export function watchAccountForCommunity(): () => void {
  const apply = (account: { serverUrl: string; userId: string } | null) => {
    const key = account ? `${account.serverUrl}|${account.userId}` : '';
    if (key === lastKey) return;
    lastKey = key;
    useCommunity.getState().reset();
    if (account) void useCommunity.getState().loadMe();
  };
  apply(useAccount.getState().account);
  return useAccount.subscribe((s) => apply(s.account));
}
