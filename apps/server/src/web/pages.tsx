import type { FC, PropsWithChildren } from 'hono/jsx';
import {
  BADGE_BY_ID,
  LICENSE_LABELS,
  normalizeTagSlug,
  type AdminUser,
  type ChapterContent,
  type ChapterMeta,
  type License,
  type ModerationEvent,
  type NovelDetail,
  type NovelSummary,
  type Report,
  type UserProfile,
} from '@the-water/shared';
import { Layout, type FeedLink, type OpenGraph } from './layout';
import {
  DEFAULT_PREFS,
  FONT_SIZES,
  FONT_SIZE_LABELS,
  LINE_HEIGHTS,
  LINE_HEIGHT_LABELS,
  THEMES,
  THEME_LABELS,
  WIDTHS,
  WIDTH_LABELS,
  withPrefs,
  type ReadPrefs,
} from './prefs';
import { SORT_LABELS, WEB_SORTS, type OffsetPage, type TagCount, type WebBrowseFilter, type WebSort } from './query';
import { jsonLd } from './seo';

const fmtDate = (s: string | null) => (s ? s.slice(0, 10) : '—');
const fmtChars = (n: number) => (n >= 10_000 ? `${(n / 10_000).toFixed(1)} 万字` : `${n} 字`);

/** 机器可读的许可地址，供 JSON-LD 的 license 字段用。 */
const LICENSE_URLS: Record<License, string | null> = {
  'all-rights-reserved': null,
  'cc-by': 'https://creativecommons.org/licenses/by/4.0/',
  'cc-by-sa': 'https://creativecommons.org/licenses/by-sa/4.0/',
  'cc-by-nc': 'https://creativecommons.org/licenses/by-nc/4.0/',
  'cc-by-nc-sa': 'https://creativecommons.org/licenses/by-nc-sa/4.0/',
  cc0: 'https://creativecommons.org/publicdomain/zero/1.0/',
};

const statusText = (s: NovelSummary['writingStatus']) => (s === 'completed' ? '已完结' : '连载中');

/** 页码导航。零 JS，全部是普通链接；`rel=prev/next` 同时写进 <head>。 */
export const Pagination: FC<{ page: number; pageCount: number; href: (p: number) => string; label: string }> = ({ page, pageCount, href, label }) => {
  if (pageCount <= 1) return null;
  const from = Math.max(1, Math.min(page - 2, pageCount - 4));
  const to = Math.min(pageCount, Math.max(page + 2, 5));
  const nums: number[] = [];
  for (let p = from; p <= to; p++) nums.push(p);
  return (
    <nav class="pages" aria-label={label}>
      {page > 1 ? (
        <a rel="prev" href={href(page - 1)}>
          ‹ 上一页
        </a>
      ) : null}
      {from > 1 ? <a href={href(1)}>1</a> : null}
      {from > 2 ? <span class="muted">…</span> : null}
      {nums.map((p) =>
        p === page ? (
          <strong aria-current="page">{p}</strong>
        ) : (
          <a href={href(p)}>{p}</a>
        ),
      )}
      {to < pageCount - 1 ? <span class="muted">…</span> : null}
      {to < pageCount ? <a href={href(pageCount)}>{pageCount}</a> : null}
      {page < pageCount ? (
        <a rel="next" href={href(page + 1)}>
          下一页 ›
        </a>
      ) : null}
      <span class="muted">
        第 {page} / {pageCount} 页
      </span>
    </nav>
  );
};

/** 作品卡片列表，首页 / 浏览页 / 作者页共用。 */
const NovelList: FC<{ items: NovelSummary[]; showAuthor?: boolean; empty: string }> = ({ items, showAuthor = true, empty }) => {
  if (items.length === 0) return <p class="muted">{empty}</p>;
  return (
    <ul class="list">
      {items.map((n) => (
        <li>
          <h3>
            <a href={`/n/${n.id}`}>{n.title}</a>
            {n.isDerivative ? <span class="muted">（二创）</span> : null}
          </h3>
          <div class="muted">
            {showAuthor ? `${n.author.displayName} · ` : ''}
            {n.chapterCount} 章 · {fmtChars(n.charCount)} · {statusText(n.writingStatus)} · 更新于 {fmtDate(n.lastPublishedAt)}
          </div>
          {n.summary ? <p>{n.summary.length > 120 ? `${n.summary.slice(0, 120)}…` : n.summary}</p> : null}
          {n.tags.length ? (
            <div class="tags">
              {n.tags.map((t) => (
                // 显示作者的原始写法，链接用归一化 slug，与浏览接口同口径。
                <a href={`/browse?tag=${encodeURIComponent(normalizeTagSlug(t))}`}>{t}</a>
              ))}
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
};

export interface PageChrome {
  canonical?: string | null;
  prefs?: ReadPrefs;
}

// ---- 首页 ----

export const HomePage: FC<
  PageChrome & { page: OffsetPage<NovelSummary>; hot: NovelSummary[]; tags: TagCount[]; href: (p: number) => string }
> = ({ page, hot, tags, href, canonical, prefs }) => (
  <Layout
    title=""
    description="The-Water 公共区：读一本书，写一个故事。浏览社区里公开的小说与二次创作。"
    canonical={canonical}
    prev={page.page > 1 ? href(page.page - 1) : null}
    next={page.page < page.pageCount ? href(page.page + 1) : null}
    feed={{ href: '/feed.xml', title: 'The-Water 公共区 · 最新更新' }}
    prefs={prefs}
  >
    <h1>最新作品</h1>
    {tags.length ? (
      <div class="tags" aria-label="热门标签">
        {tags.map((t) => (
          <a href={`/browse?tag=${encodeURIComponent(t.slug)}`}>
            {t.label} {t.novelCount}
          </a>
        ))}
        <a href="/tags">全部标签 ›</a>
      </div>
    ) : null}
    <NovelList items={page.items} empty="还没有已发布的作品。" />
    <Pagination page={page.page} pageCount={page.pageCount} href={href} label="最新作品分页" />
    {hot.length ? (
      <>
        <h2>最多阅读</h2>
        <NovelList items={hot} empty="暂无数据。" />
        <p>
          <a href="/browse?sort=popular">查看更多热门作品 ›</a>
        </p>
      </>
    ) : null}
  </Layout>
);

// ---- 浏览 / 搜索 ----

export interface BrowseView {
  filter: WebBrowseFilter;
  page: OffsetPage<NovelSummary>;
  tags: TagCount[];
  href: (p: number) => string;
}

const LICENSE_OPTIONS: { value: '' | License; label: string }[] = [
  { value: '', label: '全部许可' },
  ...(Object.keys(LICENSE_LABELS) as License[]).map((k) => ({ value: k, label: LICENSE_LABELS[k] })),
];

/**
 * 浏览页。筛选是一个普通的 GET 表单 —— 因此 `/browse` 的 CSP 需要 `form-action 'self'`，
 * 阅读页仍然保持 `'none'`（见 routes.tsx 的 headersFor）。
 */
export const BrowsePage: FC<PageChrome & { view: BrowseView }> = ({ view, canonical, prefs }) => {
  const { filter: f, page, href } = view;
  const heading = f.q ? `搜索「${f.q}」` : f.tag ? `标签「${f.tag}」` : SORT_LABELS[f.sort];
  return (
    <Layout
      title={heading}
      description={`The-Water 公共区作品浏览：${heading}，共 ${page.total} 本。`}
      canonical={canonical}
      prev={page.page > 1 ? href(page.page - 1) : null}
      next={page.page < page.pageCount ? href(page.page + 1) : null}
      feed={{ href: '/feed.xml', title: 'The-Water 公共区 · 最新更新' }}
      prefs={prefs}
    >
      <h1>浏览作品</h1>
      <form class="filters" method="get" action="/browse" role="search">
        <label>
          关键词
          <input type="text" name="q" value={f.q ?? ''} maxlength={50} placeholder="书名或简介" />
        </label>
        <label>
          标签
          <input type="text" name="tag" value={f.tag ?? ''} maxlength={20} placeholder="如：悬疑" />
        </label>
        <label>
          排序
          <select name="sort">
            {WEB_SORTS.map((s) => (
              <option value={s} selected={f.sort === s}>
                {SORT_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
        <label>
          状态
          <select name="status">
            <option value="" selected={!f.writingStatus}>
              全部状态
            </option>
            <option value="ongoing" selected={f.writingStatus === 'ongoing'}>
              连载中
            </option>
            <option value="completed" selected={f.writingStatus === 'completed'}>
              已完结
            </option>
          </select>
        </label>
        <label>
          许可
          <select name="license">
            {LICENSE_OPTIONS.map((o) => (
              <option value={o.value} selected={(f.license ?? '') === o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label class="check">
          <input type="checkbox" name="originals" value="1" checked={f.originalsOnly === true} />
          只看原创
        </label>
        <button type="submit">筛选</button>
      </form>
      {view.tags.length ? (
        <div class="tags" aria-label="热门标签">
          {view.tags.map((t) => (
            <a href={`/browse?tag=${encodeURIComponent(t.slug)}`}>
              {t.label} {t.novelCount}
            </a>
          ))}
        </div>
      ) : null}
      <h2>
        {heading} <span class="muted">共 {page.total} 本</span>
      </h2>
      <NovelList items={page.items} empty="没有符合条件的作品，换个条件试试。" />
      <Pagination page={page.page} pageCount={page.pageCount} href={href} label="浏览结果分页" />
    </Layout>
  );
};

// ---- 标签目录 ----

export const TagsPage: FC<PageChrome & { tags: TagCount[] }> = ({ tags, canonical, prefs }) => (
  <Layout title="标签目录" description="The-Water 公共区的全部作品标签。" canonical={canonical} prefs={prefs}>
    <h1>标签目录</h1>
    {tags.length === 0 ? (
      <p class="muted">还没有带标签的公开作品。</p>
    ) : (
      <div class="tags">
        {tags.map((t) => (
          <a href={`/browse?tag=${encodeURIComponent(t.slug)}`}>
            {t.label} {t.novelCount}
          </a>
        ))}
      </div>
    )}
  </Layout>
);

// ---- 下载 / 注册落地页（转化入口）----

export const DownloadPage: FC<PageChrome & { downloadUrl: string }> = ({ downloadUrl, canonical, prefs }) => (
  <Layout title="下载桌面端" description="下载 The-Water 桌面端：本地写作、AI 协作、发布到公共区并参与二创。" canonical={canonical} prefs={prefs} cta={false}>
    <h1>下载桌面端</h1>
    <p>网页版只提供阅读。要点赞、留言、收藏，或者把喜欢的作品二创成自己的版本，都需要一个账号和桌面端。</p>
    <h2>第一步：装桌面端</h2>
    <p>
      {downloadUrl ? (
        <a href={downloadUrl}>下载 The-Water 桌面端 ›</a>
      ) : (
        <span class="muted">本站尚未配置下载地址（部署时设置 DOWNLOAD_URL）。请向站点管理员索取安装包。</span>
      )}
    </p>
    <h2 id="register">第二步：注册账号</h2>
    <p>在桌面端「设置 → 账号」里填入本站地址并注册，邮箱验证通过后即可发布作品、点赞与留言。</p>
    <h2>第三步：开始创作</h2>
    <ul>
      <li>导入一本 PDF / TXT / Markdown，边读边和 AI 讨论。</li>
      <li>从零写一本：大纲 → 章节表 → 正文，全流程可续写、可回滚。</li>
      <li>看到允许二创的作品，一键 fork 成自己的版本，署名与溯源自动带上。</li>
    </ul>
    <p>
      <a href="/browse">先去逛逛作品 ›</a>
    </p>
  </Layout>
);

// ---- 作品详情 ----

export interface NovelPageProps extends PageChrome {
  novel: NovelDetail;
  chapters: ChapterMeta[];
  /** 目录分页。 */
  tocPage: number;
  tocPageCount: number;
  tocHref: (p: number) => string;
  totalChapters: number;
  og?: OpenGraph;
  /** 站点绝对地址（未配置 PUBLIC_BASE_URL 时按请求来源推导）。 */
  base: string;
  feed?: FeedLink | null;
}

function bookJsonLd(novel: NovelDetail, base: string, chapters: ChapterMeta[]): string {
  const url = `${base}/n/${encodeURIComponent(novel.id)}`;
  return jsonLd({
    '@context': 'https://schema.org',
    '@type': 'Book',
    name: novel.title,
    url,
    inLanguage: novel.language,
    description: novel.summary || undefined,
    genre: novel.tags.length ? novel.tags : undefined,
    numberOfPages: novel.chapterCount,
    license: LICENSE_URLS[novel.license] ?? undefined,
    datePublished: novel.publishedAt ?? undefined,
    dateModified: novel.lastPublishedAt ?? undefined,
    author: {
      '@type': 'Person',
      name: novel.author.displayName,
      alternateName: `@${novel.author.handle}`,
      url: `${base}/u/${encodeURIComponent(novel.author.handle)}`,
    },
    aggregateRating: undefined,
    interactionStatistic: [
      { '@type': 'InteractionCounter', interactionType: 'https://schema.org/ReadAction', userInteractionCount: novel.viewCount },
      { '@type': 'InteractionCounter', interactionType: 'https://schema.org/LikeAction', userInteractionCount: novel.likeCount },
    ],
    hasPart: chapters.map((ch) => ({
      '@type': 'Chapter',
      position: ch.index + 1,
      name: ch.title || `第 ${ch.index + 1} 章`,
      url: `${url}/c/${ch.index}`,
    })),
  });
}

export const NovelPage: FC<NovelPageProps> = ({ novel, chapters, tocPage, tocPageCount, tocHref, totalChapters, og, base, canonical, prefs, feed }) => (
  <Layout
    title={novel.title}
    description={novel.summary}
    og={{ type: 'book', imageWide: true, ...og }}
    canonical={canonical}
    prev={tocPage > 1 ? tocHref(tocPage - 1) : null}
    next={tocPage < tocPageCount ? tocHref(tocPage + 1) : null}
    jsonLd={bookJsonLd(novel, base, chapters)}
    feed={feed}
    prefs={prefs}
  >
    <h1>{novel.title}</h1>
    <div class="muted">
      作者：<a href={`/u/${novel.author.handle}`}>{novel.author.displayName}</a> · {novel.chapterCount} 章 · {fmtChars(novel.charCount)} · {statusText(novel.writingStatus)} · 许可：
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
          <a href={`/browse?tag=${encodeURIComponent(t)}`}>{t}</a>
        ))}
      </div>
    ) : null}
    <h2>
      章节目录{novel.currentVersion ? <span class="muted">（第 v{novel.currentVersion.versionNumber} 版）</span> : null}{' '}
      <span class="muted">共 {totalChapters} 章</span>
    </h2>
    {chapters.length === 0 ? (
      <p class="muted">这一页没有章节。</p>
    ) : (
      <ol class="toc" start={(chapters[0]?.index ?? 0) + 1}>
        {chapters.map((ch) => (
          <li>
            <a href={withPrefs(`/n/${novel.id}/c/${ch.index}`, prefs ?? DEFAULT_PREFS)}>{ch.title || `第 ${ch.index + 1} 章`}</a>
          </li>
        ))}
      </ol>
    )}
    <Pagination page={tocPage} pageCount={tocPageCount} href={tocHref} label="章节目录分页" />
  </Layout>
);

// ---- 章节正文 ----

function paragraphs(content: string): string[] {
  return content
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/** 阅读偏好条：全部是普通链接（不是表单），所以阅读页 CSP 不必放开 form-action。 */
const PrefsBar: FC<{ path: string; prefs: ReadPrefs }> = ({ path, prefs }) => {
  const Row: FC<PropsWithChildren<{ label: string }>> = ({ label, children }) => (
    <div class="row">
      <span>{label}</span>
      {children}
    </div>
  );
  const opt = <K extends keyof ReadPrefs>(key: K, value: ReadPrefs[K], label: string) =>
    prefs[key] === value ? (
      <strong aria-current="true">{label}</strong>
    ) : (
      <a rel="nofollow" href={withPrefs(path, prefs, { [key]: value } as Partial<ReadPrefs>)}>
        {label}
      </a>
    );
  return (
    <section class="prefs" aria-label="阅读偏好">
      <Row label="字号">{FONT_SIZES.map((v) => opt('fs', v, FONT_SIZE_LABELS[v]))}</Row>
      <Row label="行距">{LINE_HEIGHTS.map((v) => opt('lh', v, LINE_HEIGHT_LABELS[v]))}</Row>
      <Row label="宽度">{WIDTHS.map((v) => opt('w', v, WIDTH_LABELS[v]))}</Row>
      <Row label="主题">{THEMES.map((v) => opt('th', v, THEME_LABELS[v]))}</Row>
    </section>
  );
};

export interface ChapterPageProps extends PageChrome {
  novel: NovelDetail;
  chapter: ChapterContent;
  base: string;
  og?: OpenGraph;
}

export const ChapterPage: FC<ChapterPageProps> = ({ novel, chapter, base, og, canonical, prefs = DEFAULT_PREFS }) => {
  const title = chapter.title || `第 ${chapter.index + 1} 章`;
  const bookUrl = `${base}/n/${encodeURIComponent(novel.id)}`;
  const link = (i: number) => withPrefs(`/n/${novel.id}/c/${i}`, prefs);
  const ld = jsonLd({
    '@context': 'https://schema.org',
    '@type': 'Chapter',
    name: title,
    position: chapter.index + 1,
    url: `${bookUrl}/c/${chapter.index}`,
    inLanguage: novel.language,
    wordCount: chapter.charCount,
    isPartOf: { '@type': 'Book', name: novel.title, url: bookUrl },
    author: { '@type': 'Person', name: novel.author.displayName, url: `${base}/u/${encodeURIComponent(novel.author.handle)}` },
  });
  const pager = (
    <nav class="pager" aria-label="章节导航">
      {chapter.prev !== null ? <a href={link(chapter.prev)}>‹ 上一章</a> : <span class="muted">已是第一章</span>}
      <a href={withPrefs(`/n/${novel.id}`, prefs)}>目录</a>
      {chapter.next !== null ? <a href={link(chapter.next)}>下一章 ›</a> : <span class="muted">已是最后一章</span>}
    </nav>
  );
  return (
    <Layout
      title={`${title} - ${novel.title}`}
      description={`${novel.title}（${novel.author.displayName}）${title}`}
      og={{ type: 'article', imageWide: true, ...og }}
      canonical={canonical}
      prev={chapter.prev !== null ? `/n/${novel.id}/c/${chapter.prev}` : null}
      next={chapter.next !== null ? `/n/${novel.id}/c/${chapter.next}` : null}
      jsonLd={ld}
      feed={{ href: `/n/${novel.id}/feed.xml`, title: `${novel.title} · 更新` }}
      prefs={prefs}
    >
      <div class="muted">
        <a href={withPrefs(`/n/${novel.id}`, prefs)}>{novel.title}</a> · {novel.author.displayName}
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
      <PrefsBar path={`/n/${novel.id}/c/${chapter.index}`} prefs={prefs} />
    </Layout>
  );
};

// ---- 作者主页 ----

export interface AuthorPageProps extends PageChrome {
  user: UserProfile;
  page: OffsetPage<NovelSummary>;
  kind: 'all' | 'original' | 'derivative';
  href: (p: number) => string;
  kindHref: (k: 'all' | 'original' | 'derivative') => string;
  og?: OpenGraph;
  base: string;
}

const KIND_LABELS: Record<'all' | 'original' | 'derivative', string> = { all: '全部', original: '原创', derivative: '二创' };

/** 作者主页：作品分页 + 原创 / 二创筛选，附带等级、关注者与被二创次数。 */
export const AuthorPage: FC<AuthorPageProps> = ({ user, page, kind, href, kindHref, og, base, canonical, prefs }) => {
  const ld = jsonLd({
    '@context': 'https://schema.org',
    '@type': 'ProfilePage',
    url: `${base}/u/${encodeURIComponent(user.handle)}`,
    mainEntity: {
      '@type': 'Person',
      name: user.displayName,
      alternateName: `@${user.handle}`,
      description: user.bio ?? undefined,
      url: `${base}/u/${encodeURIComponent(user.handle)}`,
    },
  });
  return (
    <Layout
      title={user.displayName}
      description={user.bio ?? `${user.displayName} 在 The-Water 上的作品`}
      og={{ type: 'profile', imageWide: false, ...og }}
      canonical={canonical}
      prev={page.page > 1 ? href(page.page - 1) : null}
      next={page.page < page.pageCount ? href(page.page + 1) : null}
      jsonLd={ld}
      prefs={prefs}
    >
      <div class="profile">
        <img src={`/u/${user.handle}/avatar.svg`} alt="" width="72" height="72" />
        <div>
          <h1>{user.displayName}</h1>
          <div class="muted">
            @{user.handle} · Lv.{user.level.level} {user.level.title}
          </div>
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
      <h2>作品 <span class="muted">共 {page.total} 本</span></h2>
      <nav class="admin-filters" aria-label="作品类型筛选">
        {(['all', 'original', 'derivative'] as const).map((k) =>
          k === kind ? <strong>{KIND_LABELS[k]}</strong> : <a href={kindHref(k)}>{KIND_LABELS[k]}</a>,
        )}
      </nav>
      <NovelList
        items={page.items}
        showAuthor={false}
        empty={kind === 'derivative' ? '还没有发布二创作品。' : kind === 'original' ? '还没有发布原创作品。' : '还没有发布作品。'}
      />
      <Pagination page={page.page} pageCount={page.pageCount} href={href} label="作者作品分页" />
    </Layout>
  );
};

// ---- 审核后台（P0-6）----

export interface AdminReportView {
  report: Report;
  novelTitle: string;
  novelModerationStatus: 'ok' | 'hidden' | 'removed';
  commentBody: string | null;
  commentStatus: string | null;
}

export interface AdminPageData {
  /** 会话 token：零 JS 下只能靠链接与隐藏表单字段带着走。 */
  token: string;
  /** 动作完成后跳回的地址（含筛选条件）。 */
  back: string;
  adminName: string;
  reports: AdminReportView[];
  reportsNextCursor: string | null;
  reportStatus: 'open' | 'resolved' | 'dismissed';
  users: AdminUser[];
  usersNextCursor: string | null;
  q: string;
  userStatus: string;
  events: ModerationEvent[];
}

const REPORT_REASONS: Record<string, string> = {
  plagiarism: '抄袭',
  illegal: '违法',
  adult: '成人内容',
  spam: '垃圾信息',
  other: '其它',
};

const MOD_STATUS: Record<string, string> = { ok: '正常', hidden: '审核中', removed: '已下架' };
const USER_STATUS: Record<string, string> = { active: '正常', suspended: '禁言中', banned: '已封禁' };

const ACTION_LABELS: Record<string, string> = {
  auto_reject: '自动拦截',
  novel_hide: '作品转审核中',
  novel_remove: '作品下架',
  novel_restore: '作品恢复',
  comment_hide: '留言隐藏',
  comment_restore: '留言恢复',
  report_resolve: '举报已处理',
  report_dismiss: '举报被驳回',
  user_ban: '账号封禁',
  user_suspend: '账号禁言',
  user_unban: '解除封禁',
  user_auto_unban: '禁言到期自动恢复',
};

const Hidden: FC<{ token: string; back: string; id: string }> = ({ token, back, id }) => (
  <>
    <input type="hidden" name="token" value={token} />
    <input type="hidden" name="back" value={back} />
    <input type="hidden" name="id" value={id} />
  </>
);

/** 零 JS 管理页：读取用链接，动作用表单 POST 到 /admin/actions/*，完成后 303 跳回。 */
export const AdminPage: FC<{ data: AdminPageData }> = ({ data }) => {
  const { token, back } = data;
  const link = (extra: string) => `/admin?token=${encodeURIComponent(token)}${extra}`;
  return (
    <Layout title="审核后台" cta={false}>
      <h1>审核后台</h1>
      <p class="muted">当前管理员：{data.adminName}。所有动作都会记进审计日志。</p>

      <h2>举报队列</h2>
      <div class="admin-filters">
        {(['open', 'resolved', 'dismissed'] as const).map((s) => (
          <a href={link(`&reportStatus=${s}`)}>{s === 'open' ? '待处理' : s === 'resolved' ? '已处理' : '已驳回'}</a>
        ))}
      </div>
      {data.reports.length === 0 ? <p class="muted">没有符合条件的举报。</p> : null}
      {data.reports.map((r) => (
        <div class="card">
          <div class="muted">
            {fmtDate(r.report.createdAt)} · {REPORT_REASONS[r.report.reason] ?? r.report.reason} · 举报人 {r.report.reporterId ?? '匿名'} · 状态{' '}
            {r.report.status === 'open' ? '待处理' : r.report.status === 'resolved' ? '已处理' : '已驳回'}
          </div>
          <div>
            作品：<a href={`/n/${r.report.novelId}`}>{r.novelTitle}</a>（{MOD_STATUS[r.novelModerationStatus]}）
          </div>
          {r.report.commentId ? (
            <div>
              留言：{r.commentBody ? `「${r.commentBody.slice(0, 80)}」` : '（已不可见）'}（{r.commentStatus === 'ok' ? '正常' : '已隐藏'}）
            </div>
          ) : null}
          {r.report.detail ? <p>{r.report.detail}</p> : null}
          <form class="admin-form" method="post" action="/admin/actions/report">
            <Hidden token={token} back={back} id={r.report.id} />
            <input name="note" placeholder="处理备注（可选）" maxlength={500} />
            <button name="status" value="resolved" type="submit">
              标记已处理
            </button>
            <button name="status" value="dismissed" type="submit">
              驳回
            </button>
          </form>
          <form class="admin-form" method="post" action="/admin/actions/novel">
            <Hidden token={token} back={back} id={r.report.novelId} />
            <input name="note" placeholder="处置理由（可选）" maxlength={500} />
            <button name="moderationStatus" value="hidden" type="submit">
              转审核中
            </button>
            <button name="moderationStatus" value="removed" type="submit">
              下架作品
            </button>
            <button name="moderationStatus" value="ok" type="submit">
              恢复作品
            </button>
          </form>
          {r.report.commentId ? (
            <form class="admin-form" method="post" action="/admin/actions/comment">
              <Hidden token={token} back={back} id={r.report.commentId} />
              <button name="action" value="hide" type="submit">
                隐藏留言
              </button>
              <button name="action" value="restore" type="submit">
                恢复留言
              </button>
            </form>
          ) : null}
        </div>
      ))}
      {data.reportsNextCursor ? (
        <p>
          <a href={link(`&reportStatus=${data.reportStatus}&reportCursor=${encodeURIComponent(data.reportsNextCursor)}`)}>下一页举报 ›</a>
        </p>
      ) : null}

      <h2>用户</h2>
      <form class="admin-form" method="get" action="/admin">
        <input type="hidden" name="token" value={token} />
        <input name="q" value={data.q} placeholder="邮箱 / 用户名 / 昵称" maxlength={120} />
        <select name="userStatus">
          {['', 'active', 'suspended', 'banned'].map((s) => (
            <option value={s} selected={data.userStatus === s}>
              {s === '' ? '全部状态' : USER_STATUS[s]}
            </option>
          ))}
        </select>
        <button type="submit">搜索</button>
      </form>
      {data.users.length === 0 ? <p class="muted">没有匹配的用户。</p> : null}
      {data.users.map((u) => (
        <div class="card">
          <div>
            <a href={`/u/${u.handle}`}>{u.displayName}</a> <span class="muted">@{u.handle} · {u.email} · {u.role === 'admin' ? '管理员' : '普通用户'}</span>
          </div>
          <div class="muted">
            状态：{USER_STATUS[u.status]}
            {u.suspendedUntil ? ` · 解禁于 ${u.suspendedUntil.slice(0, 19).replace('T', ' ')}` : ''}
            {u.statusReason ? ` · 理由：${u.statusReason}` : ''}
          </div>
          {u.role === 'admin' ? (
            <div class="muted">管理员账号不提供封禁入口。</div>
          ) : u.status === 'active' ? (
            <form class="admin-form" method="post" action="/admin/actions/ban">
              <Hidden token={token} back={back} id={u.id} />
              <input name="reason" placeholder="封禁理由（必填）" maxlength={500} required />
              <input name="days" type="number" min="0" max="3650" placeholder="天数，留空为永久" />
              <button type="submit">封禁</button>
            </form>
          ) : (
            <form class="admin-form" method="post" action="/admin/actions/unban">
              <Hidden token={token} back={back} id={u.id} />
              <input name="note" placeholder="解封备注（可选）" maxlength={500} />
              <button type="submit">解除封禁</button>
            </form>
          )}
        </div>
      ))}
      {data.usersNextCursor ? (
        <p>
          <a href={link(`&q=${encodeURIComponent(data.q)}&userStatus=${data.userStatus}&userCursor=${encodeURIComponent(data.usersNextCursor)}`)}>
            下一页用户 ›
          </a>
        </p>
      ) : null}

      <h2>操作记录</h2>
      {data.events.length === 0 ? <p class="muted">还没有审核记录。</p> : null}
      <ul class="list">
        {data.events.map((e) => (
          <li>
            <div>
              {ACTION_LABELS[e.action] ?? e.action} · {e.targetType}/{e.targetId}
            </div>
            <div class="muted">
              {e.createdAt.slice(0, 19).replace('T', ' ')} · 操作者 {e.actorId ?? '系统'}
              {e.reason ? ` · ${e.reason}` : ''}
              {e.note ? ` · ${e.note}` : ''}
            </div>
          </li>
        ))}
      </ul>
    </Layout>
  );
};
