import type { FC } from 'hono/jsx';
import { BADGE_BY_ID, LICENSE_LABELS, type ChapterContent, type ChapterMeta, type NovelDetail, type NovelSummary, type UserProfile } from '@the-water/shared';
import { Layout, type OpenGraph } from './layout';

const fmtDate = (s: string | null) => (s ? s.slice(0, 10) : '—');
const fmtChars = (n: number) => (n >= 10_000 ? `${(n / 10_000).toFixed(1)} 万字` : `${n} 字`);

export const HomePage: FC<{ items: NovelSummary[] }> = ({ items }) => (
  <Layout title="">
    <h1>最新作品</h1>
    {items.length === 0 ? <p class="muted">还没有已发布的作品。</p> : null}
    <ul class="list">
      {items.map((n) => (
        <li>
          <h3>
            <a href={`/n/${n.id}`}>{n.title}</a>
            {n.isDerivative ? <span class="muted">（二创）</span> : null}
          </h3>
          <div class="muted">
            {n.author.displayName} · {n.chapterCount} 章 · {fmtChars(n.charCount)} · {n.writingStatus === 'completed' ? '已完结' : '连载中'} · 更新于{' '}
            {fmtDate(n.lastPublishedAt)}
          </div>
          {n.summary ? <p>{n.summary.length > 120 ? `${n.summary.slice(0, 120)}…` : n.summary}</p> : null}
          {n.tags.length ? (
            <div class="tags">
              {n.tags.map((t) => (
                <span>{t}</span>
              ))}
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  </Layout>
);

export const NovelPage: FC<{ novel: NovelDetail; chapters: ChapterMeta[]; og?: OpenGraph }> = ({ novel, chapters, og }) => (
  <Layout title={novel.title} description={novel.summary} og={{ type: 'book', ...og }}>
    <h1>{novel.title}</h1>
    <div class="muted">
      作者：<a href={`/u/${novel.author.handle}`}>{novel.author.displayName}</a> · {novel.chapterCount} 章 · {fmtChars(novel.charCount)} · {novel.writingStatus === 'completed' ? '已完结' : '连载中'} · 许可：
      {LICENSE_LABELS[novel.license]} · {novel.allowDerivatives ? '允许二创' : '不允许二创'} · 浏览 {novel.viewCount} · 赞 {novel.likeCount} · 二创{' '}
      {novel.forkCount}
    </div>
    {novel.source ? (
      <div class="origin">
        改编自{' '}
        {novel.source.novel.visibility === 'public' ? (
          <a href={`/n/${novel.source.novel.id}`}>《{novel.source.novel.title}》</a>
        ) : (
          <span>《{novel.source.novel.title}》</span>
        )}{' '}
        第 v{novel.source.versionNumber} 版{novel.source.novel.authorDisplayName ? `（${novel.source.novel.authorDisplayName}）` : ''}
      </div>
    ) : null}
    {novel.summary ? <p>{novel.summary}</p> : null}
    {novel.tags.length ? (
      <div class="tags">
        {novel.tags.map((t) => (
          <span>{t}</span>
        ))}
      </div>
    ) : null}
    <h2>章节目录{novel.currentVersion ? <span class="muted">（第 v{novel.currentVersion.versionNumber} 版）</span> : null}</h2>
    <ol class="toc">
      {chapters.map((ch) => (
        <li>
          <a href={`/n/${novel.id}/c/${ch.index}`}>{ch.title || `第 ${ch.index + 1} 章`}</a>
        </li>
      ))}
    </ol>
  </Layout>
);

function paragraphs(content: string): string[] {
  return content
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
}

export const ChapterPage: FC<{ novel: NovelDetail; chapter: ChapterContent }> = ({ novel, chapter }) => {
  const title = chapter.title || `第 ${chapter.index + 1} 章`;
  const pager = (
    <nav class="pager">
      {chapter.prev !== null ? <a href={`/n/${novel.id}/c/${chapter.prev}`}>‹ 上一章</a> : <span class="muted">已是第一章</span>}
      <a href={`/n/${novel.id}`}>目录</a>
      {chapter.next !== null ? <a href={`/n/${novel.id}/c/${chapter.next}`}>下一章 ›</a> : <span class="muted">已是最后一章</span>}
    </nav>
  );
  return (
    <Layout title={`${title} - ${novel.title}`}>
      <div class="muted">
        <a href={`/n/${novel.id}`}>{novel.title}</a> · {novel.author.displayName}
      </div>
      <h1>{title}</h1>
      <div class="muted">{fmtChars(chapter.charCount)}</div>
      <article class="chapter">
        {paragraphs(chapter.content).map((p) => (
          <p>
            {p.split('\n').map((line, i) => (
              <>
                {i > 0 ? <br /> : null}
                {line}
              </>
            ))}
          </p>
        ))}
      </article>
      {pager}
    </Layout>
  );
};

/** 作者主页：原创与二创分栏，附带等级、关注者与被二创次数。 */
export const AuthorPage: FC<{ user: UserProfile; novels: NovelSummary[]; og?: OpenGraph }> = ({ user, novels, og }) => {
  const originals = novels.filter((n) => !n.isDerivative);
  const derivatives = novels.filter((n) => n.isDerivative);
  return (
    <Layout title={user.displayName} description={user.bio ?? `${user.displayName} 在 The-Water 上的作品`} og={{ type: 'profile', ...og }}>
      <div class="profile">
        <img src={`/u/${user.handle}/avatar.svg`} alt="" width="72" height="72" />
        <div>
          <h1>{user.displayName}</h1>
          <div class="muted">@{user.handle} · Lv.{user.level.level} {user.level.title}</div>
        </div>
      </div>
      {user.bio ? <p>{user.bio}</p> : null}
      <div class="stats">
        <span>关注者 {user.followerCount}</span>
        <span>原创 {user.stats.novelCount}</span>
        <span>二创 {user.stats.derivativeCount}</span>
        <span>被二创 {user.stats.derivedCount}</span>
        <span>获赞 {user.stats.likeReceived}</span>
        <span>阅读 {user.stats.viewReceived}</span>
      </div>
      {user.badges.length ? (
        <div class="badges">
          {user.badges.map((b) => (
            <span>{BADGE_BY_ID[b.id]?.name ?? b.id}</span>
          ))}
        </div>
      ) : null}
      <AuthorSection title="原创" items={originals} empty="还没有发布原创作品。" />
      <AuthorSection title="二创" items={derivatives} empty="还没有发布二创作品。" />
    </Layout>
  );
};

const AuthorSection: FC<{ title: string; items: NovelSummary[]; empty: string }> = ({ title, items, empty }) => (
  <>
    <h2>{title}</h2>
    {items.length === 0 ? (
      <p class="muted">{empty}</p>
    ) : (
      <ul class="list">
        {items.map((n) => (
          <li>
            <h3>
              <a href={`/n/${n.id}`}>{n.title}</a>
            </h3>
            <div class="muted">
              {n.chapterCount} 章 · {fmtChars(n.charCount)} · {n.writingStatus === 'completed' ? '已完结' : '连载中'} · 更新于 {fmtDate(n.lastPublishedAt)}
            </div>
            {n.summary ? <p>{n.summary.length > 120 ? `${n.summary.slice(0, 120)}…` : n.summary}</p> : null}
          </li>
        ))}
      </ul>
    )}
  </>
);
