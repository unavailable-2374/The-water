import { type ButtonHTMLAttributes, type HTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes, useEffect, useId, useRef } from 'react';
import { X } from 'lucide-react';
import { create } from 'zustand';
import { hashHue } from '@/community/avatar';
import { fmt, t } from '@/i18n';

export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'ai';
export function Button({ variant = 'secondary', size = 'md', className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' | 'lg' }) {
  // Keep selection backgrounds immediate: WKWebView can retain the old background after a color transition.
  const base = 'inline-flex shrink-0 items-center justify-center gap-2 rounded-xl font-medium transition-[box-shadow,transform] duration-150 disabled:opacity-40 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-accent-500/60 focus-visible:ring-offset-2 focus-visible:ring-offset-paper-50 active:scale-[0.98]';
  const sizes = { sm: 'min-h-8 px-3 py-1.5 text-xs', md: 'min-h-10 px-4 py-2 text-sm', lg: 'min-h-12 px-5 py-3 text-base' }[size];
  const variants: Record<Variant, string> = {
    primary: 'bg-accent-600 text-white shadow-soft hover:bg-accent-700',
    secondary: 'bg-paper-0 text-ink-800 shadow-soft ring-1 ring-paper-300/70 hover:bg-paper-100 dark:bg-paper-900 dark:text-paper-100 dark:ring-paper-800 dark:hover:bg-paper-800',
    ghost: 'text-ink-600 hover:bg-paper-200/70 hover:text-ink-900 dark:text-ink-300 dark:hover:bg-paper-800 dark:hover:text-paper-100',
    ai: 'bg-tea-600 text-paper-0 shadow-soft hover:bg-tea-700 hover:shadow-lift',
    danger: 'bg-paper-0 text-cinnabar-600 ring-1 ring-cinnabar-100 hover:bg-cinnabar-50 dark:bg-paper-900 dark:text-cinnabar-100 dark:ring-cinnabar-700/40 dark:hover:bg-cinnabar-700/20',
  };
  return <button className={cn(base, sizes, variants[variant], className)} {...props} />;
}

const fieldBase = 'w-full min-h-10 rounded-xl border border-paper-300/80 bg-paper-0 px-3.5 py-2.5 text-sm text-ink-900 placeholder:text-ink-400 transition focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/20 disabled:opacity-50 dark:border-paper-800 dark:bg-paper-950 dark:text-paper-100';
export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(fieldBase, className)} {...props} />;
}
export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(fieldBase, 'leading-relaxed', className)} {...props} />;
}
export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn(fieldBase, 'appearance-none bg-[url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2712%27 height=%2712%27 viewBox=%270 0 24 24%27 fill=%27none%27 stroke=%27%237d756b%27 stroke-width=%272%27%3E%3Cpath d=%27m6 9 6 6 6-6%27/%3E%3C/svg%3E")] bg-[length:12px] bg-[right_0.9rem_center] bg-no-repeat pr-9', className)} {...props}>{children}</select>;
}
export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-xs font-medium tracking-wide text-ink-600 dark:text-ink-300">{label}</span>
      {children}
      {hint && <span className="block text-xs leading-relaxed text-ink-400">{hint}</span>}
    </label>
  );
}

/** 卡片。剩余属性原样透传，方便调用处补 `role` / `aria-*` 这类无障碍属性。 */
export function Card({ className, children, hover, ...rest }: HTMLAttributes<HTMLDivElement> & { children: ReactNode; hover?: boolean }) {
  return <div className={cn('rounded-2xl border border-black/[0.05] bg-paper-0 p-6 shadow-soft dark:border-white/[0.07] dark:bg-paper-900', hover && 'transition-shadow hover:shadow-lift', className)} {...rest}>{children}</div>;
}

export function SectionTitle({ children, className, action }: { children: ReactNode; className?: string; action?: ReactNode }) {
  return (
    <div className={cn('mb-3 flex items-baseline justify-between', className)}>
      <h2 className="text-base font-semibold tracking-tight text-ink-800 dark:text-paper-100">{children}</h2>
      {action}
    </div>
  );
}

export type Tone = 'neutral' | 'green' | 'amber' | 'red' | 'blue' | 'ai';
export function Badge({ children, tone = 'neutral', dot, className }: { children: ReactNode; tone?: Tone; dot?: boolean; className?: string }) {
  const tones: Record<Tone, string> = {
    neutral: 'bg-paper-200 text-ink-600 dark:bg-paper-800 dark:text-ink-300',
    green: 'bg-tea-50 text-tea-700 dark:bg-tea-800/40 dark:text-tea-200',
    ai: 'bg-tea-50 text-tea-700 dark:bg-tea-800/40 dark:text-tea-200',
    amber: 'bg-amber-50 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200',
    red: 'bg-cinnabar-50 text-cinnabar-700 dark:bg-cinnabar-700/30 dark:text-cinnabar-100',
    blue: 'bg-accent-50 text-accent-700 dark:bg-accent-500/20 dark:text-accent-100',
  };
  const dots: Record<Tone, string> = { neutral: 'bg-ink-400', green: 'bg-tea-500', ai: 'bg-tea-500', amber: 'bg-amber-500', red: 'bg-cinnabar-500', blue: 'bg-tea-600' };
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium leading-none', tones[tone], className)}>
      {dot && <span className={cn('h-1.5 w-1.5 rounded-full', dots[tone])} />}
      {children}
    </span>
  );
}

/** 能接受焦点的元素；焦点陷阱靠它挑首尾两个。 */
const FOCUSABLE = 'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

function focusableIn(root: HTMLElement): HTMLElement[] {
  // 过滤掉不可见的：offsetParent 在 position:fixed 上会是 null，所以再用 getClientRects 兜一次。
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el === document.activeElement || el.offsetParent !== null || el.getClientRects().length > 0,
  );
}

/**
 * 模态对话框。
 *
 * 无障碍要点：`role="dialog" + aria-modal`，标题用 `aria-labelledby` 关联（读屏一打开就念标题）；
 * 打开时把焦点收进来、Tab 在框内循环、Esc 关闭，关闭后焦点还给原来那个元素——
 * 否则键盘用户一关框，焦点就掉回 body，得从头 Tab 一遍。
 */
export function Dialog({ open, onClose, title, children, width = 'max-w-lg', subtitle, placement = 'center' }: { open: boolean; onClose: () => void; title: string; children: ReactNode; width?: string; subtitle?: string; placement?: 'center' | 'right' }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const subtitleId = useId();

  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // 让读屏与键盘焦点都落进对话框：优先第一个可聚焦控件，没有就聚焦面板本身。
    const panel = panelRef.current;
    // 内容里显式写了 autoFocus 的控件优先（确认框的「确认」按钮就靠这个）。
    const preferred = panel?.querySelector<HTMLElement>('[autofocus]') ?? (panel ? focusableIn(panel)[0] : undefined);
    (preferred ?? panel)?.focus();
    return () => { restoreRef.current?.focus?.(); };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return; }
      if (e.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const items = focusableIn(panel);
      if (items.length === 0) { e.preventDefault(); panel.focus(); return; }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const activeInside = panel.contains(document.activeElement);
      if (!activeInside) { e.preventDefault(); first.focus(); return; }
      if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className={cn('dialog-overlay fixed inset-0 z-50 flex bg-black/30 backdrop-blur-sm', placement === 'right' ? 'items-stretch justify-end' : 'items-center justify-center p-4')} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={subtitle ? subtitleId : undefined}
        tabIndex={-1}
        className={cn('flex w-full flex-col border border-black/[0.08] bg-paper-50 shadow-lift outline-none dark:border-white/10 dark:bg-paper-900', placement === 'right' ? 'h-full min-h-0' : 'max-h-[90vh] rounded-3xl', width)}
      >
        <div className="flex items-start justify-between px-7 pt-6 pb-3">
          <div>
            <h2 id={titleId} className="text-lg font-semibold tracking-tight">{title}</h2>
            {subtitle && <p id={subtitleId} className="mt-0.5 text-xs text-ink-500">{subtitle}</p>}
          </div>
          <IconButton onClick={onClose} label={t.a11y.closeDialog}><X size={16} /></IconButton>
        </div>
        <div className={placement === 'right' ? 'min-h-0 flex-1 overflow-hidden' : 'overflow-y-auto px-7 pb-7'}>{children}</div>
      </div>
    </div>
  );
}

/**
 * 只有图标的按钮。`label` 是必填的：图标按钮不给无障碍名字，读屏念出来就是「按钮」。
 * 同时写进 `title`，鼠标用户也有气泡提示。
 */
export function IconButton({ label, className, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cn('inline-flex min-h-8 min-w-8 shrink-0 items-center justify-center rounded-lg p-1.5 text-ink-400 transition-colors hover:bg-paper-200 hover:text-ink-800 focus-visible:ring-2 focus-visible:ring-accent-500/60 dark:hover:bg-paper-800 dark:hover:text-paper-100', className)}
      {...props}
    >
      {children}
    </button>
  );
}

/**
 * 列表项上「悬停才出现」的操作按钮（删除之类）。
 *
 * 原来的写法是 `hidden group-hover:block`——`display:none` 会把按钮从 Tab 序列里摘掉，
 * 键盘用户根本够不着。这里改成透明度控制：元素一直在布局和 Tab 序列里，
 * 悬停显示，聚焦时也显示（`group-focus-within` + `focus-visible`），键盘走到它就能看见。
 * 父元素需要带 `group` 类。
 */
export function HoverAction({ label, className, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <IconButton
      label={label}
      className={cn('opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100', className)}
      {...props}
    >
      {children}
    </IconButton>
  );
}

/** 删除按钮的常用文案：读屏会念成「删除「某某」」而不是光秃秃一个「删除」。 */
export function deleteLabel(name: string): string {
  return fmt(t.a11y.deleteItem, { name });
}

export function Spinner({ className }: { className?: string }) {
  return <span aria-hidden="true" className={cn('inline-block shrink-0 h-4 w-4 animate-spin rounded-full border-2 border-paper-300 border-t-tea-600', className)} />;
}

export function EmptyState({ title, description, action, icon }: { title: string; description?: string; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex min-h-[360px] flex-col items-center justify-center gap-3 rounded-3xl border border-black/[0.05] bg-paper-0 px-6 py-16 text-center dark:border-white/[0.07] dark:bg-paper-900">
      {icon && <div className="mb-3 flex h-20 w-20 items-center justify-center rounded-3xl bg-accent-50 text-accent-600 dark:bg-accent-500/15 dark:text-accent-100">{icon}</div>}
      <p className="text-xl font-semibold tracking-tight text-ink-900 dark:text-paper-100">{title}</p>
      {description && <p className="max-w-sm text-sm leading-relaxed text-ink-500">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/** Generated book cover: warm gradient keyed by title, vertical title text. */
export function BookCover({ title, subtitle, className, size = 'md' }: { title: string; subtitle?: string; className?: string; size?: 'sm' | 'md' | 'lg' }) {
  const hue = hashHue(title);
  const dims = { sm: 'h-24 w-[68px]', md: 'h-44 w-32', lg: 'h-60 w-44' }[size];
  const text = { sm: 'text-[10px]', md: 'text-sm', lg: 'text-base' }[size];
  return (
    <div
      className={cn('relative flex shrink-0 overflow-hidden rounded-r-lg rounded-l-sm shadow-book', dims, className)}
      style={{ background: `linear-gradient(160deg, hsl(${hue} 32% 78%) 0%, hsl(${hue} 30% 62%) 60%, hsl(${(hue + 20) % 360} 28% 48%) 100%)` }}
    >
      <div className="absolute inset-y-0 left-0 w-[6px] bg-black/15" />
      <div className="absolute inset-0 paper-texture opacity-60" />
      <div className={cn('vertical-title absolute right-3 top-3 max-h-[85%] overflow-hidden font-serif font-semibold text-paper-0/95 drop-shadow', text)}>{title || t.common.untitled}</div>
      {subtitle && <div className="absolute bottom-2 left-3 text-[9px] text-paper-0/70">{subtitle}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 确认对话框：promise 化的 confirm()，替代原生 window.confirm。
 *
 *   import { confirm } from '@/components/ui';
 *   if (!(await confirm('确定要删除吗？'))) return;
 *   if (!(await confirm({ title: '删除这本小说？', description: '章节与版本会一起删掉。', tone: 'danger' }))) return;
 *
 * 用前要在应用根部挂一次 <ConfirmHost />（已在 app/App.tsx 挂好）。
 * ------------------------------------------------------------------ */

export interface ConfirmOptions {
  title: string;
  /** 补充说明，支持任意节点。 */
  description?: ReactNode;
  confirmText?: string;
  cancelText?: string;
  /** danger 用朱砂色主按钮，用于不可撤销的操作。 */
  tone?: 'default' | 'danger';
}

interface ConfirmRequest extends ConfirmOptions { id: number; resolve: (ok: boolean) => void }

interface ConfirmState {
  queue: ConfirmRequest[];
  push: (req: ConfirmRequest) => void;
  settle: (id: number, ok: boolean) => void;
}

const useConfirmStore = create<ConfirmState>((set, get) => ({
  queue: [],
  push: (req) => set((s) => ({ queue: [...s.queue, req] })),
  settle: (id, ok) => {
    const req = get().queue.find((q) => q.id === id);
    set((s) => ({ queue: s.queue.filter((q) => q.id !== id) }));
    req?.resolve(ok);
  },
}));

let confirmSeq = 1;

/** 弹一个确认框，返回用户是否点了「确认」。取消 / Esc / 点遮罩都算 false。 */
export function confirm(options: ConfirmOptions | string): Promise<boolean> {
  const opts: ConfirmOptions = typeof options === 'string' ? { title: options } : options;
  return new Promise<boolean>((resolve) => {
    useConfirmStore.getState().push({ ...opts, id: confirmSeq++, resolve });
  });
}

/** 确认框宿主，整个应用挂一次即可。 */
export function ConfirmHost() {
  const current = useConfirmStore((s) => s.queue[0] ?? null);
  const settle = useConfirmStore((s) => s.settle);
  const id = current?.id;
  useEffect(() => {
    if (id === undefined) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') { e.preventDefault(); settle(id, true); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [id, settle]);
  if (!current) return null;
  return (
    <Dialog open title={current.title} width="max-w-md" onClose={() => settle(current.id, false)}>
      {current.description && <div className="text-sm leading-relaxed text-ink-600 dark:text-ink-300">{current.description}</div>}
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="ghost" onClick={() => settle(current.id, false)}>{current.cancelText ?? t.common.cancel}</Button>
        <Button
          variant={current.tone === 'danger' ? 'danger' : 'primary'}
          autoFocus
          onClick={() => settle(current.id, true)}
        >
          {current.confirmText ?? t.common.confirm}
        </Button>
      </div>
    </Dialog>
  );
}
