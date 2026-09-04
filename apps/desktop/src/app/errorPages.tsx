import type { ReactNode } from 'react';
import { Link, useLocation, useRouteError, isRouteErrorResponse } from 'react-router';
import { Compass } from 'lucide-react';
import { t, fmt } from '@/i18n';
import { Button, EmptyState } from '@/components/ui';
import { ErrorBoundary, ErrorPanel } from '@/components/ErrorBoundary';

/** 出错页里都给一条回书架的退路。 */
function BackHome() {
  return <Link to="/library"><Button variant="ghost">{t.error.backHome}</Button></Link>;
}

/**
 * feature 级错误边界：一块出错只塌一块，其余导航照常可用。
 * 路由变化时自动清错，用户换个页面就能继续用。
 */
export function FeatureBoundary({ label, children }: { label: () => string; children: ReactNode }) {
  const loc = useLocation();
  return (
    <ErrorBoundary scope={label()} compact resetKey={loc.pathname} extra={<BackHome />}>
      {children}
    </ErrorBoundary>
  );
}

/** 路由级 errorElement：AppShell 自身或路由加载出错时兜底。 */
export function RouteErrorPage() {
  const error = useRouteError();
  if (isRouteErrorResponse(error) && error.status === 404) return <NotFoundPage />;
  return <ErrorPanel error={error} scope={t.error.routeScope} extra={<BackHome />} />;
}

/** 兜底 404。 */
export function NotFoundPage() {
  const loc = useLocation();
  return (
    <EmptyState
      icon={<Compass size={40} strokeWidth={1.25} />}
      title={t.error.notFoundTitle}
      description={fmt(t.error.notFoundDesc, { path: `${loc.pathname}${loc.search}` })}
      action={<Link to="/library"><Button variant="primary">{t.error.backHome}</Button></Link>}
    />
  );
}
