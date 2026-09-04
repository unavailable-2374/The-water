/**
 * 管理员显式授予 CLI（P0-3）。邮箱抢注不再自动提权，管理员只能在这里或
 * 「邮箱已验证 + 邮箱在 ADMIN_EMAILS 里」两种方式下产生。
 *
 * 用法：
 *   bun run admin:grant <email> [--verify]   授予管理员（--verify 顺带把邮箱标记为已验证，用于引导第一个管理员）
 *   bun run admin:revoke <email>             撤销管理员
 *   bun run admin:list                       列出当前全部管理员
 */
import { eq } from 'drizzle-orm';
import { createDb } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { users } from '../src/db/schema';
import { loadEnv } from '../src/env';

const [cmd, ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter((a) => a.startsWith('--')));
const email = rest.find((a) => !a.startsWith('--'))?.trim().toLowerCase();

const env = loadEnv();
const { db } = createDb(env.databaseUrl);
runMigrations(db);

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function findUser(mail: string) {
  const row = db.select().from(users).where(eq(users.email, mail)).get();
  if (!row) fail(`没有找到邮箱为 ${mail} 的账号`);
  if (row.deletedAt !== null) fail(`账号 ${mail} 已注销，不能授予权限`);
  return row;
}

switch (cmd) {
  case 'grant': {
    if (!email) fail('用法：bun run admin:grant <email> [--verify]');
    const row = findUser(email);
    const now = new Date();
    const verified = row.emailVerifiedAt !== null || flags.has('--verify');
    if (!verified) fail(`账号 ${email} 的邮箱还没验证。请先完成邮箱验证，或加 --verify 直接标记为已验证。`);
    db.update(users)
      .set({ role: 'admin', emailVerifiedAt: row.emailVerifiedAt ?? now, updatedAt: now })
      .where(eq(users.id, row.id))
      .run();
    console.log(`已授予管理员：${email}（${row.displayName}）`);
    if (env.adminEmails.length && !env.adminEmails.includes(email)) {
      console.warn(`注意：ADMIN_EMAILS 非空且不含 ${email}，该账号下次登录会被自动降级。请把它加进 ADMIN_EMAILS，或清空 ADMIN_EMAILS 改为只用本 CLI 授权。`);
    }
    break;
  }
  case 'revoke': {
    if (!email) fail('用法：bun run admin:revoke <email>');
    const row = findUser(email);
    db.update(users).set({ role: 'user', updatedAt: new Date() }).where(eq(users.id, row.id)).run();
    console.log(`已撤销管理员：${email}（${row.displayName}）`);
    if (env.adminEmails.includes(email)) {
      console.warn(`注意：${email} 仍在 ADMIN_EMAILS 中，下次登录会被重新提权。请先把它从 ADMIN_EMAILS 移除。`);
    }
    break;
  }
  case 'list': {
    const rows = db
      .select({ email: users.email, handle: users.handle, displayName: users.displayName, verifiedAt: users.emailVerifiedAt })
      .from(users)
      .where(eq(users.role, 'admin'))
      .all()
      .filter((u) => !u.email.startsWith('deleted+'));
    if (!rows.length) {
      console.log('当前没有管理员。用 bun run admin:grant <email> --verify 授予第一个。');
      break;
    }
    console.log(`共 ${rows.length} 位管理员：`);
    for (const u of rows) {
      console.log(`  ${u.email}  @${u.handle}  ${u.displayName}  邮箱验证：${u.verifiedAt ? u.verifiedAt.toISOString() : '未验证'}`);
    }
    break;
  }
  default:
    fail('用法：bun run admin:grant <email> [--verify] / admin:revoke <email> / admin:list');
}
