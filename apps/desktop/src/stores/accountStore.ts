import { create } from 'zustand';
import { getSyncAccount, type SyncAccount } from '@/db/repos/syncAccountRepo';

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
    const account = await getSyncAccount().catch(() => null);
    set({ account, loaded: true });
  },
}));
