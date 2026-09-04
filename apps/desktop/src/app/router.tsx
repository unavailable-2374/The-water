import type { ReactElement } from 'react';
import { createHashRouter, Navigate } from 'react-router';
import { AppShell } from './layout/AppShell';
import { FeatureBoundary, NotFoundPage, RouteErrorPage } from './errorPages';
import { t } from '@/i18n';
import { LibraryPage } from '@/features/library/LibraryPage';
import { SettingsPage } from '@/features/settings/SettingsPage';
import { ChatPage } from '@/features/chat/ChatPage';
import { ReaderPage } from '@/features/reader/ReaderPage';
import { StudioPage } from '@/features/studio/StudioPage';
import { CreateWizard } from '@/features/studio/wizard/CreateWizard';
import { ImportTextPage } from '@/features/studio/ImportTextPage';
import { BrowsePage } from '@/features/publicArea/BrowsePage';
import { RemoteNovelPage } from '@/features/publicArea/RemoteNovelPage';
import { FeedPage } from '@/features/community/feed/FeedPage';
import { RankingPage } from '@/features/community/ranking/RankingPage';
import { AuthorPage } from '@/features/community/author/AuthorPage';
import { NotificationsPage } from '@/features/community/notifications/NotificationsPage';
import { MyPublicationsPage } from '@/features/publicArea/MyPublicationsPage';

/**
 * 每个页面套一层 feature 级错误边界：一块崩了不至于整窗白屏。
 * 名字用取值函数传：路由表是模块顶层建的，直接取字符串会把语言定死在启动那一刻。
 */
const feat = (label: () => string, element: ReactElement): ReactElement => (
  <FeatureBoundary label={label}>{element}</FeatureBoundary>
);

export const router = createHashRouter([
  {
    path: '/',
    element: <AppShell />,
    errorElement: <RouteErrorPage />,
    children: [
      { index: true, element: <Navigate to="/library" replace /> },
      { path: 'library', element: feat(() => t.nav.library, <LibraryPage />) },
      { path: 'chat', element: feat(() => t.nav.chat, <ChatPage />) },
      { path: 'reader/:documentId', element: feat(() => t.reader.title, <ReaderPage />) },
      { path: 'studio', element: <Navigate to="/library?tab=novels" replace /> },
      { path: 'studio/new', element: feat(() => t.library.newNovel, <CreateWizard />) },
      { path: 'studio/import', element: feat(() => t.library.importText, <ImportTextPage />) },
      { path: 'studio/:novelId/*', element: feat(() => t.nav.studio, <StudioPage />) },
      { path: 'public', element: feat(() => t.nav.public, <BrowsePage />) },
      // 静态段放在动态段之前，语义更清楚（react-router 本身也会优先匹配静态段）。
      { path: 'public/feed', element: feat(() => t.community.tabs.feed, <FeedPage />) },
      { path: 'public/ranking', element: feat(() => t.community.tabs.ranking, <RankingPage />) },
      { path: 'public/notifications', element: feat(() => t.nav.notifications, <NotificationsPage />) },
      { path: 'public/mine', element: feat(() => t.publicArea.tabMine, <MyPublicationsPage />) },
      { path: 'public/u/:handle', element: feat(() => t.community.authorPage, <AuthorPage />) },
      { path: 'public/:remoteId', element: feat(() => t.publicArea.novelDetail, <RemoteNovelPage />) },
      { path: 'settings/*', element: feat(() => t.nav.settings, <SettingsPage />) },
      // 未知路径落到这里，而不是渲染一个空壳。
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);
