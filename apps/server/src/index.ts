import { createApp } from './app';
import type { AppDeps } from './context';
import { createDb } from './db/client';
import { syncNovelsFtsIfPending } from './db/fts';
import { runMigrations } from './db/migrate';
import { loadEnv } from './env';
import { gcCache } from './lib/cache';
import { createMailer } from './lib/mailer';
import { createModerator } from './lib/moderation';
import { HOUR, systemClock } from './lib/time';
import { gcRateLimits } from './middleware/rate-limit';
import { gcSessions } from './modules/auth/service';
import { gcBlobs, gcDrafts } from './modules/versions/service';

const env = loadEnv();
const { db } = createDb(env.databaseUrl);
runMigrations(db);

const deps: AppDeps = {
  db,
  env,
  clock: systemClock,
  moderator: createModerator(env),
  mailer: createMailer(env),
  rateLimits: {},
};
const app = createApp(deps);

function runGc(): void {
  try {
    // 顺序要紧：先清过期草稿，草稿行还在时它的 manifest 仍算 blob 引用。
    const drafts = gcDrafts(deps);
    const sessions = gcSessions(deps);
    const orphanBlobs = gcBlobs(deps);
    // 共享限流计数与共享缓存都是「只增不减就会变成垃圾表」的东西，跟着这轮一起清。
    const rlRows = gcRateLimits(deps.db, deps.clock.now().getTime());
    const cacheRows = gcCache(deps);
    // 兜底排空 FTS 队列：搜索请求会自己排空，但没人搜索时队列也不该一直挂着。
    const ftsRows = syncNovelsFtsIfPending(deps.db);
    if (drafts || sessions || orphanBlobs || rlRows || cacheRows || ftsRows) {
      console.log(
        `[gc] 清理草稿 ${drafts} 个，过期会话 ${sessions} 个，孤儿 blob ${orphanBlobs} 个，` +
          `限流计数 ${rlRows} 行，过期缓存 ${cacheRows} 行，重建检索索引 ${ftsRows} 条`,
      );
    }
  } catch (e) {
    console.error('[gc] 失败:', e);
  }
}
runGc();
const gcTimer = setInterval(runGc, HOUR);

const server = Bun.serve({ port: env.port, fetch: app.fetch, maxRequestBodySize: 8 * 1024 * 1024 });
console.log(`The-Water 公共区服务已启动：http://localhost:${server.port}  (DB: ${env.databaseUrl})`);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    clearInterval(gcTimer);
    server.stop();
    process.exit(0);
  });
}
