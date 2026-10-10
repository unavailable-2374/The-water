import { useEffect, useState } from 'react';
import { fmt, t } from '@/i18n';

/** Decorative motion; it indicates a pending operation, never fabricated model progress. */
export function ActivityIndicator({ className = '' }: { className?: string }) {
  return <span className={`activity-dots inline-flex shrink-0 items-center gap-1 ${className}`} aria-hidden="true">
    <span /><span /><span />
  </span>;
}

export function ActivityStatus({ label, startedAt, elapsed = false, className = '' }: { label: string; startedAt?: number | null; elapsed?: boolean; className?: string }) {
  const [mountedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!elapsed) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [elapsed]);
  const seconds = Math.max(0, Math.floor((now - (startedAt ?? mountedAt)) / 1000));
  return <span className={`inline-flex flex-wrap items-center gap-x-2 gap-y-1 ${className}`} role="status">
    <ActivityIndicator />
    <span>{label}</span>
    {elapsed && <span className="text-xs tabular-nums text-ink-400" aria-live="off">{fmt(t.common.elapsedTime, { seconds })}</span>}
  </span>;
}

/** Completed-step ratio stays truthful; the separate moving highlight only signals activity. */
export function TaskProgress({ percent, active, label, className = '' }: { percent: number; active: boolean; label: string; className?: string }) {
  const value = Math.max(0, Math.min(100, percent));
  return <div className={`relative h-1 overflow-hidden rounded-full bg-paper-300 dark:bg-paper-800 ${className}`} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value} aria-valuetext={label}>
    <div className="h-full rounded-full bg-accent-500 transition-[width] duration-300" style={{ width: `${value}%` }} />
    {active && <div className="activity-track absolute inset-y-0 left-0 w-1/3 rounded-full bg-accent-500/50" aria-hidden="true" />}
  </div>;
}

export function StreamingCursor() {
  return <span className="activity-cursor ml-0.5 inline-block h-[1em] w-0.5 bg-accent-500 align-text-bottom" aria-hidden="true" />;
}
