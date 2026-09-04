import { NavLink, Route, Routes, Navigate } from 'react-router';
import { t } from '@/i18n';
import { cn } from '@/components/ui';
import { ProvidersPage } from './ProvidersPage';
import { GeneralSettings } from './GeneralSettings';
import { AccountPanel } from './AccountPanel';
import { RelationsPanel } from './RelationsPanel';

/**
 * 左侧标签。写成函数而不是模块顶层常量表：`t` 是惰性代理，
 * 一旦把文案读进常量里，切语言就更新不了了。
 */
const tabs = () => [
  { to: 'providers', label: t.settings.providers },
  { to: 'general', label: t.settings.general },
  { to: 'account', label: t.settings.account },
  { to: 'community', label: t.settings.community },
];

export function SettingsPage() {
  return (
    <div className="flex h-full">
      <aside className="w-52 shrink-0 border-r border-paper-300/60 bg-paper-100/60 px-3 py-6 dark:border-paper-800 dark:bg-paper-900/60">
        <h1 className="mb-4 px-4 font-serif text-xl font-semibold tracking-wide">{t.nav.settings}</h1>
        {/* NavLink 命中时自带 aria-current="page"，读屏能听出当前在哪一栏。 */}
        <nav aria-label={t.settings.settingsNav}>
          {tabs().map((tab) => (
            <NavLink
              key={tab.to}
              to={`/settings/${tab.to}`}
              end
              className={({ isActive }) => cn(
                'mb-1 block rounded-full px-4 py-2 text-sm transition',
                isActive ? 'bg-paper-0 font-medium text-ink-900 shadow-soft dark:bg-paper-800 dark:text-paper-50' : 'text-ink-600 hover:bg-paper-200/60 dark:text-ink-300 dark:hover:bg-paper-800/60',
              )}
            >
              {tab.label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <section className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-10 py-10">
          <Routes>
            <Route index element={<Navigate to="/settings/providers" replace />} />
            <Route path="providers" element={<ProvidersPage />} />
            <Route path="general" element={<GeneralSettings />} />
            <Route path="account" element={<AccountPanel />} />
            <Route path="community" element={<RelationsPanel />} />
            <Route path="*" element={<Navigate to="/settings/providers" replace />} />
          </Routes>
        </div>
      </section>
    </div>
  );
}
