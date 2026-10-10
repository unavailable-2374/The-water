import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from '@/components/Toast';
import { registerAssistantDraft } from '@/assistant/editorBridge';

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
 * Saved source updates refresh clean forms (including assistant edits/undo).
 * Pending local edits and saves retain ownership of their form state.
 */
export function useAutosave<T>(initial: T, persist: (value: T) => Promise<void>, opts: { key?: string; delay?: number; novelId?:string } = {}) {
  const { key, delay = 600 } = opts;
  const [form, setForm] = useState<T>(initial);
  const latest = useRef<T>(initial);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persistRef = useRef(persist);
  persistRef.current = persist;
  const queue=useRef<Promise<void>>(Promise.resolve());
  const failure=useRef<unknown>(null);
  const pending = useRef(0);
  const sourceSignature = JSON.stringify(initial);
  const source = useRef({ value: initial, signature: sourceSignature, version: 0 });

  useEffect(() => {
    if (source.current.signature === sourceSignature) return;
    source.current = { value: initial, signature: sourceSignature, version: source.current.version + 1 };
    if (!dirty.current && pending.current === 0) {
      latest.current = initial;
      setForm(initial);
    }
  }, [initial, sourceSignature]);

  const flushAsync = useCallback(async () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (dirty.current && !(key && discarded.has(key))) {
      const value=latest.current,save=persistRef.current;
      const sourceVersion = source.current.version;
      pending.current++;
      dirty.current=false;
      queue.current=queue.current.catch(()=>{}).then(()=>save(value)).then(()=>{failure.current=null;},error=>{
        failure.current=error;
        if(latest.current===value) dirty.current=true;
      }).finally(() => {
        pending.current--;
        if (pending.current === 0 && !dirty.current && source.current.version > sourceVersion) {
          latest.current = source.current.value;
          setForm(source.current.value);
        }
      });
    }
    await queue.current;
    if(failure.current) throw failure.current;
  }, [key]);
  const flush=useCallback(()=>{void flushAsync().catch((e:unknown)=>toast.error(e instanceof Error?e.message:String(e)));},[flushAsync]);
  useEffect(()=>opts.novelId?registerAssistantDraft({novelId:opts.novelId,flush:flushAsync}):undefined,[opts.novelId,flushAsync]);

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
