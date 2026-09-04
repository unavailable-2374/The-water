/**
 * 首启引导的三步状态机：选供应商 → 填 Key → 测试连接，成功后进入「下一步做什么」。
 * 这里只有纯逻辑，UI 在 OnboardingWizard.tsx。
 */
import type { PresetId } from '@/llm/factory';

/** 引导是否走完，存在 settings 表里。 */
export const ONBOARDING_DONE_KEY = 'onboardingCompleted';

export type OnboardingStep = 'provider' | 'key' | 'test' | 'done';

/** 进度条上显示的三步（done 是收尾页，不计入步数）。 */
export const WIZARD_STEPS: readonly OnboardingStep[] = ['provider', 'key', 'test'];

export type TestState = 'idle' | 'running' | 'ok' | 'fail';

export interface OnboardingState {
  step: OnboardingStep;
  presetId: PresetId | null;
  apiKey: string;
  test: TestState;
  testError: string | null;
  /** 测试通过后写库拿到的供应商 id。 */
  providerId: string | null;
}

export const initialOnboardingState: OnboardingState = {
  step: 'provider',
  presetId: null,
  apiKey: '',
  test: 'idle',
  testError: null,
  providerId: null,
};

export type OnboardingEvent =
  | { type: 'selectPreset'; presetId: PresetId }
  | { type: 'setKey'; apiKey: string }
  | { type: 'next' }
  | { type: 'back' }
  | { type: 'testStart' }
  | { type: 'testOk'; providerId: string }
  | { type: 'testFail'; message: string };

/** 当前步骤在进度条里的序号（0 起）；done 返回三步之后。 */
export function stepIndex(step: OnboardingStep): number {
  const i = WIZARD_STEPS.indexOf(step);
  return i < 0 ? WIZARD_STEPS.length : i;
}

/** 这一步能不能往下走。 */
export function canAdvance(s: OnboardingState): boolean {
  switch (s.step) {
    case 'provider':
      return s.presetId !== null;
    case 'key':
      return s.apiKey.trim().length > 0;
    case 'test':
      return s.test === 'ok';
    case 'done':
      return false;
  }
}

/** 这一步能不能往回退。 */
export function canGoBack(s: OnboardingState): boolean {
  return s.step === 'key' || (s.step === 'test' && s.test !== 'running');
}

export function onboardingReducer(s: OnboardingState, e: OnboardingEvent): OnboardingState {
  switch (e.type) {
    case 'selectPreset':
      // 换供应商要作废上一次的测试结果。
      return s.presetId === e.presetId ? s : { ...s, presetId: e.presetId, test: 'idle', testError: null, providerId: null };
    case 'setKey':
      return s.apiKey === e.apiKey ? s : { ...s, apiKey: e.apiKey, test: 'idle', testError: null };
    case 'next': {
      if (!canAdvance(s)) return s;
      if (s.step === 'provider') return { ...s, step: 'key' };
      if (s.step === 'key') return { ...s, step: 'test', test: 'idle', testError: null };
      return { ...s, step: 'done' };
    }
    case 'back': {
      if (!canGoBack(s)) return s;
      if (s.step === 'key') return { ...s, step: 'provider' };
      return { ...s, step: 'key', test: 'idle', testError: null };
    }
    case 'testStart':
      return s.step === 'test' ? { ...s, test: 'running', testError: null } : s;
    case 'testOk':
      return s.step === 'test' ? { ...s, test: 'ok', testError: null, providerId: e.providerId } : s;
    case 'testFail':
      return s.step === 'test' ? { ...s, test: 'fail', testError: e.message } : s;
  }
}
