import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from '@/components/Toast';

export type SaveMode = 'debounce' | 'now';

/** Entity keys whose pending edits must be dropped (the row was deleted). */
const discarded = new Set<string>();
/** Call before deleting an entity so its form's unmount flush does not re-insert it. */
export function discardPendingSaves(key: string): void {
  discarded.add(key);
}

/**
 * Local form state with autosave: text edits are debounced (600ms), discrete edits
 * (selects / checkboxes) persist immediately, and `flush` runs on blur and unmount.
 * Remount the owning component (via `key`) when the edited entity changes.
 */
export function useAutosave<T>(initial: T, persist: (value: T) => Promise<void>, opts: { key?: string; delay?: number } = {}) {
  const { key, delay = 600 } = opts;
  const [form, setForm] = useState<T>(initial);
  const latest = useRef<T>(initial);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persistRef = useRef(persist);
  persistRef.current = persist;

  const flush = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (!dirty.current) return;
    dirty.current = false;
    if (key && discarded.has(key)) return;
    void persistRef.current(latest.current).catch((e: unknown) => toast.error(e instanceof Error ? e.message : String(e)));
  }, [key]);

  const update = useCallback((patch: Partial<T>, mode: SaveMode = 'debounce') => {
    const next = { ...latest.current, ...patch };
    latest.current = next;
    setForm(next);
    dirty.current = true;
    if (timer.current) clearTimeout(timer.current);
    if (mode === 'now') flush();
    else timer.current = setTimeout(flush, delay);
  }, [flush, delay]);

  useEffect(() => () => flush(), [flush]);

  return { form, update, flush };
}
