// @vitest-environment happy-dom
// TEST fixtures exercise real React hooks; no model output or production data.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAutosave } from '@/features/studio/storyline/useAutosave';
import { flushAssistantEditors } from '@/assistant/editorBridge';

vi.mock('@/components/Toast', () => ({ toast: { error: vi.fn() } }));
type Character = { name: string; description: string; role: string };
const original: Character = { name: 'TEST character', description: 'TEST old description', role: 'TEST original role' };
const revised = { ...original, description: 'TEST externally revised description' };
let root: Root;
let element: HTMLDivElement;
let form: ReturnType<typeof useAutosave<Character>>;
let persist: (value: Character) => Promise<void>;
function Form({ source }: { source: Character }) {
  form = useAutosave(source, persist, { key: 'TEST-character', novelId: 'TEST-novel', delay: 60000 });
  return createElement('textarea', { value: form.form.description, readOnly: true });
}
async function render(source: Character) {
  await act(async () => { root.render(createElement(Form, { source })); });
}
async function flush() {
  await act(async () => { await flushAssistantEditors('TEST-novel'); });
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  element = document.createElement('div');
  document.body.append(element);
  root = createRoot(element);
  persist = vi.fn(async () => {});
});
afterEach(async () => {
  await act(async () => root.unmount());
  element.remove();
});
describe('autosave saved-source synchronization', () => {
  it('refreshes an open clean form after an assistant edit and undo, without writing', async () => {
    await render(original);
    await render(revised);
    expect(element.querySelector('textarea')?.value).toBe(revised.description);
    await flush();
    expect(persist).not.toHaveBeenCalled();
    await render(original);
    expect(form.form).toEqual(original);
  });
  it('subsequent manual edits persist the revised source, not the stale character', async () => {
    await render(original);
    await render(revised);
    await act(async () => form.update({ role: 'TEST revised role' }));
    await flush();
    expect(persist).toHaveBeenCalledWith({ ...revised, role: 'TEST revised role' });
  });
  it('does not reset an unsaved local edit on a source reload', async () => {
    await render(original);
    await act(async () => form.update({ description: 'TEST unsaved local edit' }));
    await render(revised);
    expect(form.form.description).toBe('TEST unsaved local edit');
    await flush();
    expect(persist).toHaveBeenCalledWith({ ...original, description: 'TEST unsaved local edit' });
  });
  it('waits for a pending save before showing a newer saved source', async () => {
    let finish!: () => void;
    persist = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    await render(original);
    await act(async () => form.update({ description: 'TEST saving edit' }, 'now'));
    await render(revised);
    expect(form.form.description).toBe('TEST saving edit');
    await act(async () => { finish(); await flushAssistantEditors('TEST-novel'); });
    expect(form.form).toEqual(revised);
  });
  it('retains a failed local save and propagates the real error to the assistant', async () => {
    const error = new Error('TEST save rejected');
    persist = vi.fn(async () => { throw error; });
    await render(original);
    await act(async () => form.update({ description: 'TEST failed edit' }));
    await expect(flush()).rejects.toThrow('TEST save rejected');
    await render(revised);
    expect(form.form.description).toBe('TEST failed edit');
    persist = vi.fn(async () => {});
    await render(revised);
    await flush();
    expect(persist).toHaveBeenCalledWith({ ...original, description: 'TEST failed edit' });
  });
  it('keeps a second local edit while an earlier save is in flight', async () => {
    let finish!: () => void;
    persist = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    await render(original);
    await act(async () => form.update({ description: 'TEST first edit' }, 'now'));
    await act(async () => form.update({ description: 'TEST second edit' }));
    await render(revised);
    await act(async () => finish());
    expect(form.form.description).toBe('TEST second edit');
    persist = vi.fn(async () => {});
    await render(revised);
    await flush();
    expect(persist).toHaveBeenCalledWith({ ...original, description: 'TEST second edit' });
  });
});
