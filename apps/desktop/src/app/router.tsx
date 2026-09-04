import { createHashRouter, Navigate } from 'react-router';
import { AppShell } from './layout/AppShell';
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

export const router = createHashRouter([
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <Navigate to="/library" replace /> },
      { path: 'library', element: <LibraryPage /> },
      { path: 'chat', element: <ChatPage /> },
      { path: 'reader/:documentId', element: <ReaderPage /> },
      { path: 'studio', element: <Navigate to="/library?tab=novels" replace /> },
      { path: 'studio/new', element: <CreateWizard /> },
      { path: 'studio/import', element: <ImportTextPage /> },
      { path: 'studio/:novelId/*', element: <StudioPage /> },
      { path: 'public', element: <BrowsePage /> },
      // 静态段放在动态段之前，语义更清楚（react-router 本身也会优先匹配静态段）。
      { path: 'public/feed', element: <FeedPage /> },
      { path: 'public/ranking', element: <RankingPage /> },
      { path: 'public/u/:handle', element: <AuthorPage /> },
      { path: 'public/:remoteId', element: <RemoteNovelPage /> },
      { path: 'settings/*', element: <SettingsPage /> },
    ],
  },
]);
