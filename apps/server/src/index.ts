import { createApp } from './app';
import type { AppDeps } from './context';
import { createDb } from './db/client';
import { runMigrations } from './db/migrate';
import { loadEnv } from './env';
import { createMailer } from './lib/mailer';
import { createModerator } from './lib/moderation';
import { HOUR, systemClock } from './lib/time';
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
    if (drafts || sessions || orphanBlobs) {
      console.log(`[gc] 清理草稿 ${drafts} 个，过期会话 ${sessions} 个，孤儿 blob ${orphanBlobs} 个`);
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
