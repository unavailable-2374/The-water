/**
 * Typed REST client for the public-area server (apps/server). Every response is validated
 * against the shared zod contract; non-2xx bodies become `ApiError`s carrying the server's
 * error envelope. Uses the Tauri HTTP plugin so requests are not subject to WebView CORS.
 */
import { fetch } from '@tauri-apps/plugin-http';
import { z } from 'zod';
import {
  ApiErrorSchema,
  AuthResponseSchema,
  BlockResponseSchema,
  CommentListResponseSchema,
  CommentResponseSchema,
  FeedResponseSchema,
  FollowResponseSchema,
  LeaderboardResponseSchema,
  MyPointsResponseSchema,
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
  NovelBundleV1Schema,
  NovelListResponseSchema,
  NovelResponseSchema,
  OkResponseSchema,
  ReportResponseSchema,
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
  type UpdateProfileRequestSchema,
  type UserNovelsQuery,
  type CreateReportRequestSchema,
  type CreateVersionRequest,
  type ErrorCode,
  type UpdateNovelRequest,
  type UploadBlobsRequest,
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
  body?: unknown;
  query?: Query;
  headers?: Record<string, string>;
  schema: S;
}

export type TokenProvider = () => Promise<string | null>;

export function normalizeServerUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

export class PublicApi {
  readonly baseUrl: string;
  constructor(
    baseUrl: string,
    private readonly getToken: TokenProvider,
    private readonly clientId: string,
  ) {
    this.baseUrl = normalizeServerUrl(baseUrl);
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
      res = await fetch(url.toString(), {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });
    } catch (e) {
      throw new ApiError('NETWORK', `无法连接服务器：${e instanceof Error ? e.message : String(e)}`, 0);
    }

    const text = await res.text();
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
  register(body: { email: string; password: string; displayName: string; clientLabel?: string }) {
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
  createFork(id: string, versionId?: string) {
    return this.request('POST', `/novels/${enc(id)}/forks`, { body: versionId ? { versionId } : {}, schema: ForkResponseSchema });
  }
  getBundle(id: string, vid: string, forkId?: string) {
    return this.request('GET', `/novels/${enc(id)}/versions/${enc(vid)}/bundle`, { query: { forkId }, schema: NovelBundleV1Schema });
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
  feed(query: Partial<FeedQuery> = {}) {
    return this.request('GET', '/feed', { query: query as Query, schema: FeedResponseSchema });
  }
  listComments(novelId: string, query: { cursor?: string; limit?: number } = {}) {
    return this.request('GET', `/novels/${enc(novelId)}/comments`, { query, schema: CommentListResponseSchema });
  }
  listReplies(novelId: string, commentId: string, query: { cursor?: string; limit?: number } = {}) {
    return this.request('GET', `/novels/${enc(novelId)}/comments/${enc(commentId)}/replies`, { query, schema: CommentListResponseSchema });
  }
  createComment(novelId: string, body: CreateCommentRequest) {
    return this.request('POST', `/novels/${enc(novelId)}/comments`, { body, schema: CommentResponseSchema });
  }
  deleteComment(novelId: string, commentId: string) {
    return this.request('DELETE', `/novels/${enc(novelId)}/comments/${enc(commentId)}`, { schema: OkResponseSchema });
  }
  reportComment(novelId: string, commentId: string, body: z.input<typeof CreateReportRequestSchema>) {
    return this.request('POST', `/novels/${enc(novelId)}/comments/${enc(commentId)}/reports`, { body, schema: ReportResponseSchema });
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
