import type { ActivityKind } from '@the-water/shared';

export interface ActivityLike {
  kind: ActivityKind;
  novel: { title: string; isDerivative: boolean };
  source?: { title: string } | null;
  version?: { versionNumber: number } | null;
}

/** 动态卡片上那句话：谁做了什么。书名单独返回，方便前端把它做成链接。 */
export function activityVerb(a: ActivityLike): string {
  switch (a.kind) {
    case 'novel_published':
      return a.novel.isDerivative && a.source ? `发布了《${a.source.title}》的二创` : '发布了新故事';
    case 'version_published':
      return a.version ? `更新到第 ${a.version.versionNumber} 版` : '更新了故事';
    case 'novel_completed':
      return '写完了这个故事';
  }
}
