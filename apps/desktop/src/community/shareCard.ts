/**
 * 分享用的链接与文案。链接一定指向服务端网页（/n/:id、/u/:handle），
 * 桌面端的 hash 路由（#/public/...）在别人机器上打不开，绝不能出现在分享内容里。
 */
import { buildShareText, type NovelDetail, type UserProfile } from '@the-water/shared';

export interface ShareTarget {
  url: string;
  text: string;
  fileName: string;
}

export function novelShareUrl(novel: Pick<NovelDetail, 'id' | 'shareUrl'>, serverUrl: string): string {
  if (novel.shareUrl) return novel.shareUrl;
  return `${serverUrl.replace(/\/+$/, '')}/n/${encodeURIComponent(novel.id)}`;
}

export function authorShareUrl(user: Pick<UserProfile, 'handle' | 'shareUrl'>, serverUrl: string): string {
  if (user.shareUrl) return user.shareUrl;
  return `${serverUrl.replace(/\/+$/, '')}/u/${encodeURIComponent(user.handle)}`;
}

export function novelShareTarget(novel: NovelDetail, serverUrl: string): ShareTarget {
  const url = novelShareUrl(novel, serverUrl);
  return {
    url,
    text: buildShareText(
      {
        title: novel.title,
        summary: novel.summary,
        authorName: novel.author.displayName,
        handle: novel.author.handle,
        chapterCount: novel.chapterCount,
        charCount: novel.charCount,
        writingStatus: novel.writingStatus,
        likeCount: novel.likeCount,
        isDerivative: novel.isDerivative,
        sourceTitle: novel.source?.novel.title ?? null,
      },
      url,
    ),
    fileName: `${novel.title || '故事'}-分享卡.png`,
  };
}

export function authorShareTarget(user: UserProfile, serverUrl: string): ShareTarget {
  const url = authorShareUrl(user, serverUrl);
  const lines = [
    `${user.displayName}（@${user.handle}）`,
    user.bio?.trim() || `Lv.${user.level.level} ${user.level.title}`,
    `原创 ${user.stats.novelCount} · 二创 ${user.stats.derivativeCount} · 关注者 ${user.followerCount}`,
    url,
    '—— 来自 The Water · 读一本书，写一个故事',
  ];
  return { url, text: lines.join('\n'), fileName: `${user.displayName || user.handle}-主页.png` };
}
