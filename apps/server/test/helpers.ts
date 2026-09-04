import { expect } from 'bun:test';
import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import {
  hashChapterContent,
  emptyStoryline,
  type ChapterManifestEntry,
  type CreateNovelRequest,
  type NovelDetail,
  type StorylineDoc,
  type VersionSummary,
  countZh,
  normalizeChapterText, emptyLore, emptyVoice } from '@the-water/shared';
import { createApp } from '../src/app';
import type { AppDeps } from '../src/context';
import { createDb } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { users } from '../src/db/schema';
import { testEnv } from '../src/env';
import { memoryMailer } from '../src/lib/mailer';
import { noopModerator, type ContentModerator } from '../src/lib/moderation';
import { FakeClock } from '../src/lib/time';

export interface RequestOpts {
  body?: unknown;
  token?: string | null;
  headers?: Record<string, string>;
  raw?: string;
}

export interface TestApp {
  app: ReturnType<typeof createApp>;
  deps: AppDeps;
  clock: FakeClock;
  /** 已发出的邮件，供找回密码 / 邮箱验证用例断言。 */
  outbox: ReturnType<typeof memoryMailer>['outbox'];
  request(method: string, path: string, opts?: RequestOpts): Promise<Response>;
  json<T = any>(method: string, path: string, opts?: RequestOpts): Promise<{ status: number; body: T; res: Response }>;
  register(email: string, displayName?: string): Promise<{ token: string; user: { id: string; role: string } }>;
}

export function makeTestApp(
  overrides: Partial<Pick<AppDeps, 'rateLimits' | 'moderator'>> & { moderator?: ContentModerator; env?: Partial<AppDeps['env']> } = {},
): TestApp {
  const { db } = createDb(':memory:');
  runMigrations(db);
  const clock = new FakeClock();
  const mailer = memoryMailer();
  const deps: AppDeps = {
    db,
    env: testEnv(overrides.env),
    clock,
    moderator: overrides.moderator ?? noopModerator,
    mailer,
    rateLimits: overrides.rateLimits ?? false,
  };
  const app = createApp(deps);

  const request: TestApp['request'] = (method, path, opts = {}) => {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
    let body: string | undefined;
    if (opts.raw !== undefined) {
      body = opts.raw;
      headers['Content-Type'] ??= 'application/json';
    } else if (opts.body !== undefined) {
      body = JSON.stringify(opts.body);
      headers['Content-Type'] = 'application/json';
    }
    return Promise.resolve(app.request(path, { method, headers, body }));
  };
  const json: TestApp['json'] = async (method, path, opts) => {
    const res = await request(method, path, opts);
    const text = await res.text();
    let parsed: any = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed, res };
  };
  const register: TestApp['register'] = async (email, displayName = email.split('@')[0]!) => {
    const r = await json('POST', '/api/v1/auth/register', { body: { email, password: 'password123', displayName } });
    if (r.status !== 201) throw new Error(`register failed: ${r.status} ${JSON.stringify(r.body)}`);
    // P0-3 后注册一律是未验证的普通用户。测试账号默认视为已验证邮箱，
    // ADMIN_EMAILS 中的账号直接同步为管理员，省得每个用例都跑一遍验证流程。
    const normalized = email.trim().toLowerCase();
    const isAdmin = deps.env.adminEmails.includes(normalized);
    db.update(users)
      .set({ emailVerifiedAt: clock.now(), ...(isAdmin ? { role: 'admin' as const } : {}) })
      .where(eq(users.id, r.body.user.id))
      .run();
    return { token: r.body.token, user: { ...r.body.user, role: isAdmin ? 'admin' : r.body.user.role } };
  };
  return { app, deps, clock, outbox: mailer.outbox, request, json, register };
}

export function expectSchema<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new Error(`schema mismatch: ${JSON.stringify(r.error.issues.slice(0, 5))}\nvalue: ${JSON.stringify(value).slice(0, 800)}`);
  }
  expect(r.success).toBe(true);
  return r.data;
}

// ---- 确定性中文测试语料 ----

const WORDS = ['山', '河', '风', '雪', '灯', '火', '书', '剑', '茶', '月', '舟', '桥', '梧桐', '流水', '故人', '长街', '清晨', '黄昏', '旧信', '远方'];

/** 生成约 targetChars 字的确定性中文段落（seed 不同则内容不同）。 */
export function zhText(seed: number, targetChars = 600): string {
  const paras: string[] = [];
  let count = 0;
  let x = seed * 7919 + 17;
  while (count < targetChars) {
    let sentence = '';
    for (let i = 0; i < 12; i++) {
      x = (x * 1103515245 + 12345) & 0x7fffffff;
      sentence += WORDS[x % WORDS.length];
      if (i % 4 === 3) sentence += '，';
    }
    sentence += '。';
    paras.push(sentence);
    count += countZh(sentence);
  }
  return paras.join('\n\n');
}

export interface Chapter {
  index: number;
  title: string;
  content: string;
  hash: string;
  charCount: number;
}

export async function makeChapters(count: number, seed = 1, charsEach = 600): Promise<Chapter[]> {
  const out: Chapter[] = [];
  for (let i = 0; i < count; i++) {
    const content = zhText(seed * 1000 + i, charsEach);
    out.push({
      index: i,
      title: `第${i + 1}章 ${WORDS[(seed + i) % WORDS.length]}`,
      content,
      hash: await hashChapterContent(content),
      charCount: countZh(normalizeChapterText(content)),
    });
  }
  return out;
}

export function manifestOf(chs: Chapter[]): ChapterManifestEntry[] {
  return chs.map((c) => ({ index: c.index, title: c.title, hash: c.hash, charCount: c.charCount }));
}

export function sampleStoryline(premise = '一个关于灯火与远方的故事'): StorylineDoc {
  return {
    ...emptyStoryline(),
    premise,
    themes: ['离别', '归途'],
    characters: [{ id: 'c1', name: '林晚', aliases: [], role: '主角', description: '守灯人', arc: '从守望到远行', relationships: [], ...emptyVoice() }],
    settings: [{ id: 's1', name: '长街', kind: 'location', description: '雪夜的长街', ...emptyLore() }],
    arcs: [{ id: 'a1', title: '守灯', summary: '', startChapterNo: 1, endChapterNo: 3 }],
    beats: [],
    chapters: [{ chapterNo: 1, title: '灯', goal: '', beatIds: [], povCharacterId: 'c1', targetChars: 600, endHook: '' }],
  };
}

export const NOVEL_REQ: CreateNovelRequest = {
  title: '灯下长街',
  summary: '雪夜守灯人的故事。',
  tags: ['言情', '短篇'],
  language: 'zh-CN',
  writingStatus: 'ongoing',
  license: 'cc-by-sa',
  allowDerivatives: true,
  visibility: 'public',
};

/** 走完整发布协议：创建草稿 → 上传缺失 blob → 提交。返回 novel 与 version。 */
export async function publish(
  t: TestApp,
  token: string,
  novelId: string,
  chapters: Chapter[],
  opts: { idempotencyKey?: string; storyline?: StorylineDoc; changeNote?: string } = {},
): Promise<{ novel: NovelDetail; version: VersionSummary; uploaded: number }> {
  const key = opts.idempotencyKey ?? `pub-${novelId}-${chapters.length}-${Bun.randomUUIDv7()}`;
  const draft = await t.json('POST', `/api/v1/novels/${novelId}/versions`, {
    token,
    headers: { 'Idempotency-Key': key },
    body: { storyline: opts.storyline ?? sampleStoryline(), bible: null, chapters: manifestOf(chapters), changeNote: opts.changeNote },
  });
  if (draft.status !== 201 && draft.status !== 200) throw new Error(`draft failed ${draft.status} ${JSON.stringify(draft.body)}`);
  const missing: string[] = draft.body.missingHashes;
  const byHash = new Map(chapters.map((c) => [c.hash, c]));
  let uploaded = 0;
  for (let i = 0; i < missing.length; i += 20) {
    const batch = missing.slice(i, i + 20).map((h) => ({ hash: h, content: byHash.get(h)!.content }));
    const up = await t.json('POST', '/api/v1/blobs', { token, body: { blobs: batch } });
    if (up.status !== 200) throw new Error(`blobs failed ${up.status} ${JSON.stringify(up.body)}`);
    uploaded += up.body.accepted.length;
  }
  const commit = await t.json('POST', `/api/v1/novels/${novelId}/versions/${draft.body.version.id}/commit`, { token });
  if (commit.status !== 200) throw new Error(`commit failed ${commit.status} ${JSON.stringify(commit.body)}`);
  return { novel: commit.body.novel, version: commit.body.version, uploaded };
}

export async function createNovel(t: TestApp, token: string, req: Partial<CreateNovelRequest> = {}): Promise<NovelDetail> {
  const r = await t.json('POST', '/api/v1/novels', { token, body: { ...NOVEL_REQ, ...req } });
  if (r.status !== 201) throw new Error(`create novel failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.novel;
}
