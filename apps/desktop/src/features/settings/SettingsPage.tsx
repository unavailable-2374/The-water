import { NavLink, Route, Routes, Navigate } from 'react-router';
import { t } from '@/i18n';
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
      <aside className="w-44 shrink-0 border-r border-paper-300/40 px-3 py-10 dark:border-paper-800 lg:w-52">
        <h1 className="mb-6 px-3 text-xl font-semibold tracking-tight">{t.nav.settings}</h1>
        {/* NavLink 命中时自带 aria-current="page"，读屏能听出当前在哪一栏。 */}
        <nav aria-label={t.settings.settingsNav}>
          {tabs().map((tab) => (
            <NavLink
              key={tab.to}
              to={`/settings/${tab.to}`}
              end
              className="nav-item"
            >
              {tab.label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <section className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-6 py-10 lg:px-10">
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
