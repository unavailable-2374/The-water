import { type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes, useEffect } from 'react';
import { X } from 'lucide-react';
import { hashHue } from '@/community/avatar';

export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'ai';
export function Button({ variant = 'secondary', size = 'md', className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' | 'lg' }) {
  const base = 'inline-flex items-center justify-center gap-1.5 rounded-xl font-medium transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-tea-500/50 active:scale-[0.98]';
  const sizes = { sm: 'px-2.5 py-1 text-xs', md: 'px-4 py-2 text-sm', lg: 'px-5 py-2.5 text-base' }[size];
  const variants: Record<Variant, string> = {
    primary: 'bg-cinnabar-600 text-paper-0 shadow-soft hover:bg-cinnabar-700 hover:shadow-lift',
    secondary: 'bg-paper-0 text-ink-800 shadow-soft ring-1 ring-paper-300/70 hover:bg-paper-100 dark:bg-paper-900 dark:text-paper-100 dark:ring-paper-800 dark:hover:bg-paper-800',
    ghost: 'text-ink-600 hover:bg-paper-200/70 hover:text-ink-900 dark:text-ink-300 dark:hover:bg-paper-800 dark:hover:text-paper-100',
    ai: 'bg-tea-600 text-paper-0 shadow-soft hover:bg-tea-700 hover:shadow-lift',
    danger: 'bg-paper-0 text-cinnabar-600 ring-1 ring-cinnabar-100 hover:bg-cinnabar-50 dark:bg-paper-900 dark:ring-cinnabar-700/40',
  };
  return <button className={cn(base, sizes, variants[variant], className)} {...props} />;
}

const fieldBase = 'w-full rounded-xl border border-paper-300 bg-paper-0 px-3.5 py-2 text-sm text-ink-900 placeholder:text-ink-400 transition focus:border-tea-500 focus:outline-none focus:ring-2 focus:ring-tea-500/20 dark:border-paper-800 dark:bg-paper-900 dark:text-paper-100';
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

export function Card({ className, children, hover }: { className?: string; children: ReactNode; hover?: boolean }) {
  return <div className={cn('rounded-2xl bg-paper-0 p-5 shadow-soft dark:bg-paper-900', hover && 'transition hover:shadow-lift', className)}>{children}</div>;
}

export function SectionTitle({ children, className, action }: { children: ReactNode; className?: string; action?: ReactNode }) {
  return (
    <div className={cn('mb-3 flex items-baseline justify-between', className)}>
      <h2 className="font-serif text-base font-semibold tracking-wide text-ink-800 dark:text-paper-100">{children}</h2>
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
    blue: 'bg-tea-100 text-tea-800 dark:bg-tea-800/40 dark:text-tea-100',
  };
  const dots: Record<Tone, string> = { neutral: 'bg-ink-400', green: 'bg-tea-500', ai: 'bg-tea-500', amber: 'bg-amber-500', red: 'bg-cinnabar-500', blue: 'bg-tea-600' };
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium leading-none', tones[tone], className)}>
      {dot && <span className={cn('h-1.5 w-1.5 rounded-full', dots[tone])} />}
      {children}
    </span>
  );
}

export function Dialog({ open, onClose, title, children, width = 'max-w-lg', subtitle }: { open: boolean; onClose: () => void; title: string; children: ReactNode; width?: string; subtitle?: string }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/30 p-4 backdrop-blur-[2px]" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={cn('flex max-h-[90vh] w-full flex-col rounded-3xl bg-paper-50 shadow-lift dark:bg-paper-900', width)}>
        <div className="flex items-start justify-between px-7 pt-6 pb-3">
          <div>
            <h2 className="font-serif text-lg font-semibold tracking-wide">{title}</h2>
            {subtitle && <p className="mt-0.5 text-xs text-ink-500">{subtitle}</p>}
          </div>
          <button onClick={onClose} className="rounded-full p-1.5 text-ink-400 hover:bg-paper-200 hover:text-ink-800 dark:hover:bg-paper-800" aria-label="关闭"><X size={16} /></button>
        </div>
        <div className="overflow-y-auto px-7 pb-7">{children}</div>
      </div>
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <span className={cn('inline-block h-4 w-4 animate-spin rounded-full border-2 border-paper-300 border-t-tea-600', className)} />;
}

export function EmptyState({ title, description, action, icon }: { title: string; description?: string; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-20 text-center">
      {icon && <div className="mb-1 text-paper-400">{icon}</div>}
      <p className="font-serif text-base text-ink-700 dark:text-paper-100">{title}</p>
      {description && <p className="max-w-xs text-sm leading-relaxed text-ink-400">{description}</p>}
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
      <div className={cn('vertical-title absolute right-3 top-3 max-h-[85%] overflow-hidden font-serif font-semibold text-paper-0/95 drop-shadow', text)}>{title || '未命名'}</div>
      {subtitle && <div className="absolute bottom-2 left-3 text-[9px] text-paper-0/70">{subtitle}</div>}
    </div>
  );
}
