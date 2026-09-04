import type { ReactElement } from 'react';
import { createHashRouter, Navigate } from 'react-router';
import { AppShell } from './layout/AppShell';
import { FeatureBoundary, NotFoundPage, RouteErrorPage } from './errorPages';
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

/** 每个页面套一层 feature 级错误边界：一块崩了不至于整窗白屏。 */
const feat = (label: string, element: ReactElement): ReactElement => (
  <FeatureBoundary label={label}>{element}</FeatureBoundary>
);

export const router = createHashRouter([
  {
    path: '/',
    element: <AppShell />,
    errorElement: <RouteErrorPage />,
    children: [
      { index: true, element: <Navigate to="/library" replace /> },
      { path: 'library', element: feat('书架', <LibraryPage />) },
      { path: 'chat', element: feat('随手问 AI', <ChatPage />) },
      { path: 'reader/:documentId', element: feat('阅读器', <ReaderPage />) },
      { path: 'studio', element: <Navigate to="/library?tab=novels" replace /> },
      { path: 'studio/new', element: feat('新建小说', <CreateWizard />) },
      { path: 'studio/import', element: feat('导入文本', <ImportTextPage />) },
      { path: 'studio/:novelId/*', element: feat('我的故事', <StudioPage />) },
      { path: 'public', element: feat('公共书房', <BrowsePage />) },
      // 静态段放在动态段之前，语义更清楚（react-router 本身也会优先匹配静态段）。
      { path: 'public/feed', element: feat('动态', <FeedPage />) },
      { path: 'public/ranking', element: feat('榜单', <RankingPage />) },
      { path: 'public/u/:handle', element: feat('作者主页', <AuthorPage />) },
      { path: 'public/:remoteId', element: feat('作品详情', <RemoteNovelPage />) },
      { path: 'settings/*', element: feat('设置', <SettingsPage />) },
      // 未知路径落到这里，而不是渲染一个空壳。
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);
