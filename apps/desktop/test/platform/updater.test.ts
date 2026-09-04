import { describe, expect, it } from 'vitest';
import { checkForUpdate, disposePending, installPendingUpdate, progressPercent } from '@/platform/updater';

describe('自动更新', () => {
  it('进度百分比：拿不到总长度时返回 null', () => {
    expect(progressPercent({ downloaded: 50, total: 200 })).toBe(25);
    expect(progressPercent({ downloaded: 300, total: 200 })).toBe(100);
    expect(progressPercent({ downloaded: 5, total: null })).toBeNull();
    expect(progressPercent({ downloaded: 5, total: 0 })).toBeNull();
  });

  it('不在 Tauri 里跑时不抛异常，只报「用不了」并带上原因', async () => {
    const got = await checkForUpdate();
    expect(got.state).toBe('unavailable');
    if (got.state === 'unavailable') expect(got.reason.length).toBeGreaterThan(0);
  });

  it('没检查过就安装会给出明确提示', async () => {
    await disposePending();
    await expect(installPendingUpdate()).rejects.toThrow('没有待安装的更新');
  });
});
