import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@/db/repos/settingsRepo';
import { useSettings } from '@/stores/settingsStore';

// TEST SIMULATED failures; no real provider or model calls.
const mocks = vi.hoisted(() => ({ server: vi.fn(), local: vi.fn() }));
vi.mock('@/llm/serverProvider', () => ({ serverProvider: mocks.server }));
vi.mock('@/db/repos/providersRepo', () => ({ listProviders: mocks.local }));
vi.mock('@/app/theme', () => ({ applyTheme: vi.fn() }));

describe('provider availability (TEST SIMULATED)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, aiServiceMode: 'server' }, providers: [], providerError: null });
  });
  it('preserves connection failures instead of reporting missing login; refresh clears the failure', async () => {
    mocks.server.mockRejectedValueOnce(new Error('TEST server connection refused'));
    await useSettings.getState().refreshProviders();
    expect(useSettings.getState()).toMatchObject({ providers: [], providerError: 'TEST server connection refused' });
    mocks.server.mockResolvedValueOnce({ config: { id: 'TEST-provider' } });
    await useSettings.getState().refreshProviders();
    expect(useSettings.getState()).toMatchObject({ providers: [{ id: 'TEST-provider' }], providerError: null });
  });
  it('preserves the distinct authentication failure and never falls back to local credentials', async () => {
    mocks.server.mockRejectedValueOnce(new Error('TEST session expired'));
    await useSettings.getState().refreshProviders();
    expect(useSettings.getState().providerError).toBe('TEST session expired');
    expect(mocks.local).not.toHaveBeenCalled();
  });
  it('ignores a stale failed check after a newer check has recovered', async () => {
    let failOld!: (error: Error) => void;
    mocks.server.mockImplementationOnce(() => new Promise((_, reject) => { failOld = reject; }));
    const old = useSettings.getState().refreshProviders();
    mocks.server.mockResolvedValueOnce({ config: { id: 'TEST-recovered-provider' } });
    await useSettings.getState().refreshProviders();
    failOld(new Error('TEST stale connection failure'));
    await old;
    expect(useSettings.getState()).toMatchObject({ providers: [{ id: 'TEST-recovered-provider' }], providerError: null });
  });

});
