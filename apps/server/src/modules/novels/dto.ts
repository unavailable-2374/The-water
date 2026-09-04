import type { AuthorCard, NovelDetail, NovelRef, NovelSummary, VersionSummary } from '@the-water/shared';
import type { NovelRow, NovelVersionRow, UserRow } from '../../db/schema';
import { iso, isoOrNull } from '../../lib/time';

export const UNAVAILABLE_TITLE = '（已下架）';

export function toVersionSummary(v: NovelVersionRow): VersionSummary {
  return {
    id: v.id,
    novelId: v.novelId,
    versionNumber: v.versionNumber,
    status: v.status,
    storylineHash: v.storylineHash,
    chapterCount: v.chapterCount,
    charCount: v.charCount,
    changeNote: v.changeNote,
    createdAt: iso(v.createdAt),
    committedAt: isoOrNull(v.committedAt),
  };
}

/** 列表查询里 select 出来的作者字段。 */
export type AuthorParts = Pick<UserRow, 'id' | 'displayName' | 'handle'>;

export function toAuthorCard(a: AuthorParts): AuthorCard {
  return { id: a.id, displayName: a.displayName, handle: a.handle };
}

export function toNovelSummary(n: NovelRow, author: AuthorParts): NovelSummary {
  return {
    id: n.id,
    title: n.title,
    summary: n.summary,
    tags: n.tags,
    language: n.language,
    writingStatus: n.writingStatus,
    license: n.license,
    allowDerivatives: n.allowDerivatives,
    visibility: n.visibility,
    author: toAuthorCard(author),
    chapterCount: n.chapterCount,
    charCount: n.charCount,
    viewCount: n.viewCount,
    likeCount: n.likeCount,
    forkCount: n.forkCount,
    isDerivative: n.sourceNovelId !== null,
    publishedAt: isoOrNull(n.publishedAt),
    lastPublishedAt: isoOrNull(n.lastPublishedAt),
    updatedAt: iso(n.updatedAt),
  };
}

export function unavailableRef(id: string): NovelRef {
  return { id, title: UNAVAILABLE_TITLE, authorDisplayName: '', visibility: 'unavailable' };
}

export function toNovelRef(n: NovelRow, author: Pick<UserRow, 'displayName'>): NovelRef {
  return { id: n.id, title: n.title, authorDisplayName: author.displayName, visibility: 'public' };
}

export interface DetailParts {
  author: AuthorParts;
  currentVersion: NovelVersionRow | null;
  source: { ref: NovelRef; versionId: string; versionNumber: number } | null;
  viewer: { liked: boolean; forked: boolean; followingAuthor: boolean; blockedAuthor: boolean } | null;
  shareUrl: string | null;
}

export function toNovelDetail(n: NovelRow, parts: DetailParts): NovelDetail {
  return {
    ...toNovelSummary(n, parts.author),
    moderationStatus: n.moderationStatus,
    currentVersion: parts.currentVersion ? toVersionSummary(parts.currentVersion) : null,
    source: parts.source
      ? { novel: parts.source.ref, versionId: parts.source.versionId, versionNumber: parts.source.versionNumber }
      : null,
    rootNovelId: n.rootNovelId,
    depth: n.depth,
    commentCount: n.commentCount,
    shareUrl: parts.shareUrl,
    viewer: parts.viewer,
  };
}
