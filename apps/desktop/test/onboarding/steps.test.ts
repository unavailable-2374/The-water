import { describe, expect, it } from 'vitest';
import {
  WIZARD_STEPS, canAdvance, canGoBack, initialOnboardingState, onboardingReducer, stepIndex,
  type OnboardingEvent, type OnboardingState,
} from '@/features/onboarding/steps';
import { PROVIDER_PRESETS } from '@/llm/factory';

const run = (events: OnboardingEvent[], from: OnboardingState = initialOnboardingState): OnboardingState =>
  events.reduce(onboardingReducer, from);

const toTest = (): OnboardingState => run([
  { type: 'selectPreset', presetId: 'deepseek' },
  { type: 'next' },
  { type: 'setKey', apiKey: 'sk-x' },
  { type: 'next' },
]);

describe('推进条件', () => {
  it('没选供应商不能走第二步', () => {
    expect(canAdvance(initialOnboardingState)).toBe(false);
    expect(onboardingReducer(initialOnboardingState, { type: 'next' })).toBe(initialOnboardingState);
  });

  it('没填 Key 不能走第三步', () => {
    const s = run([{ type: 'selectPreset', presetId: 'deepseek' }, { type: 'next' }]);
    expect(s.step).toBe('key');
    expect(canAdvance(s)).toBe(false);
    expect(canAdvance({ ...s, apiKey: '   ' })).toBe(false);
    expect(canAdvance({ ...s, apiKey: 'sk-x' })).toBe(true);
  });

  it('测试没通过不能收尾', () => {
    const s = toTest();
    expect(s.step).toBe('test');
    expect(canAdvance(s)).toBe(false);
    expect(canAdvance(onboardingReducer(s, { type: 'testFail', message: '401' }))).toBe(false);
    expect(canAdvance(onboardingReducer(s, { type: 'testOk', providerId: 'p1' }))).toBe(true);
  });

  it('三步走完就能到 done', () => {
    const s = run([{ type: 'testOk', providerId: 'p1' }, { type: 'next' }], toTest());
    expect(s.step).toBe('done');
    expect(s.providerId).toBe('p1');
    expect(canAdvance(s)).toBe(false);
  });

  it('新用户从零到成功只需三次 next', () => {
    const events: OnboardingEvent[] = [
      { type: 'selectPreset', presetId: 'deepseek' },
      { type: 'next' },
      { type: 'setKey', apiKey: 'sk-x' },
      { type: 'next' },
      { type: 'testOk', providerId: 'p1' },
      { type: 'next' },
    ];
    expect(events.filter((e) => e.type === 'next')).toHaveLength(3);
    expect(run(events).step).toBe('done');
  });
});

describe('回退', () => {
  it('第一步退不了，测试中退不了', () => {
    expect(canGoBack(initialOnboardingState)).toBe(false);
    expect(canGoBack(onboardingReducer(toTest(), { type: 'testStart' }))).toBe(false);
  });

  it('第三步退回第二步并作废测试结果', () => {
    const s = onboardingReducer(run([{ type: 'testFail', message: '401' }], toTest()), { type: 'back' });
    expect(s.step).toBe('key');
    expect(s.test).toBe('idle');
    expect(s.testError).toBeNull();
    expect(s.apiKey).toBe('sk-x');
  });

  it('第二步退回第一步，已选的供应商还在', () => {
    const s = onboardingReducer(run([{ type: 'selectPreset', presetId: 'kimi' }, { type: 'next' }]), { type: 'back' });
    expect(s.step).toBe('provider');
    expect(s.presetId).toBe('kimi');
  });
});

describe('改动会作废旧的测试结果', () => {
  it('换 Key 之后要重测', () => {
    const ok = run([{ type: 'testOk', providerId: 'p1' }], toTest());
    expect(onboardingReducer(ok, { type: 'setKey', apiKey: 'sk-y' }).test).toBe('idle');
  });

  it('填一样的 Key 不改状态（避免 effect 反复触发）', () => {
    const ok = run([{ type: 'testOk', providerId: 'p1' }], toTest());
    expect(onboardingReducer(ok, { type: 'setKey', apiKey: 'sk-x' })).toBe(ok);
  });

  it('换供应商会清掉测试结果与已建的 providerId', () => {
    const ok = run([{ type: 'testOk', providerId: 'p1' }], toTest());
    const s = onboardingReducer(ok, { type: 'selectPreset', presetId: 'openai' });
    expect(s.test).toBe('idle');
    expect(s.providerId).toBeNull();
  });

  it('选同一个供应商不改状态', () => {
    const s = run([{ type: 'selectPreset', presetId: 'deepseek' }]);
    expect(onboardingReducer(s, { type: 'selectPreset', presetId: 'deepseek' })).toBe(s);
  });
});

describe('测试事件只在第三步生效', () => {
  it('不在 test 步时 testOk / testFail 被忽略', () => {
    const s = run([{ type: 'selectPreset', presetId: 'deepseek' }]);
    expect(onboardingReducer(s, { type: 'testOk', providerId: 'p1' })).toBe(s);
    expect(onboardingReducer(s, { type: 'testFail', message: 'x' })).toBe(s);
    expect(onboardingReducer(s, { type: 'testStart' })).toBe(s);
  });

  it('失败会带上原因', () => {
    const s = onboardingReducer(toTest(), { type: 'testFail', message: '401 Unauthorized' });
    expect(s.test).toBe('fail');
    expect(s.testError).toBe('401 Unauthorized');
  });
});

describe('进度条', () => {
  it('三步各自的序号', () => {
    expect(WIZARD_STEPS).toEqual(['provider', 'key', 'test']);
    expect(stepIndex('provider')).toBe(0);
    expect(stepIndex('key')).toBe(1);
    expect(stepIndex('test')).toBe(2);
    expect(stepIndex('done')).toBe(3);
  });
});

describe('每个预设都得能引导用户去拿 Key', () => {
  it('都有 apiKeyUrl 且是 https', () => {
    for (const p of PROVIDER_PRESETS) {
      expect(p.apiKeyUrl, p.name).toBeTruthy();
      expect(p.apiKeyUrl!.startsWith('https://'), p.name).toBe(true);
    }
  });
});
