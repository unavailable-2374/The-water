/**
 * 契约测试：每个端点的成功响应与错误响应都必须通过 packages/shared 中对应的 zod schema。
 */
import { describe, expect, it } from 'bun:test';
import {
  ApiErrorSchema,
  AuthResponseSchema,
  BlockResponseSchema,
  CommentListResponseSchema,
  CommentResponseSchema,
  FeedResponseSchema,
  FollowResponseSchema,
  LeaderboardResponseSchema,
  MarkNotificationsReadResponseSchema,
  MyPointsResponseSchema,
  NotificationListResponseSchema,
  UnreadCountResponseSchema,
  UserListResponseSchema,
  UserProfileResponseSchema,
  ChapterContentSchema,
  ChapterListResponseSchema,
  CommitVersionResponseSchema,
  CreateVersionResponseSchema,
  ForkListResponseSchema,
  ForkResponseSchema,
  HealthResponseSchema,
  LikeResponseSchema,
  LineageResponseSchema,
  AccountExportResponseSchema,
  AttributionResponseSchema,
  BookmarkListResponseSchema,
  BookmarkResponseSchema,
  FoldedFeedResponseSchema,
  PopularTagsResponseSchema,
  ReadingProgressListResponseSchema,
  ReadingProgressResponseSchema,
  SetCurrentVersionResponseSchema,
  TagListResponseSchema,
  MeResponseSchema,
  SessionListResponseSchema,
  NovelBundleV1Schema,
  NovelListResponseSchema,
  NovelResponseSchema,
  OkResponseSchema,
  ReportListResponseSchema,
  ReportResponseSchema,
  StorylineResponseSchema,
  UploadBlobsResponseSchema,
  VersionListResponseSchema,
  VersionStatusResponseSchema,
  ViewResponseSchema,
  ERROR_STATUS,
} from '@the-water/shared';
import type { z } from 'zod';
import { expectSchema, makeChapters, makeTestApp, manifestOf, sampleStoryline, NOVEL_REQ } from './helpers';

describe('contract: every endpoint response validates against shared schemas', () => {
  it('walks every endpoint', async () => {
    const t = makeTestApp();
    const covered: string[] = [];
    const check = async <S extends z.ZodTypeAny>(
      label: string,
      method: string,
      path: string,
      schema: S,
      opts: Parameters<typeof t.json>[2] = {},
      expectedStatus = 200,
    ): Promise<z.infer<S>> => {
      const r = await t.json(method, path, opts);
      if (r.status !== expectedStatus) throw new Error(`${label}: expected ${expectedStatus}, got ${r.status} ${JSON.stringify(r.body)}`);
      expect(r.res.headers.get('X-Request-Id')).toBeTruthy();
      covered.push(label);
      return expectSchema(schema, r.body);
    };
    const checkError = async (label: string, method: string, path: string, opts: Parameters<typeof t.json>[2] = {}) => {
      const r = await t.json(method, path, opts);
      const body = expectSchema(ApiErrorSchema, r.body);
      expect(r.status).toBe(ERROR_STATUS[body.error.code]);
      covered.push(`${label} (error ${body.error.code})`);
    };

    await check('GET /health', 'GET', '/health', HealthResponseSchema);
    await check('GET /api/v1/health', 'GET', '/api/v1/health', HealthResponseSchema);

    // auth
    const reg = await check('POST /auth/register', 'POST', '/api/v1/auth/register', AuthResponseSchema, { body: { email: 'a@example.com', password: 'password123', displayName: '甲' } }, 201);
    const a = reg.token;
    const login = await check('POST /auth/login', 'POST', '/api/v1/auth/login', AuthResponseSchema, { body: { email: 'a@example.com', password: 'password123' } });
    await check('GET /auth/me', 'GET', '/api/v1/auth/me', MeResponseSchema, { token: a });
    await check('PATCH /auth/me', 'PATCH', '/api/v1/auth/me', MeResponseSchema, { token: a, body: { bio: '你好' } });
    await check('POST /auth/logout', 'POST', '/api/v1/auth/logout', OkResponseSchema, { token: login.token });
    const extra = await check('POST /auth/login (2)', 'POST', '/api/v1/auth/login', AuthResponseSchema, { body: { email: 'a@example.com', password: 'password123' } });
    await check('DELETE /auth/sessions', 'DELETE', '/api/v1/auth/sessions', OkResponseSchema, { token: extra.token });

    // 账号生命周期（P0-4）与设备列表（§3.6）
    const life = await check('POST /auth/register (life)', 'POST', '/api/v1/auth/register', AuthResponseSchema, { body: { email: 'life@example.com', password: 'password123', displayName: '生命周期' } }, 201);
    const mailToken = () => /tw_[A-Za-z0-9_-]{43}/.exec(t.outbox.at(-1)!.text)![0]!;
    await check('POST /auth/email/verify/request', 'POST', '/api/v1/auth/email/verify/request', OkResponseSchema, { token: life.token }, 202);
    await check('POST /auth/email/verify', 'POST', '/api/v1/auth/email/verify', MeResponseSchema, { body: { token: mailToken() } });
    await check('GET /auth/sessions', 'GET', '/api/v1/auth/sessions', SessionListResponseSchema, { token: life.token });
    await check('GET /auth/me/export', 'GET', '/api/v1/auth/me/export', AccountExportResponseSchema, { token: life.token });
    await check('PATCH /auth/password', 'PATCH', '/api/v1/auth/password', OkResponseSchema, { token: life.token, body: { currentPassword: 'password123', newPassword: 'password456' } });
    await check('POST /auth/password/forgot', 'POST', '/api/v1/auth/password/forgot', OkResponseSchema, { body: { email: 'life@example.com' } }, 202);
    await check('POST /auth/password/reset', 'POST', '/api/v1/auth/password/reset', OkResponseSchema, { body: { token: mailToken(), password: 'password789' } });
    const life2 = await check('POST /auth/login (life)', 'POST', '/api/v1/auth/login', AuthResponseSchema, { body: { email: 'life@example.com', password: 'password789' } });
    await check('POST /auth/login (life 2)', 'POST', '/api/v1/auth/login', AuthResponseSchema, { body: { email: 'life@example.com', password: 'password789', clientLabel: 'iPad' } });
    const lifeSessions = await check('GET /auth/sessions (2)', 'GET', '/api/v1/auth/sessions', SessionListResponseSchema, { token: life2.token });
    await check('DELETE /auth/sessions/:id', 'DELETE', `/api/v1/auth/sessions/${lifeSessions.sessions.find((s) => !s.current)!.id}`, OkResponseSchema, { token: life2.token });
    await check('DELETE /auth/me', 'DELETE', '/api/v1/auth/me', OkResponseSchema, { token: life2.token, body: { password: 'password789', mode: 'keep_works' } });
    const relog = await check('POST /auth/login (3)', 'POST', '/api/v1/auth/login', AuthResponseSchema, { body: { email: 'a@example.com', password: 'password123' } });
    const author = relog.token;
    const b = (await t.register('b@example.com', '乙')).token;
    const admin = (await t.register('admin@example.com', '管理员')).token;

    // novels
    const created = await check('POST /novels', 'POST', '/api/v1/novels', NovelResponseSchema, { token: author, body: NOVEL_REQ }, 201);
    const nid = created.novel.id;
    await check('PATCH /novels/:id', 'PATCH', `/api/v1/novels/${nid}`, NovelResponseSchema, { token: author, body: { summary: '新简介' } });
    await check('GET /me/novels', 'GET', '/api/v1/me/novels', NovelListResponseSchema, { token: author });

    // versions + blobs
    const chs = await makeChapters(3, 42, 200);
    const draft = await check(
      'POST /novels/:id/versions',
      'POST',
      `/api/v1/novels/${nid}/versions`,
      CreateVersionResponseSchema,
      { token: author, headers: { 'Idempotency-Key': 'k' }, body: { storyline: sampleStoryline(), bible: null, chapters: manifestOf(chs) } },
      201,
    );
    await check('POST /novels/:id/versions (idempotent)', 'POST', `/api/v1/novels/${nid}/versions`, CreateVersionResponseSchema, {
      token: author,
      headers: { 'Idempotency-Key': 'k' },
      body: { storyline: sampleStoryline(), bible: null, chapters: manifestOf(chs) },
    });
    await check('GET /novels/:id/versions/:vid (draft)', 'GET', `/api/v1/novels/${nid}/versions/${draft.version.id}`, VersionStatusResponseSchema, { token: author });
    await checkError('POST commit missing blobs', 'POST', `/api/v1/novels/${nid}/versions/${draft.version.id}/commit`, { token: author });
    await check('POST /blobs', 'POST', '/api/v1/blobs', UploadBlobsResponseSchema, { token: author, body: { blobs: chs.map((c) => ({ hash: c.hash, content: c.content })) } });
    const committed = await check('POST /novels/:id/versions/:vid/commit', 'POST', `/api/v1/novels/${nid}/versions/${draft.version.id}/commit`, CommitVersionResponseSchema, { token: author });
    expect(committed.novel.visibility).toBe('public');
    await check('GET /novels/:id/versions/:vid (committed)', 'GET', `/api/v1/novels/${nid}/versions/current`, VersionStatusResponseSchema);
    await check('GET /novels/:id/versions', 'GET', `/api/v1/novels/${nid}/versions`, VersionListResponseSchema);
    const draft2 = await check('POST /novels/:id/versions (2)', 'POST', `/api/v1/novels/${nid}/versions`, CreateVersionResponseSchema, {
      token: author,
      headers: { 'Idempotency-Key': 'k2' },
      body: { storyline: sampleStoryline('另一个前提'), bible: null, chapters: manifestOf(chs) },
    }, 201);
    await check('DELETE /novels/:id/versions/:vid', 'DELETE', `/api/v1/novels/${nid}/versions/${draft2.version.id}`, OkResponseSchema, { token: author });

    // browse
    await check('GET /novels', 'GET', '/api/v1/novels?sort=popular&tag=言情', NovelListResponseSchema);
    await check('GET /novels/:id', 'GET', `/api/v1/novels/${nid}`, NovelResponseSchema, { token: b });
    await check('GET /novels/:id (anon)', 'GET', `/api/v1/novels/${nid}`, NovelResponseSchema);
    await check('GET .../storyline', 'GET', `/api/v1/novels/${nid}/versions/current/storyline`, StorylineResponseSchema);
    await check('GET .../chapters', 'GET', `/api/v1/novels/${nid}/versions/current/chapters?from=1`, ChapterListResponseSchema);
    await check('GET .../chapters/:index', 'GET', `/api/v1/novels/${nid}/versions/current/chapters/0`, ChapterContentSchema);

    // 标签目录与用户搜索（§3.4）
    await check('GET /tags', 'GET', '/api/v1/tags', TagListResponseSchema);
    await check('GET /tags?sort=name', 'GET', '/api/v1/tags?sort=name&q=言', TagListResponseSchema);
    await check('GET /tags/popular', 'GET', '/api/v1/tags/popular?limit=5', PopularTagsResponseSchema);
    await check('GET /users?q=', 'GET', '/api/v1/users?q=u_', UserListResponseSchema);

    // 想读书架与阅读进度（§3.4）
    await check('GET /novels/:id/bookmark', 'GET', `/api/v1/novels/${nid}/bookmark`, BookmarkResponseSchema, { token: b });
    await check('PUT /novels/:id/bookmark', 'PUT', `/api/v1/novels/${nid}/bookmark`, BookmarkResponseSchema, { token: b });
    await check('GET /me/bookmarks', 'GET', '/api/v1/me/bookmarks', BookmarkListResponseSchema, { token: b });
    await check('DELETE /novels/:id/bookmark', 'DELETE', `/api/v1/novels/${nid}/bookmark`, BookmarkResponseSchema, { token: b });
    await check('PUT /novels/:id/progress', 'PUT', `/api/v1/novels/${nid}/progress`, ReadingProgressResponseSchema, { token: b, body: { chapterIndex: 0, percent: 25 } });
    await check('GET /novels/:id/progress', 'GET', `/api/v1/novels/${nid}/progress`, ReadingProgressResponseSchema, { token: b });
    await check('GET /me/progress', 'GET', '/api/v1/me/progress', ReadingProgressListResponseSchema, { token: b });

    // 许可与署名（§3.7）
    await check('GET /novels/:id/attribution', 'GET', `/api/v1/novels/${nid}/attribution`, AttributionResponseSchema);

    // 版本回滚（§3.2）
    await check('PUT /novels/:id/current-version', 'PUT', `/api/v1/novels/${nid}/current-version`, SetCurrentVersionResponseSchema, { token: author, body: { versionId: committed.version.id } });

    // forks / lineage / bundle
    const fork = await check('POST /novels/:id/forks', 'POST', `/api/v1/novels/${nid}/forks`, ForkResponseSchema, { token: b, body: {} }, 201);
    await check('GET .../bundle', 'GET', `/api/v1/novels/${nid}/versions/current/bundle?forkId=${fork.fork.id}`, NovelBundleV1Schema, { token: b });
    await check('GET .../bundle (anon)', 'GET', `/api/v1/novels/${nid}/versions/current/bundle`, NovelBundleV1Schema);
    const deriv = await check('POST /novels (derivative)', 'POST', '/api/v1/novels', NovelResponseSchema, {
      token: b,
      body: { ...NOVEL_REQ, title: '二创', source: { forkId: fork.fork.id } },
    }, 201);
    expect(deriv.novel.source?.novel.id).toBe(nid);
    await check('GET /me/forks', 'GET', '/api/v1/me/forks', ForkListResponseSchema, { token: b });
    await check('GET /novels/:id/lineage', 'GET', `/api/v1/novels/${nid}/lineage`, LineageResponseSchema);

    // social
    await check('PUT /novels/:id/like', 'PUT', `/api/v1/novels/${nid}/like`, LikeResponseSchema, { token: b });
    await check('GET /me/likes', 'GET', '/api/v1/me/likes', NovelListResponseSchema, { token: b });
    await check('DELETE /novels/:id/like', 'DELETE', `/api/v1/novels/${nid}/like`, LikeResponseSchema, { token: b });
    await check('POST /novels/:id/view', 'POST', `/api/v1/novels/${nid}/view`, ViewResponseSchema, { headers: { 'X-Client-Id': 'client-contract-1' } });
    const report = await check('POST /novels/:id/reports', 'POST', `/api/v1/novels/${nid}/reports`, ReportResponseSchema, { token: b, body: { reason: 'other', detail: '测试' } }, 201);

    // 社区：作者主页与关系
    const bUserId = (await t.json('GET', '/api/v1/auth/me', { token: b })).body.user.id;
    const authorId = (await t.json('GET', '/api/v1/auth/me', { token: author })).body.user.id;
    const authorHandle = (await t.json('GET', '/api/v1/auth/me', { token: author })).body.user.handle;
    await check('GET /users/:id', 'GET', `/api/v1/users/${authorId}`, UserProfileResponseSchema, { token: b });
    await check('GET /users/by-handle/:handle', 'GET', `/api/v1/users/by-handle/${authorHandle}`, UserProfileResponseSchema);
    await check('GET /users/:id/novels', 'GET', `/api/v1/users/${authorId}/novels?kind=original`, NovelListResponseSchema);
    await check('PUT /users/:id/follow', 'PUT', `/api/v1/users/${authorId}/follow`, FollowResponseSchema, { token: b });
    await check('GET /me/following', 'GET', '/api/v1/me/following', UserListResponseSchema, { token: b });
    await check('GET /me/followers', 'GET', '/api/v1/me/followers', UserListResponseSchema, { token: author });
    await check('DELETE /users/:id/follow', 'DELETE', `/api/v1/users/${authorId}/follow`, FollowResponseSchema, { token: b });
    await check('PUT /users/:id/block', 'PUT', `/api/v1/users/${bUserId}/block`, BlockResponseSchema, { token: author });
    await check('GET /me/blocks', 'GET', '/api/v1/me/blocks', UserListResponseSchema, { token: author });
    await checkError('403 blocked fork', 'POST', `/api/v1/novels/${nid}/forks`, { token: b, body: {} });
    await check('DELETE /users/:id/block', 'DELETE', `/api/v1/users/${bUserId}/block`, BlockResponseSchema, { token: author });
    await checkError('409 handle taken', 'PATCH', '/api/v1/auth/me', { token: b, body: { handle: authorHandle } });

    // 社区：动态
    await check('GET /feed (folded)', 'GET', '/api/v1/feed?scope=all', FoldedFeedResponseSchema);
    await check('GET /feed (raw)', 'GET', '/api/v1/feed?scope=all&collapse=false', FeedResponseSchema);
    await check('GET /feed (following)', 'GET', '/api/v1/feed', FeedResponseSchema, { token: b });

    // 社区：留言
    const comment = await check('POST /novels/:id/comments', 'POST', `/api/v1/novels/${nid}/comments`, CommentResponseSchema, { token: b, body: { body: '好看' } }, 201);
    await check('POST /novels/:id/comments (reply)', 'POST', `/api/v1/novels/${nid}/comments`, CommentResponseSchema, { token: author, body: { body: '谢谢', replyToId: comment.comment.id } }, 201);
    await check('GET /novels/:id/comments', 'GET', `/api/v1/novels/${nid}/comments`, CommentListResponseSchema);
    await check('GET .../comments/:cid/replies', 'GET', `/api/v1/novels/${nid}/comments/${comment.comment.id}/replies`, CommentListResponseSchema);
    // §3.6：章节级留言、编辑、点赞
    const chapterComment = await check('POST /novels/:id/comments (chapter)', 'POST', `/api/v1/novels/${nid}/comments`, CommentResponseSchema, { token: b, body: { body: '第一章好看', chapterIndex: 0 } }, 201);
    expect(chapterComment.comment.chapterIndex).toBe(0);
    await check('GET /novels/:id/comments?chapter=0', 'GET', `/api/v1/novels/${nid}/comments?chapter=0`, CommentListResponseSchema);
    await check('GET /novels/:id/comments?chapter=novel', 'GET', `/api/v1/novels/${nid}/comments?chapter=novel`, CommentListResponseSchema);
    await check('PATCH /novels/:id/comments/:cid', 'PATCH', `/api/v1/novels/${nid}/comments/${chapterComment.comment.id}`, CommentResponseSchema, { token: b, body: { body: '第一章非常好看' } });
    await check('PUT .../comments/:cid/like', 'PUT', `/api/v1/novels/${nid}/comments/${chapterComment.comment.id}/like`, LikeResponseSchema, { token: author });
    await check('DELETE .../comments/:cid/like', 'DELETE', `/api/v1/novels/${nid}/comments/${chapterComment.comment.id}/like`, LikeResponseSchema, { token: author });

    // §3.1：站内通知
    const inbox = await check('GET /me/notifications', 'GET', '/api/v1/me/notifications', NotificationListResponseSchema, { token: author });
    await check('GET /me/notifications (unread)', 'GET', '/api/v1/me/notifications?filter=unread&limit=5', NotificationListResponseSchema, { token: author });
    await check('GET /me/notifications/unread-count', 'GET', '/api/v1/me/notifications/unread-count', UnreadCountResponseSchema, { token: author });
    await check('POST /me/notifications/read (ids)', 'POST', '/api/v1/me/notifications/read', MarkNotificationsReadResponseSchema, { token: author, body: { ids: inbox.items.slice(0, 1).map((n) => n.id) } });
    await check('POST /me/notifications/read (all)', 'POST', '/api/v1/me/notifications/read', MarkNotificationsReadResponseSchema, { token: author, body: { all: true } });
    await checkError('400 notifications read', 'POST', '/api/v1/me/notifications/read', { token: author, body: {} });

    const commentReport = await check('POST .../comments/:cid/reports', 'POST', `/api/v1/novels/${nid}/comments/${comment.comment.id}/reports`, ReportResponseSchema, { token: author, body: { reason: 'spam' } }, 201);
    expect(commentReport.report.commentId).toBe(comment.comment.id);
    await check('PATCH /admin/novels/:id/comments/:cid', 'PATCH', `/api/v1/admin/novels/${nid}/comments/${comment.comment.id}`, CommentResponseSchema, { token: admin, body: { status: 'hidden' } });
    await check('DELETE /novels/:id/comments/:cid', 'DELETE', `/api/v1/novels/${nid}/comments/${comment.comment.id}`, OkResponseSchema, { token: admin });

    // 社区：积分与榜单
    await check('GET /me/points', 'GET', '/api/v1/me/points', MyPointsResponseSchema, { token: author });
    await check('GET /leaderboard (authors)', 'GET', '/api/v1/leaderboard?board=authors&period=week', LeaderboardResponseSchema);
    await check('GET /leaderboard (novels)', 'GET', '/api/v1/leaderboard?board=novels&period=all', LeaderboardResponseSchema);

    // admin
    await check('GET /admin/reports', 'GET', '/api/v1/admin/reports', ReportListResponseSchema, { token: admin });
    await check('PATCH /admin/reports/:id', 'PATCH', `/api/v1/admin/reports/${report.report.id}`, ReportResponseSchema, { token: admin, body: { status: 'resolved' } });
    await check('PATCH /admin/novels/:id/moderation', 'PATCH', `/api/v1/admin/novels/${nid}/moderation`, NovelResponseSchema, { token: admin, body: { moderationStatus: 'ok' } });

    // novel delete
    await check('DELETE /novels/:id', 'DELETE', `/api/v1/novels/${deriv.novel.id}`, OkResponseSchema, { token: b });

    // error envelopes across the codes
    await checkError('401', 'GET', '/api/v1/auth/me');
    await checkError('403', 'PATCH', `/api/v1/novels/${nid}`, { token: b, body: { title: 'x' } });
    await checkError('404', 'GET', '/api/v1/novels/nope');
    await checkError('400 validation', 'POST', '/api/v1/novels', { token: author, body: { title: '' } });
    await checkError('400 json', 'POST', '/api/v1/novels', { token: author, raw: '{' });
    await checkError('409 email', 'POST', '/api/v1/auth/register', { body: { email: 'a@example.com', password: 'password123', displayName: 'x' } });
    await checkError('401 creds', 'POST', '/api/v1/auth/login', { body: { email: 'a@example.com', password: 'nope-nope' } });
    // fork 现在是幂等的，要真正拿到 403 得先关掉二创授权。
    await t.json('PATCH', `/api/v1/novels/${nid}`, { token: author, body: { allowDerivatives: false } });
    await checkError('403 derivatives', 'POST', `/api/v1/novels/${nid}/forks`, { token: b, body: {} });
    await checkError('404 route', 'GET', '/api/v1/does/not/exist');

    expect(covered.length).toBeGreaterThanOrEqual(85);
  });
});
