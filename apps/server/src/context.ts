import type { Db } from './db/client';
import type { Env } from './env';
import type { ContentModerator } from './lib/moderation';
import type { Clock } from './lib/time';
import type { UserRow, SessionRow } from './db/schema';

export interface RateLimitRule {
  max: number;
  windowMs: number;
}
export type RateLimitName = 'login' | 'register' | 'blobs' | 'read' | 'comment' | 'social';

export interface AppDeps {
  db: Db;
  env: Env;
  clock: Clock;
  moderator: ContentModerator;
  /** false 表示测试中关闭限流。 */
  rateLimits: Partial<Record<RateLimitName, RateLimitRule>> | false;
}

export interface AuthUser {
  id: string;
  email: string;
  handle: string;
  displayName: string;
  bio: string | null;
  role: 'user' | 'admin';
  createdAt: Date;
}

export type AppVariables = {
  requestId: string;
  user: AuthUser | null;
  session: SessionRow | null;
  /** 匿名访客键：user:<id> / client:<X-Client-Id> / ip:<addr>。 */
  viewerKey: string;
  ip: string;
};

export type AppEnv = { Variables: AppVariables };

export function toAuthUser(row: UserRow): AuthUser {
  return {
    id: row.id,
    email: row.email,
    handle: row.handle,
    displayName: row.displayName,
    bio: row.bio,
    role: row.role,
    createdAt: row.createdAt,
  };
}
