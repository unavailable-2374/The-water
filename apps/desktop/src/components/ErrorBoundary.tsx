import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, ClipboardCopy, LifeBuoy, RotateCcw } from 'lucide-react';
import { fmt, t } from '@/i18n';
import { Button } from './ui';
import { toast } from './Toast';
import { copyText } from '@/platform/clipboard';
import { exportDiagnosticsBundle } from '@/diagnostics';
import { errorMessageOf, errorStackOf, formatErrorReport } from './errorReport';

/** 出错面板：根级和 feature 级共用，只是文案与留白不同。 */
export function ErrorPanel({ error, scope, componentStack, onRetry, compact, extra }: {
  error: unknown;
  scope?: string;
  componentStack?: string | null;
  onRetry?: () => void;
  /** feature 级用紧凑版，根级用整页版。 */
  compact?: boolean;
  extra?: ReactNode;
}) {
  const report = async () => {
    try {
      await copyText(formatErrorReport({
        error,
        scope,
        componentStack,
        route: typeof window !== 'undefined' ? window.location.hash || window.location.pathname : undefined,
        userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
      }));
      toast.success(t.error.copied);
    } catch {
      toast.error(t.error.copyFail);
    }
  };
  /** 诊断包比「复制错误详情」多带日志与环境，出问题时更好排查。 */
  const bundle = async () => {
    try {
      const path = await exportDiagnosticsBundle();
      if (path) toast.success(fmt(t.settings.diagnosticsExported, { path }));
    } catch (e) {
      toast.error(fmt(t.settings.diagnosticsFailed, { msg: e instanceof Error ? e.message : String(e) }));
    }
  };
  return (
    <div className={compact ? 'flex h-full items-center justify-center p-8' : 'flex h-full items-center justify-center p-10'}>
      {/* 出错面板是「必须让人立刻知道」的内容，给读屏一个 alert。 */}
      <div role="alert" aria-live="assertive" className="w-full max-w-lg rounded-2xl bg-paper-0 p-7 shadow-soft dark:bg-paper-900">
        <div className="flex items-center gap-2.5 text-cinnabar-600">
          <AlertTriangle size={20} strokeWidth={1.75} aria-hidden="true" />
          <h2 className="font-serif text-lg font-semibold tracking-wide">{scope ? `${scope}${t.error.titleSuffix}` : t.error.title}</h2>
        </div>
        <p className="mt-2 text-sm leading-relaxed text-ink-500">{t.error.desc}</p>
        <pre tabIndex={0} className="mt-4 max-h-40 overflow-auto whitespace-pre-wrap rounded-xl bg-paper-100 p-3 text-xs leading-relaxed text-ink-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-tea-500/50 dark:bg-paper-950 dark:text-ink-300">{errorMessageOf(error)}</pre>
        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-ink-400">{t.error.detail}</summary>
          <pre tabIndex={0} className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap text-[11px] leading-relaxed text-ink-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-tea-500/50">{errorStackOf(error)}{componentStack ? `\n${componentStack}` : ''}</pre>
        </details>
        <div className="mt-5 flex flex-wrap gap-2">
          {onRetry && <Button variant="primary" onClick={onRetry}><RotateCcw size={16} strokeWidth={1.75} aria-hidden="true" />{t.common.retry}</Button>}
          <Button variant="secondary" onClick={() => void report()}><ClipboardCopy size={16} strokeWidth={1.75} aria-hidden="true" />{t.error.feedback}</Button>
          <Button variant="secondary" onClick={() => void bundle()}><LifeBuoy size={16} strokeWidth={1.75} aria-hidden="true" />{t.settings.exportDiagnostics}</Button>
          {extra}
        </div>
      </div>
    </div>
  );
}

interface Props {
  children: ReactNode;
  /** 出错位置名，会写进错误详情里。 */
  scope?: string;
  compact?: boolean;
  extra?: ReactNode;
  /** 值变化时自动清掉已有错误（路由切换后不该继续卡在错误页）。不会导致子树重挂。 */
  resetKey?: string | number;
}
interface State { error: unknown; componentStack: string | null }

/**
 * 渲染错误边界。React 只认类组件，所以这里保留 class 写法。
 * 「重试」清掉自身错误状态重新渲染子树；子树里的一次性坏数据通常就此恢复。
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, componentStack: null };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[ErrorBoundary${this.props.scope ? `:${this.props.scope}` : ''}]`, error, info.componentStack);
    this.setState({ componentStack: info.componentStack ?? null });
  }

  componentDidUpdate(prev: Props): void {
    if (this.state.error !== null && prev.resetKey !== this.props.resetKey) this.retry();
  }

  private retry = (): void => this.setState({ error: null, componentStack: null });

  render(): ReactNode {
    if (this.state.error === null) return this.props.children;
    return (
      <ErrorPanel
        error={this.state.error}
        scope={this.props.scope}
        componentStack={this.state.componentStack}
        compact={this.props.compact}
        extra={this.props.extra}
        onRetry={this.retry}
      />
    );
  }
}
