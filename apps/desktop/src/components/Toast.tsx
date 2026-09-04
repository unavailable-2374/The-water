import { create } from 'zustand';

interface ToastItem { id: number; message: string; tone: 'info' | 'success' | 'error' }
interface ToastState { items: ToastItem[]; push: (message: string, tone?: ToastItem['tone']) => void; remove: (id: number) => void }
let seq = 1;
export const useToast = create<ToastState>((set) => ({
  items: [],
  push: (message, tone = 'info') => {
    const id = seq++;
    set((s) => ({ items: [...s.items, { id, message, tone }] }));
    setTimeout(() => set((s) => ({ items: s.items.filter((i) => i.id !== id) })), tone === 'error' ? 6000 : 3000);
  },
  remove: (id) => set((s) => ({ items: s.items.filter((i) => i.id !== id) })),
}));

export const toast = {
  info: (m: string) => useToast.getState().push(m, 'info'),
  success: (m: string) => useToast.getState().push(m, 'success'),
  error: (m: string) => useToast.getState().push(m, 'error'),
};

export function ToastHost() {
  const items = useToast((s) => s.items);
  return (
    <div className="pointer-events-none fixed bottom-16 right-6 z-[60] flex flex-col gap-2">
      {items.map((i) => (
        <div key={i.id} className={`pointer-events-auto rounded-2xl px-4 py-2.5 text-sm shadow-lift ${i.tone === 'error' ? 'bg-cinnabar-600 text-paper-0' : i.tone === 'success' ? 'bg-tea-600 text-paper-0' : 'bg-ink-800 text-paper-50'}`}>
          {i.message}
        </div>
      ))}
    </div>
  );
}
