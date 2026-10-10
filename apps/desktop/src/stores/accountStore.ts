import { create } from 'zustand';
import type { SyncAccount } from '@/db/repos/syncAccountRepo';
import { getAccount } from '@/sync/session';

interface AccountState {
  account: SyncAccount | null;
  loaded: boolean;
  refresh: () => Promise<void>;
}

/** Logged-in cloud account (null when logged out). Call `refresh()` after login/logout. */
export const useAccount = create<AccountState>((set) => ({
  account: null,
  loaded: false,
  refresh: async () => {
    const account = await getAccount().catch(() => null);
    set({ account, loaded: true });
  },
}));
