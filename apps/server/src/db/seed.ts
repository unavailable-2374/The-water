/**
 * 开发种子：2 个用户（其一为 ADMIN_EMAILS 中的管理员）、3 本小说（其一为二创）、约 12 章确定性中文正文。
 * 用法：bun run db:seed（可重复执行；已存在的账号会复用）。
 */
import { eq } from 'drizzle-orm';
import { countZh, hashChapterContent, emptyStoryline, emptyLore, emptyVoice, type StorylineDoc } from '@the-water/shared';
import { createApp } from '../app';
import type { AppDeps } from '../context';
import { createDb } from './client';
import { runMigrations } from './migrate';
import { loadEnv } from '../env';
import { consoleMailer } from '../lib/mailer';
import { noopModerator } from '../lib/moderation';
import { systemClock } from '../lib/time';
import { users } from './schema';

const env = loadEnv();
const { db } = createDb(env.databaseUrl);
runMigrations(db);
const deps: AppDeps = { db, env, clock: systemClock, moderator: noopModerator, mailer: consoleMailer(), rateLimits: false };
const app = createApp(deps);

const adminEmail = env.adminEmails[0] ?? 'admin@example.com';
if (!env.adminEmails.length) console.warn('ADMIN_EMAILS 为空，种子管理员将以 admin@example.com 注册为普通用户；请在 .env 中设置 ADMIN_EMAILS。');

async function api<T = any>(method: string, path: string, body?: unknown, token?: string, headers: Record<string, string> = {}): Promise<T> {
  const h: Record<string, string> = { ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (token) h['Authorization'] = `Bearer ${token}`;
  const res = await app.request(`/api/v1${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = (await res.json()) as any;
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`);
  return json as T;
}

async function ensureUser(email: string, displayName: string): Promise<string> {
  const password = 'password123';
  const exists = db.select({ id: users.id }).from(users).where(eq(users.email, email)).get();
  const r = exists
    ? await api('POST', '/auth/login', { email, password })
    : await api('POST', '/auth/register', { email, password, displayName });
  console.log(`${exists ? '登录' : '注册'}用户 ${email}（${r.user.role}）`);
  return r.token as string;
}

const SENTENCES = [
  '雪从黄昏开始下，长街尽头的灯火在风里晃了一晃。',
  '林晚把灯芯拨亮，对着窗外说了句谁也听不见的话。',
  '故人的信压在茶盏底下，纸角已经泛黄。',
  '桥下的流水没有结冰，倒映着一盏又一盏归家的灯。',
  '她想起清晨时那只停在梧桐上的鸟，飞走时也没有回头。',
  '剑还在墙上挂着，很久没有人碰过它。',
  '远方传来舟子的号声，一声，两声，便再没有了。',
  '书翻到第三页，字迹忽然变得陌生起来。',
];

function chapterText(seed: number, paragraphs: number): string {
  const out: string[] = [];
  for (let i = 0; i < paragraphs; i++) {
    const a = SENTENCES[(seed * 3 + i) % SENTENCES.length]!;
    const b = SENTENCES[(seed * 5 + i * 2 + 1) % SENTENCES.length]!;
    const c = SENTENCES[(seed + i * 7 + 3) % SENTENCES.length]!;
    out.push(a + b + c);
  }
  return out.join('\n\n');
}

function storyline(premise: string, chapterCount: number): StorylineDoc {
  return {
    ...emptyStoryline(),
    premise,
    themes: ['离别', '归途', '守望'],
    characters: [
      { id: 'c1', name: '林晚', aliases: ['晚晚'], role: '主角', description: '长街尽头的守灯人。', arc: '从守望到远行。', relationships: [{ targetId: 'c2', kind: '旧友', note: '多年未见' }], ...emptyVoice() },
      { id: 'c2', name: '故人', aliases: [], role: '配角', description: '只在信里出现的人。', arc: '', relationships: [], ...emptyVoice() },
    ],
    settings: [{ id: 's1', name: '长街', kind: 'location', description: '雪夜的长街，尽头有一盏灯。', ...emptyLore() }],
    arcs: [{ id: 'a1', title: '守灯', summary: '林晚守着灯等一个不会回来的人。', startChapterNo: 1, endChapterNo: chapterCount }],
    beats: [{ id: 'b1', arcId: 'a1', title: '来信', summary: '一封迟到多年的信。', chapterNo: 1, characterIds: ['c1', 'c2'], settingIds: ['s1'], order: 0 }],
    chapters: Array.from({ length: chapterCount }, (_, i) => ({
      chapterNo: i + 1,
      title: `第${i + 1}章`,
      goal: '',
      beatIds: i === 0 ? ['b1'] : [],
      povCharacterId: 'c1',
      targetChars: 300,
      endHook: '',
    })),
  };
}

async function publishNovel(token: string, novelId: string, premise: string, chapters: Array<{ title: string; content: string }>, key: string) {
  const manifest = await Promise.all(
    chapters.map(async (c, index) => ({ index, title: c.title, hash: await hashChapterContent(c.content), charCount: countZh(c.content) })),
  );
  const draft = await api('POST', `/novels/${novelId}/versions`, { storyline: storyline(premise, chapters.length), bible: null, chapters: manifest }, token, {
    'Idempotency-Key': key,
  });
  const missing = new Set<string>(draft.missingHashes);
  const blobs = manifest.filter((m) => missing.has(m.hash)).map((m) => ({ hash: m.hash, content: chapters[m.index]!.content }));
  for (let i = 0; i < blobs.length; i += 20) await api('POST', '/blobs', { blobs: blobs.slice(i, i + 20) }, token);
  const commit = await api('POST', `/novels/${novelId}/versions/${draft.version.id}/commit`, undefined, token);
  console.log(`  发布《${commit.novel.title}》v${commit.version.versionNumber}：${commit.version.chapterCount} 章 / ${commit.version.charCount} 字`);
  return commit.novel;
}

const adminToken = await ensureUser(adminEmail, '管理员');
// P0-3：ADMIN_EMAILS 提权要求邮箱已验证，种子里直接置位并提权。
db.update(users).set({ emailVerifiedAt: new Date(), role: 'admin' }).where(eq(users.email, adminEmail)).run();
const writerToken = await ensureUser('writer@example.com', '守灯人');
const readerToken = await ensureUser('reader@example.com', '夜读人');

const mine = await api('GET', '/me/novels', undefined, writerToken);
if (mine.items.length) {
  console.log(`writer@example.com 已有 ${mine.items.length} 本小说，跳过创建。`);
} else {
  const n1 = await api('POST', '/novels', {
    title: '灯下长街',
    summary: '雪夜的长街尽头有一盏灯，守灯的人等一封迟到多年的信。',
    tags: ['言情', '短篇'],
    license: 'cc-by-sa',
    allowDerivatives: true,
  }, writerToken);
  await publishNovel(writerToken, n1.novel.id, '守灯人与迟到的信', Array.from({ length: 6 }, (_, i) => ({ title: `第${i + 1}章 ${['雪', '灯', '信', '桥', '鸟', '舟'][i]}`, content: chapterText(i + 1, 3) })), 'seed-n1-v1');

  const n2 = await api('POST', '/novels', {
    title: '桥下流水',
    summary: '一把挂在墙上的剑，和一个不再提起的名字。',
    tags: ['武侠'],
    license: 'all-rights-reserved',
    allowDerivatives: false,
    writingStatus: 'completed',
  }, writerToken);
  await publishNovel(writerToken, n2.novel.id, '剑与名字', Array.from({ length: 3 }, (_, i) => ({ title: `第${i + 1}章`, content: chapterText(i + 10, 4) })), 'seed-n2-v1');

  // 管理员 fork 第一本并发布二创（cc-by-sa 继承）
  const fork = await api('POST', `/novels/${n1.novel.id}/forks`, {}, adminToken);
  const n3 = await api('POST', '/novels', {
    title: '长街新说',
    summary: '如果那封信从未寄出——《灯下长街》的另一种结局。',
    tags: ['言情', '二创'],
    license: 'cc-by-sa',
    allowDerivatives: true,
    source: { forkId: fork.fork.id },
  }, adminToken);
  const bundle = await api('GET', `/novels/${n1.novel.id}/versions/current/bundle?forkId=${fork.fork.id}`, undefined, adminToken);
  const derivChapters = bundle.chapters.map((c: any, i: number) => ({ title: c.title, content: i < 3 ? `${c.content}\n\n（新说：${SENTENCES[(i + 4) % SENTENCES.length]}）` : c.content }));
  await publishNovel(adminToken, n3.novel.id, '如果信从未寄出', derivChapters.slice(0, 3), 'seed-n3-v1');
}
// 社区样例：关注、留言、阅读（阅读同时给作者与原作者记分）。
const writer = await api('GET', '/auth/me', undefined, writerToken);
const reader = await api('GET', '/auth/me', undefined, readerToken);
await api('PUT', `/users/${writer.user.id}/follow`, undefined, readerToken);
await api('PUT', `/users/${(await api('GET', '/auth/me', undefined, adminToken)).user.id}/follow`, undefined, readerToken);

const published = await api('GET', '/me/novels', undefined, writerToken);
for (const n of published.items.slice(0, 2)) {
  await api('POST', `/novels/${n.id}/view`, undefined, readerToken);
  await api('PUT', `/novels/${n.id}/like`, undefined, readerToken);
}
const first = published.items[0];
if (first) {
  const existing = await api(`GET`, `/novels/${first.id}/comments`, undefined, readerToken);
  if (!existing.items.length) {
    const top = await api('POST', `/novels/${first.id}/comments`, { body: '雪夜读完，久久没有合上。' }, readerToken);
    await api('POST', `/novels/${first.id}/comments`, { body: '谢谢你读到最后。', replyToId: top.comment.id }, writerToken);
  }
}
const derivatives = await api('GET', '/me/novels', undefined, adminToken);
for (const n of derivatives.items.filter((x: any) => x.isDerivative).slice(0, 1)) {
  await api('POST', `/novels/${n.id}/view`, undefined, readerToken);
}

const points = await api('GET', '/me/points', undefined, writerToken);
console.log(`守灯人（@${writer.user.handle}）积分 ${points.points}，Lv.${points.level.level} ${points.level.title}；夜读人 @${reader.user.handle}`);
console.log('种子完成。账号密码均为 password123。');
