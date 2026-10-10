/**
 * Typed REST client for the public-area server (apps/server). Every response is validated
 * against the shared zod contract; non-2xx bodies become `ApiError`s carrying the server's
 * error envelope. Uses the Tauri HTTP plugin so requests are not subject to WebView CORS.
 */
import { fetch } from '@tauri-apps/plugin-http';
import { detachAbortAfterHeaders } from '@/llm/timeout';
import { z } from 'zod';
import { HarnessCapabilitiesSchema, HarnessPageSchema, HarnessTaskSchema, type HarnessRequest } from '@the-water/shared';
import {
  ApiErrorSchema,
  AccountExportResponseSchema,
  AuthResponseSchema,
  BlockResponseSchema,
  CommentListResponseSchema,
  CommentResponseSchema,
  FoldedFeedResponseSchema,
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
  LikeResponseSchema,
  LineageResponseSchema,
  MeResponseSchema,
  NovelBundleSchema,
  NovelListResponseSchema,
  NovelResponseSchema,
  OkResponseSchema,
  ReportResponseSchema,
  SessionListResponseSchema,
  StorylineResponseSchema,
  UploadBlobsResponseSchema,
  VersionListResponseSchema,
  VersionStatusResponseSchema,
  ViewResponseSchema,
  type BrowseQuery,
  type CreateCommentRequest,
  type CreateNovelRequest,
  type FeedQuery,
  type LeaderboardQuery,
  type ChangePasswordRequest,
  type DeleteAccountRequest,
  type UpdateProfileRequestSchema,
  type UserNovelsQuery,
  type CreateReportRequestSchema,
  type CreateVersionRequest,
  type ErrorCode,
  type MarkNotificationsReadRequest,
  type NotificationQuery,
  type UpdateCommentRequest,
  type UpdateNovelRequest,
  type UploadBlobsRequest,
  HealthResponseSchema,
  type HealthResponse,
  AttributionResponseSchema,
  BookmarkListResponseSchema,
  BookmarkResponseSchema,
  PopularTagsResponseSchema,
  ReadingProgressListResponseSchema,
  ReadingProgressResponseSchema,
  SetCurrentVersionResponseSchema,
  TagListResponseSchema,
  type TagDirectoryQuery,
} from '@the-water/shared';

export const API_PREFIX = '/api/v1';

export type ApiErrorCode = ErrorCode | 'NETWORK' | 'BAD_RESPONSE';

export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly status: number,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
  /** Network failure / 5xx / 429 — worth retrying. */
  get retryable(): boolean {
    return this.code === 'NETWORK' || this.code === 'RATE_LIMITED' || this.status >= 500;
  }
}

export function describeError(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
type QueryValue = string | number | boolean | null | undefined;
export type Query = Record<string, QueryValue>;

interface RequestOptions<S extends z.ZodType> {
  signal?: AbortSignal;
  body?: unknown;
  query?: Query;
  headers?: Record<string, string>;
  schema: S;
}

export type TokenProvider = () => Promise<string | null>;

export function normalizeServerUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/**
 * 连通性探测：只打只读的 /api/v1/health，不需要登录，也不写任何本地状态。
 * 返回服务名与版本，好让用户确认自己连的是 The Water 服务而不是随便一个 200。
 */
export async function checkServer(baseUrl: string): Promise<HealthResponse> {
  const url = new URL(API_PREFIX + '/health', normalizeServerUrl(baseUrl) + '/');
  let res: Response;
  try {
    res = await fetch(url.toString(), { method: 'GET', headers: { Accept: 'application/json' } });
  } catch (e) {
    throw new Error(`连不上这个地址：${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) throw new Error(`服务器返回 ${res.status}，这可能不是 The Water 的服务地址`);
  const parsed = HealthResponseSchema.safeParse(await res.json().catch(() => null));
  if (!parsed.success) throw new Error('响应不是 The Water 的健康检查格式，请确认地址填对了');
  return parsed.data;
}

// The plugin releases the request RID when headers arrive. Forward cancellation
// only until then; afterwards cancel the live body reader, never the stale RID.
async function responseText(res: Response, signal?: AbortSignal): Promise<string> {
  if (!signal) return res.text();
  if (signal.aborted) {
    await res.body?.cancel().catch(() => undefined);
    throw new DOMException('Request aborted', 'AbortError');
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const onAbort = () => {
    rejectAbort(new DOMException('Request aborted', 'AbortError'));
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  const decoder = new TextDecoder();
  let text = '';
  try {
    for (;;) {
      const chunk = await Promise.race([reader.read(), aborted]);
      if (chunk.done) return text + decoder.decode();
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}

export class PublicApi {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  constructor(
    baseUrl: string,
    private readonly getToken: TokenProvider,
    private readonly clientId: string,
    fetchImpl: typeof fetch = fetch,
  ) {
    this.baseUrl = normalizeServerUrl(baseUrl);
    this.fetchImpl = detachAbortAfterHeaders(fetchImpl) as typeof fetch;
  }

  async request<S extends z.ZodType>(method: Method, path: string, opts: RequestOptions<S>): Promise<z.output<S>> {
    const url = new URL(API_PREFIX + path, this.baseUrl + '/');
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v === undefined || v === null || v === '') continue;
        url.searchParams.set(k, String(v));
      }
    }
    const headers: Record<string, string> = { Accept: 'application/json', ...opts.headers };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.clientId) headers['X-Client-Id'] = this.clientId;
    const token = await this.getToken();
    if (token) headers.Authorization = `Bearer ${token}`;

    let res: Response;
    try {
      res = await this.fetchImpl(url.toString(), {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: opts.signal,
      });
    } catch (e) {
      throw new ApiError('NETWORK', `无法连接服务器：${e instanceof Error ? e.message : String(e)}`, 0);
    }

    let text: string;
    try {
      text = await responseText(res, opts.signal);
    } catch (e) {
      throw new ApiError('NETWORK', `无法读取服务器响应：${e instanceof Error ? e.message : String(e)}`, 0);
    }
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        if (res.ok) throw new ApiError('BAD_RESPONSE', '服务器返回了无法解析的响应', res.status);
      }
    }

    if (!res.ok) {
      const env = ApiErrorSchema.safeParse(json);
      if (env.success) throw new ApiError(env.data.error.code, env.data.error.message, res.status, env.data.error.details);
      throw new ApiError(res.status >= 500 ? 'INTERNAL' : 'BAD_RESPONSE', `请求失败（HTTP ${res.status}）`, res.status);
    }

    const parsed = opts.schema.safeParse(json);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      const where = first ? ` (${first.path.join('.')}: ${first.message})` : '';
      throw new ApiError('BAD_RESPONSE', `服务器响应不符合契约${where}`, res.status);
    }
    return parsed.data as z.output<S>;
  }

  // ---- auth ----
  writingCapabilities(signal?: AbortSignal) { return this.request('GET', '/writing/capabilities', { schema: HarnessCapabilitiesSchema, signal }); }
  createWritingTask(body: HarnessRequest, key: string, signal?: AbortSignal) {
    return this.request('POST', '/writing/tasks', { body, headers: { 'Idempotency-Key': key }, schema: HarnessTaskSchema, signal });
  }
  writingTask(id: string, after = 0, signal?: AbortSignal) {
    return this.request('GET', `/writing/tasks/${enc(id)}`, { query: { after }, schema: HarnessPageSchema, signal });
  }
  cancelWritingTask(id: string, signal?: AbortSignal) {
    return this.request('DELETE', `/writing/tasks/${enc(id)}`, { schema: HarnessTaskSchema, signal });
  }

  register(body: { email: string; password: string; displayName: string; handle?: string; clientLabel?: string }) {
    return this.request('POST', '/auth/register', { body, schema: AuthResponseSchema });
  }
  login(body: { email: string; password: string; clientLabel?: string }) {
    return this.request('POST', '/auth/login', { body, schema: AuthResponseSchema });
  }
  logout() {
    return this.request('POST', '/auth/logout', { schema: OkResponseSchema });
  }
  me() {
    return this.request('GET', '/auth/me', { schema: MeResponseSchema });
  }
  updateProfile(body: z.input<typeof UpdateProfileRequestSchema>) {
    return this.request('PATCH', '/auth/me', { body, schema: MeResponseSchema });
  }

  // ---- 账号生命周期（P0-4）----
  /** 请求发送邮箱验证信（登录态）。 */
  requestEmailVerification() {
    return this.request('POST', '/auth/email/verify/request', { schema: OkResponseSchema });
  }
  /** 用邮件里的验证码完成邮箱验证（无需登录态）。 */
  verifyEmail(token: string) {
    return this.request('POST', '/auth/email/verify', { body: { token }, schema: MeResponseSchema });
  }
  /** 忘记密码：无论邮箱有没有注册过，服务端都返回 202。 */
  forgotPassword(email: string) {
    return this.request('POST', '/auth/password/forgot', { body: { email }, schema: OkResponseSchema });
  }
  /** 用邮件里的验证码重置密码；成功后该账号全部会话失效。 */
  resetPassword(token: string, password: string) {
    return this.request('POST', '/auth/password/reset', { body: { token, password }, schema: OkResponseSchema });
  }
  /** 登录态改密；成功后其它设备被登出，当前设备保留。 */
  changePassword(body: ChangePasswordRequest) {
    return this.request('PATCH', '/auth/password', { body, schema: OkResponseSchema });
  }
  /** 注销账号：作品可选保留为匿名作者或一并下架。 */
  deleteAccount(body: DeleteAccountRequest) {
    return this.request('DELETE', '/auth/me', { body, schema: OkResponseSchema });
  }
  /** 登录设备列表。 */
  listSessions() {
    return this.request('GET', '/auth/sessions', { schema: SessionListResponseSchema });
  }
  /** 注销单台设备。 */
  revokeSession(id: string) {
    return this.request('DELETE', `/auth/sessions/${enc(id)}`, { schema: OkResponseSchema });
  }
  /** 全部设备退出。 */
  revokeAllSessions() {
    return this.request('DELETE', '/auth/sessions', { schema: OkResponseSchema });
  }
  /** 数据导出：个人资料 + 自己全部作品的 bundle。 */
  exportAccount() {
    return this.request('GET', '/auth/me/export', { schema: AccountExportResponseSchema });
  }

  // ---- browse ----
  listNovels(query: Partial<BrowseQuery> = {}) {
    return this.request('GET', '/novels', { query: query as Query, schema: NovelListResponseSchema });
  }
  getNovel(id: string) {
    return this.request('GET', `/novels/${enc(id)}`, { schema: NovelResponseSchema });
  }
  listVersions(id: string) {
    return this.request('GET', `/novels/${enc(id)}/versions`, { schema: VersionListResponseSchema });
  }
  listChapters(id: string, vid = 'current', query: { from?: number; limit?: number } = {}) {
    return this.request('GET', `/novels/${enc(id)}/versions/${enc(vid)}/chapters`, { query, schema: ChapterListResponseSchema });
  }
  getChapter(id: string, vid: string, index: number) {
    return this.request('GET', `/novels/${enc(id)}/versions/${enc(vid)}/chapters/${index}`, { schema: ChapterContentSchema });
  }
  getStoryline(id: string, vid = 'current') {
    return this.request('GET', `/novels/${enc(id)}/versions/${enc(vid)}/storyline`, { schema: StorylineResponseSchema });
  }

  // ---- author ----
  createNovel(body: CreateNovelRequest) {
    return this.request('POST', '/novels', { body, schema: NovelResponseSchema });
  }
  updateNovel(id: string, body: UpdateNovelRequest) {
    return this.request('PATCH', `/novels/${enc(id)}`, { body, schema: NovelResponseSchema });
  }
  deleteNovel(id: string) {
    return this.request('DELETE', `/novels/${enc(id)}`, { schema: OkResponseSchema });
  }
  myNovels(query: { cursor?: string; limit?: number } = {}) {
    return this.request('GET', '/me/novels', { query, schema: NovelListResponseSchema });
  }
  createVersion(id: string, body: CreateVersionRequest, idempotencyKey: string) {
    return this.request('POST', `/novels/${enc(id)}/versions`, {
      body,
      headers: { 'Idempotency-Key': idempotencyKey },
      schema: CreateVersionResponseSchema,
    });
  }
  getVersion(id: string, vid: string) {
    return this.request('GET', `/novels/${enc(id)}/versions/${enc(vid)}`, { schema: VersionStatusResponseSchema });
  }
  abortVersion(id: string, vid: string) {
    return this.request('DELETE', `/novels/${enc(id)}/versions/${enc(vid)}`, { schema: OkResponseSchema });
  }
  uploadBlobs(blobs: UploadBlobsRequest['blobs']) {
    return this.request('POST', '/blobs', { body: { blobs }, schema: UploadBlobsResponseSchema });
  }
  commitVersion(id: string, vid: string) {
    return this.request('POST', `/novels/${enc(id)}/versions/${enc(vid)}/commit`, { schema: CommitVersionResponseSchema });
  }

  // ---- forks / lineage ----
  capabilities() { return this.request('GET', '/capabilities', { schema: z.object({ bundleVersions: z.array(z.number()), storyGraphVersion: z.number().optional(), creationMaterials: z.object({ version: z.number(), blockBytes: z.number(), totalBytes: z.number() }).optional() }) }); }
  createFork(id: string, versionId?: string) {
    return this.request('POST', `/novels/${enc(id)}/forks`, { body: versionId ? { versionId } : {}, schema: ForkResponseSchema });
  }
  getBundle(id: string, vid: string, forkId?: string) {
    return this.request('GET', `/novels/${enc(id)}/versions/${enc(vid)}/bundle`, { query: { forkId, bundleVersion: 2 }, schema: NovelBundleSchema });
  }
  myForks(query: { cursor?: string; limit?: number } = {}) {
    return this.request('GET', '/me/forks', { query, schema: ForkListResponseSchema });
  }
  lineage(id: string) {
    return this.request('GET', `/novels/${enc(id)}/lineage`, { schema: LineageResponseSchema });
  }

  // ---- social ----
  like(id: string) {
    return this.request('PUT', `/novels/${enc(id)}/like`, { schema: LikeResponseSchema });
  }
  unlike(id: string) {
    return this.request('DELETE', `/novels/${enc(id)}/like`, { schema: LikeResponseSchema });
  }
  view(id: string) {
    return this.request('POST', `/novels/${enc(id)}/view`, { schema: ViewResponseSchema });
  }
  report(id: string, body: z.input<typeof CreateReportRequestSchema>) {
    return this.request('POST', `/novels/${enc(id)}/reports`, { body, schema: ReportResponseSchema });
  }

  // ---- 社区：作者与关系 ----
  getUser(id: string) {
    return this.request('GET', `/users/${enc(id)}`, { schema: UserProfileResponseSchema });
  }
  getUserByHandle(handle: string) {
    return this.request('GET', `/users/by-handle/${enc(handle)}`, { schema: UserProfileResponseSchema });
  }
  listUserNovels(id: string, query: Partial<UserNovelsQuery> = {}) {
    return this.request('GET', `/users/${enc(id)}/novels`, { query: query as Query, schema: NovelListResponseSchema });
  }
  follow(id: string) {
    return this.request('PUT', `/users/${enc(id)}/follow`, { schema: FollowResponseSchema });
  }
  unfollow(id: string) {
    return this.request('DELETE', `/users/${enc(id)}/follow`, { schema: FollowResponseSchema });
  }
  block(id: string) {
    return this.request('PUT', `/users/${enc(id)}/block`, { schema: BlockResponseSchema });
  }
  unblock(id: string) {
    return this.request('DELETE', `/users/${enc(id)}/block`, { schema: BlockResponseSchema });
  }
  myFollowing(query: { cursor?: string; limit?: number } = {}) {
    return this.request('GET', '/me/following', { query, schema: UserListResponseSchema });
  }
  myFollowers(query: { cursor?: string; limit?: number } = {}) {
    return this.request('GET', '/me/followers', { query, schema: UserListResponseSchema });
  }
  myBlocks(query: { cursor?: string; limit?: number } = {}) {
    return this.request('GET', '/me/blocks', { query, schema: UserListResponseSchema });
  }

  // ---- 社区：动态、留言 ----
  /** 折叠版动态：zod 会剥掉 schema 里没有的字段，用旧的 FeedResponseSchema 会丢掉 collapsedCount 与 read。 */
  // ---- §3.2 版本回滚 ----
  setCurrentVersion(id: string, versionId: string) {
    return this.request('PUT', `/novels/${enc(id)}/current-version`, { body: { versionId }, schema: SetCurrentVersionResponseSchema });
  }

  // ---- §3.4 标签目录、用户搜索、想读、阅读进度 ----
  listTags(query: Partial<TagDirectoryQuery> = {}) {
    return this.request('GET', '/tags', { query: query as Query, schema: TagListResponseSchema });
  }
  popularTags(limit = 20) {
    return this.request('GET', '/tags/popular', { query: { limit }, schema: PopularTagsResponseSchema });
  }
  searchUsers(query: { q: string; cursor?: string; limit?: number }) {
    return this.request('GET', '/users', { query, schema: UserListResponseSchema });
  }
  isBookmarked(id: string) {
    return this.request('GET', `/novels/${enc(id)}/bookmark`, { schema: BookmarkResponseSchema });
  }
  bookmark(id: string) {
    return this.request('PUT', `/novels/${enc(id)}/bookmark`, { schema: BookmarkResponseSchema });
  }
  unbookmark(id: string) {
    return this.request('DELETE', `/novels/${enc(id)}/bookmark`, { schema: BookmarkResponseSchema });
  }
  myBookmarks(query: { cursor?: string; limit?: number } = {}) {
    return this.request('GET', '/me/bookmarks', { query, schema: BookmarkListResponseSchema });
  }
  getProgress(id: string) {
    return this.request('GET', `/novels/${enc(id)}/progress`, { schema: ReadingProgressResponseSchema });
  }
  saveProgress(id: string, body: { chapterIndex: number; percent?: number }) {
    return this.request('PUT', `/novels/${enc(id)}/progress`, { body, schema: ReadingProgressResponseSchema });
  }
  myProgress(query: { cursor?: string; limit?: number } = {}) {
    return this.request('GET', '/me/progress', { query, schema: ReadingProgressListResponseSchema });
  }
  attribution(id: string) {
    return this.request('GET', `/novels/${enc(id)}/attribution`, { schema: AttributionResponseSchema });
  }

  feed(query: Partial<FeedQuery> = {}) {
    return this.request('GET', '/feed', { query: query as Query, schema: FoldedFeedResponseSchema });
  }
  /** chapter：数字=只看该章，'novel'=只看作品级，缺省=全部。 */
  listComments(novelId: string, query: { cursor?: string; limit?: number; chapter?: number | 'novel' } = {}) {
    return this.request('GET', `/novels/${enc(novelId)}/comments`, { query, schema: CommentListResponseSchema });
  }
  listReplies(novelId: string, commentId: string, query: { cursor?: string; limit?: number } = {}) {
    return this.request('GET', `/novels/${enc(novelId)}/comments/${enc(commentId)}/replies`, { query, schema: CommentListResponseSchema });
  }
  createComment(novelId: string, body: CreateCommentRequest) {
    return this.request('POST', `/novels/${enc(novelId)}/comments`, { body, schema: CommentResponseSchema });
  }
  /** 编辑留言：只在服务端的 15 分钟窗口内可用，超时返回 403。 */
  updateComment(novelId: string, commentId: string, body: UpdateCommentRequest) {
    return this.request('PATCH', `/novels/${enc(novelId)}/comments/${enc(commentId)}`, { body, schema: CommentResponseSchema });
  }
  likeComment(novelId: string, commentId: string, liked: boolean) {
    return this.request(liked ? 'PUT' : 'DELETE', `/novels/${enc(novelId)}/comments/${enc(commentId)}/like`, {
      schema: LikeResponseSchema,
    });
  }
  deleteComment(novelId: string, commentId: string) {
    return this.request('DELETE', `/novels/${enc(novelId)}/comments/${enc(commentId)}`, { schema: OkResponseSchema });
  }
  reportComment(novelId: string, commentId: string, body: z.input<typeof CreateReportRequestSchema>) {
    return this.request('POST', `/novels/${enc(novelId)}/comments/${enc(commentId)}/reports`, { body, schema: ReportResponseSchema });
  }

  // ---- 社区：站内通知（§3.1）----
  listNotifications(query: Partial<NotificationQuery> = {}) {
    return this.request('GET', '/me/notifications', { query: query as Query, schema: NotificationListResponseSchema });
  }
  /** 小红点专用：只回一个数字，可以高频轮询。 */
  unreadNotificationCount() {
    return this.request('GET', '/me/notifications/unread-count', { schema: UnreadCountResponseSchema });
  }
  markNotificationsRead(body: MarkNotificationsReadRequest) {
    return this.request('POST', '/me/notifications/read', { body, schema: MarkNotificationsReadResponseSchema });
  }

  // ---- 社区：积分与榜单 ----
  myPoints(query: { cursor?: string; limit?: number } = {}) {
    return this.request('GET', '/me/points', { query, schema: MyPointsResponseSchema });
  }
  leaderboard(query: Partial<LeaderboardQuery> = {}) {
    return this.request('GET', '/leaderboard', { query: query as Query, schema: LeaderboardResponseSchema });
  }
}

function enc(s: string): string {
  return encodeURIComponent(s);
}
