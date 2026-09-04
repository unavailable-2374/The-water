import type { FC } from 'hono/jsx';
import {
  BADGE_BY_ID,
  LICENSE_LABELS,
  type AdminUser,
  type ChapterContent,
  type ChapterMeta,
  type ModerationEvent,
  type NovelDetail,
  type NovelSummary,
  type Report,
  type UserProfile,
} from '@the-water/shared';
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
    <Layout title="审核后台">
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
