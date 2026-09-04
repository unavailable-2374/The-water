import { describe, expect, it } from 'vitest';
import { planProviderCleanup, type PurposeMap } from '@/features/settings/providerCleanup';

const none: PurposeMap = { chat: null, writing: null, planning: null };
const other = [{ id: 'b', name: 'Kimi' }, { id: 'c', name: 'OpenAI' }];

describe('planProviderCleanup', () => {
  it('没人指向被删的供应商时不动 settings', () => {
    const plan = planProviderCleanup({
      deleted: { id: 'a', name: 'DeepSeek', isDefault: false },
      remaining: other,
      purposes: none,
    });
    expect(plan.purposes).toBeNull();
    expect(plan.clearedPurposes).toEqual([]);
    expect(plan.promoteDefaultTo).toBeNull();
    expect(plan.notice).toBe('已删除「DeepSeek」。');
  });

  it('指向被删 id 的用途覆盖被清空，其它保持不动', () => {
    const plan = planProviderCleanup({
      deleted: { id: 'a', name: 'DeepSeek', isDefault: false },
      remaining: other,
      purposes: { chat: 'a', writing: 'b', planning: 'a' },
    });
    expect(plan.purposes).toEqual({ chat: null, writing: 'b', planning: null });
    expect(plan.clearedPurposes).toEqual(['chat', 'planning']);
    expect(plan.notice).toContain('对话、规划场景的模型已重置为跟随默认');
  });

  it('删掉的是默认供应商时把剩下的第一个提上来', () => {
    const plan = planProviderCleanup({
      deleted: { id: 'a', name: 'DeepSeek', isDefault: true },
      remaining: other,
      purposes: none,
    });
    expect(plan.promoteDefaultTo).toBe('b');
    expect(plan.notice).toContain('默认供应商已改为「Kimi」');
  });

  it('删掉非默认的不动默认位', () => {
    expect(planProviderCleanup({
      deleted: { id: 'a', name: 'DeepSeek', isDefault: false },
      remaining: other,
      purposes: none,
    }).promoteDefaultTo).toBeNull();
  });

  it('删光了就没得提升，提示补一个', () => {
    const plan = planProviderCleanup({
      deleted: { id: 'a', name: 'DeepSeek', isDefault: true },
      remaining: [],
      purposes: { chat: 'a', writing: 'a', planning: 'a' },
    });
    expect(plan.promoteDefaultTo).toBeNull();
    expect(plan.purposes).toEqual(none);
    expect(plan.notice).toContain('现在没有可用的模型了');
  });

  it('清理后的用途覆盖不会再指向已删的 id', () => {
    const plan = planProviderCleanup({
      deleted: { id: 'a', name: 'A', isDefault: true },
      remaining: other,
      purposes: { chat: 'a', writing: 'a', planning: 'c' },
    });
    expect(Object.values(plan.purposes!)).not.toContain('a');
  });
});
