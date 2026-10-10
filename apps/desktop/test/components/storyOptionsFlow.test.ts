// @vitest-environment happy-dom
/** TEST / SIMULATED UI fixtures; not model or production results. */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Novel } from '@/db/repos/novelsRepo';
import { defaultRequirements } from '@/novel/types';
import { StoryOptionsButton, StoryOptionsPanel } from '@/features/studio/StoryOptionsPanel';
const fixture = vi.hoisted(() => ({ data: {} as any, generate: vi.fn(async () => 'TEST batch'), select: vi.fn(async () => 'TEST selection'), combine: vi.fn(async () => 'TEST combination') }));
vi.mock('@/components/data/useAsyncData', () => ({ useAsyncData: () => ({ data: fixture.data, reload: vi.fn() }) }));
vi.mock('@/novel/storyOptions', () => ({ generateStoryOptions: fixture.generate, combineStoryOptions: fixture.combine, selectStoryOption: fixture.select, storyOptionSource: vi.fn(), retainStoryOption: vi.fn(), resumeStoryOptions: vi.fn(), generateStoryOptionPlan: vi.fn() }));
let root: Root, container: HTMLDivElement;
const scope = { kind: 'work' as const, id: 'TEST work' };
const novel = { id: scope.id, requirements: { ...defaultRequirements(), docType: 'short-story' } } as Novel;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  fixture.generate.mockClear(); fixture.select.mockClear(); fixture.combine.mockClear();
  fixture.data = { history: [], novel, proposals: [], decisions: [], source: { label: 'TEST work', hash: 'TEST hash', boundary: null } };
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
it('TEST reimagine opens whole-work outline exploration without a disabled trigger', async () => {
  await act(async () => root.render(createElement(StoryOptionsButton, { novel, scope, label: 'TEST 重新构思' })));
  const button = container.querySelector('button')!;
  expect(button.disabled).toBe(false);
  await act(async () => button.click());
  expect(document.body.textContent).toContain('生成四个完整大纲');
  expect(document.body.textContent).toContain('先比较从开端到结局的完整大纲');
});
it('TEST whole-work generation defaults to restructure and does not expose continuation as the first step', async () => {
  await act(async () => root.render(createElement(StoryOptionsPanel, { owner: { novelId: scope.id }, scope })));
  const button = [...container.querySelectorAll('button')].find(b => b.textContent === '生成四个完整大纲')!;
  await act(async () => button.click());
  expect(fixture.generate).toHaveBeenCalledWith(expect.objectContaining({ scope, mode: 'restructure' }));
  expect(container.textContent).not.toContain('续写边界');
  expect([...container.querySelectorAll('option')].map(o => o.value)).not.toContain('continue');
});
it('TEST complete outlines are visible before selection; historical node-only cards are explicitly identified', async () => {
  fixture.data.history = [{ stale: false, selections: [], batch: { id: 'TEST batch', mode: 'continue', amplitude: 'moderate', createdAt: 1, keptIds: [], state: 'ready', comparison: null }, cards: [
    { id: 'TEST complete', title: 'TEST outline', mainline: 'TEST mainline', outline: ['TEST opening', 'TEST development', 'TEST crisis', 'TEST ending'], turns: [] },
    { id: 'TEST legacy', title: 'TEST legacy', mainline: 'TEST old summary', turns: [] },
  ] }];
  await act(async () => root.render(createElement(StoryOptionsPanel, { owner: { novelId: scope.id }, scope })));
  expect(container.textContent).toContain('TEST opening');
  expect(container.textContent).toContain('TEST ending');
  expect(container.textContent).toContain('旧版候选仅有方向摘要');
  expect(container.textContent).toContain('选择这个大纲');
});

it('TEST authors select multiple cards for combination without selecting or adopting a direction', async () => {
  fixture.data.history = [{ stale: false, selections: [], batch: { id: 'TEST batch', inputSnapshot: { sourceVersion: 2, authorMaterials: 'TEST explicit requirements' }, mode: 'restructure', amplitude: 'moderate', createdAt: 1, keptIds: [], state: 'ready', comparison: null }, cards: [
    { id: 'TEST first', title: 'TEST first outline', mainline: 'TEST first mainline', outline: ['TEST opening', 'TEST development', 'TEST crisis', 'TEST ending'], turns: [] },
    { id: 'TEST second', title: 'TEST second outline', mainline: 'TEST second mainline', outline: ['TEST alternate opening', 'TEST alternate development', 'TEST alternate crisis', 'TEST alternate ending'], turns: [] },
  ] }];
  await act(async () => root.render(createElement(StoryOptionsPanel, { owner: { novelId: scope.id }, scope })));
  const button = [...container.querySelectorAll('button')].find(b => b.textContent === '生成融合候选')!;
  expect(button.disabled).toBe(true);
  const checkboxes = [...container.querySelectorAll('label')].filter(l => l.textContent === '加入组合').map(l => l.querySelector('input')!);
  await act(async () => checkboxes[0]!.click());
  expect(button.disabled).toBe(true);
  await act(async () => checkboxes[1]!.click());
  expect(button.disabled).toBe(false);
  await act(async () => button.click());
  expect(fixture.combine).toHaveBeenCalledWith(expect.objectContaining({ batchId: 'TEST batch', optionIds: ['TEST first', 'TEST second'], authorMaterials: 'TEST explicit requirements' }));
  expect(fixture.select).not.toHaveBeenCalled();
});

it('TEST critical quality report exposes event evidence and prevents selection, combination and review-only retry', async () => {
  fixture.data.history = [{ stale: false, selections: [], batch: { id: 'TEST batch', inputSnapshot: { sourceVersion: 2 }, mode: 'restructure', amplitude: 'moderate', createdAt: 1, keptIds: [], state: 'failed', error: 'TEST critical gap', comparison: { summary: 'TEST quality blocked', options: [{ optionId: 'TEST first', concerns: ['TEST missing mechanism'], violations: [], qualityAudit: [{ checkpoint: 'resolutionSetup', status: 'gap', explanation: 'TEST missing trigger', evidence: [{ field: 'outline', quote: 'TEST real fixture event' }], findingIndices: [0] }] }] } }, cards: [{ id: 'TEST first', title: 'TEST failed outline', mainline: 'TEST mainline', outline: ['TEST real fixture event'], turns: [] }] }];
  await act(async () => root.render(createElement(StoryOptionsPanel, { owner: { novelId: scope.id }, scope })));
  expect(container.textContent).toContain('查看可用性事件审查');
  expect(container.textContent).toContain('高潮准备与生效 · 存在关键缺口');
  expect(container.textContent).toContain('TEST missing trigger');
  expect(container.textContent).not.toContain('恢复未完成阶段');
  expect([...container.querySelectorAll('button')].find(b => b.textContent === '选择这个大纲')!.disabled).toBe(true);
  expect([...container.querySelectorAll('button')].find(b => b.textContent === '生成融合候选')!.disabled).toBe(true);
  expect(fixture.select).not.toHaveBeenCalled();
});
