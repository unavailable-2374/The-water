# apps/server — The-Water 公共区服务

Bun + Hono + Drizzle(bun:sqlite) 实现的云端公共区：作者发布小说（内容寻址、增量上传）、读者浏览/在线阅读、二创 fork 与谱系溯源、点赞/浏览/举报与管理后台，另附零客户端 JS 的网页阅读页。

线上契约（zod schema）全部来自 `packages/shared`，服务端每个响应都能通过对应 schema（见 `test/contract.test.ts`）。

## 开发

```bash
bun install                              # 仓库根目录
cp apps/server/.env.example apps/server/.env
bun run --filter server dev              # bun --watch src/index.ts，默认 http://localhost:8787
bun run --filter server test             # bun test（内存 SQLite）
bun run --filter server typecheck        # tsc --noEmit
bun run --filter server db:generate      # 修改 src/db/schema.ts 后生成迁移到 drizzle/
bun run --filter server db:migrate       # 手动迁移（服务启动时也会自动迁移）
bun run --filter server db:seed          # 种子：2 用户 / 3 本小说（含一本二创）/ 约 12 章
```

环境变量（`.env.example`）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 8787 | 监听端口 |
| `DATABASE_URL` | `./data/dev.sqlite` | SQLite 文件路径（WAL、foreign_keys=ON、busy_timeout=5000） |
| `TRUST_PROXY` | 0 | 为 1 时信任 `X-Forwarded-For` 作为客户端 IP（限流、浏览去重） |
| `EXTRA_ORIGINS` | 空 | 逗号分隔的额外 CORS 来源；默认已允许 `tauri://localhost`、`http://tauri.localhost`、`http://localhost:1420` |
| `ADMIN_EMAILS` | 空 | 逗号分隔的管理员名单。**仅当邮箱已验证时才生效**（P0-3）；名单为空时完全不动 `role`，授权交给 `bun run admin:grant` |
| `PUBLIC_BASE_URL` | 空 | 写入 bundle 的 `server.baseUrl` |
| `TRUSTED_PROXIES` | 空 | 可信代理 IP / CIDR 列表；`TRUST_PROXY=1` 且来源命中才采信 `X-Forwarded-For` |
| `MAIL_TRANSPORT` | `console` | 邮件出口：`console` 只打印（开发）、`smtp`（nodemailer）、`resend` |
| `MAIL_FROM` | `The Water <no-reply@localhost>` | 发件人 |
| `SMTP_URL` | 空 | `MAIL_TRANSPORT=smtp` 必填，形如 `smtps://user:pass@smtp.example.com:465` |
| `RESEND_API_KEY` | 空 | `MAIL_TRANSPORT=resend` 必填 |
| `MODERATION_MODE` | `rules` | `off` 关闭审核（仅测试）、`rules` 本地规则引擎 |
| `MODERATION_BLOCKLIST_PATH` | 空 | 追加违禁词表文件（每行一条，`#` 注释）。**生产必须按当地法规维护此表，内置种子表只是兜底** |
| `STORAGE_QUOTA_BYTES` | 200MB | 每用户 blob 存储配额，0 表示不限 |
| `BACKUP_DIR` | `./data/backups` | `bun run db:backup` 的输出目录，见 [BACKUP.md](./BACKUP.md) |

## 目录

```
src/index.ts            迁移 → createApp → Bun.serve → 每小时 GC（24h 未提交草稿、过期会话）
src/app.ts              组合根（测试也用）：request-id、client-id、CORS、compress、bodyLimit、鉴权、限流、路由
src/db/{schema,client,migrate,seed,search}.ts   search.ts 是唯一允许方言 SQL 的文件
src/lib/{errors,ids,tokens,cursor,moderation,time}.ts
src/middleware/{auth,rate-limit,client-id,error-handler,request-id,validate}.ts
src/modules/{auth,novels,versions,blobs,browse,forks,social,admin}/{routes,service}.ts
src/web/{layout,pages,routes}.tsx               Hono JSX 服务端渲染
test/                   bun test；helpers.ts 提供 makeTestApp()（内存库 + 可推进时钟）
drizzle/                drizzle-kit 生成的迁移，随仓库提交
```

## 约定

- 错误统一为 `{ error: { code, message, details? } }`，状态码见 shared `ERROR_STATUS`；每个响应带 `X-Request-Id`。
- 登录：`Authorization: Bearer tw_<43 字符>`；会话 30 天滑动续期（每小时最多续一次），服务端只存 token 的 sha256。
- 匿名请求可带 `X-Client-Id`（8–64 位 `[A-Za-z0-9_-]`），用于浏览量按访客每日去重；否则退回 IP。
- 列表使用 keyset 游标 `{ items, nextCursor }`；`limit` 1–50，默认 20。
- 路径中 `:vid` 可为 `current`。
- 请求体上限：默认 256KB，`POST /novels/:id/versions` 1.5MB，`POST /blobs` 4MB。
- 限流（内存滑动窗口）：登录 10/分/IP，注册 5/时/IP，blobs 60/分/用户，GET 300/分/IP。

## 端点（前缀 `/api/v1`）

| 方法 | 路径 | 鉴权 | 说明 / 响应 schema |
|---|---|---|---|
| GET | `/health`（也在根路径） | — | `HealthResponse` |
| POST | `/auth/register` | — | `AuthResponse`（201） |
| POST | `/auth/login` | — | `AuthResponse` |
| POST | `/auth/logout` | 登录 | 注销当前会话，`OkResponse` |
| DELETE | `/auth/sessions` | 登录 | 注销全部会话，`OkResponse` |
| GET | `/auth/sessions` | 登录 | 设备列表，当前会话带 `current: true`，`SessionListResponse` |
| DELETE | `/auth/sessions/:id` | 登录 | 注销单个设备，`OkResponse` |
| GET / PATCH | `/auth/me` | 登录 | `MeResponse`（PATCH 体 `UpdateProfileRequest`，昵称 / handle / 简介过审核） |
| DELETE | `/auth/me` | 登录 | 注销账号，体 `{ password, mode: keep_works\|delete_works }`；匿名化而非物理删除 |
| GET | `/auth/me/export` | 登录 | 数据导出（资料 + 全部作品 bundle） |
| POST | `/auth/email/verify/request` | 登录 | 发送验证邮件（202） |
| POST | `/auth/email/verify` | — | 体 `{ token }`，完成邮箱验证，`MeResponse` |
| POST | `/auth/password/forgot` | — | **恒返回 202**，不泄露邮箱是否注册 |
| POST | `/auth/password/reset` | — | 体 `{ token, password }`，成功后吊销该用户全部会话 |
| PATCH | `/auth/password` | 登录 | 体 `{ currentPassword, newPassword }`，吊销其它会话保留当前 |
| POST | `/novels` | 登录 | 创建小说，体 `CreateNovelRequest`（可带 `source.forkId` 创建二创），`NovelResponse`（201）。首次提交前 `visibility=unpublished` |
| GET | `/me/novels` | 登录 | 我的小说，`NovelListResponse` |
| GET | `/novels` | — | 浏览，查询 `BrowseQuery`（sort / q / tag / license / writingStatus / allowDerivatives / originalsOnly / cursor / limit），`NovelListResponse` |
| GET / PATCH / DELETE | `/novels/:id` | PATCH/DELETE 作者 | `NovelResponse`；DELETE 为软删除，`OkResponse` |
| POST | `/novels/:id/versions` | 作者 | 头 `Idempotency-Key`（必填），体 `CreateVersionRequest`，返回 `CreateVersionResponse`（新草稿 201，同 key 重放 200 并附最新 `missingHashes`） |
| GET | `/novels/:id/versions` | — | `VersionListResponse`（作者可见草稿） |
| GET | `/novels/:id/versions/:vid` | — | `VersionStatusResponse`（草稿对作者附 `missingHashes`） |
| DELETE | `/novels/:id/versions/:vid` | 作者 | 中止草稿，`OkResponse`；已提交版本不可删 |
| POST | `/novels/:id/versions/:vid/commit` | 作者 | 提交：blob 不齐 → 409 `BLOBS_MISSING`（`details.missingHashes`）；已提交则幂等返回；`CommitVersionResponse` |
| POST | `/blobs` | 登录 | 体 `UploadBlobsRequest`（≤20 个），服务端归一化后重算 sha256，不匹配进 `rejected`；超配额 413 `STORAGE_QUOTA_EXCEEDED`；`UploadBlobsResponse` |
| GET | `/me/storage` | 登录 | `{ usedBytes, quotaBytes, blobCount }` |
| GET | `/novels/:id/versions/:vid/storyline` | — | `StorylineResponse`（storyline + bible + storylineHash） |
| GET | `/novels/:id/versions/:vid/chapters?from&limit` | — | `ChapterListResponse` |
| GET | `/novels/:id/versions/:vid/chapters/:index` | — | `ChapterContent`（含 prev/next） |
| POST | `/novels/:id/forks` | 登录 | 体 `CreateForkRequest`（可选 `versionId`）；不允许二创 → 403 `DERIVATIVES_NOT_ALLOWED`；`ForkResponse`（201） |
| GET | `/novels/:id/versions/:vid/bundle?forkId=` | forkId 时需本人 | `NovelBundleV1`；超过 200 万字 → 413 |
| GET | `/me/forks` | 登录 | `ForkListResponse` |
| GET | `/novels/:id/lineage` | — | `LineageResponse`：祖先沿 `sourceNovelId` ≤64 跳，后代同根 ≤500 节点建树，不可见节点显示“（已下架）” |
| PUT / DELETE | `/novels/:id/like` | 登录 | `LikeResponse` |
| GET | `/me/likes` | 登录 | `NovelListResponse` |
| POST | `/novels/:id/view` | — | 每访客每日去重，`ViewResponse` |
| POST | `/novels/:id/reports` | — | 体 `CreateReportRequest`，`ReportResponse`（201） |
| GET | `/admin/reports?status&cursor&limit` | 管理员 | `ReportListResponse` |
| PATCH | `/admin/reports/:id` | 管理员 | 体 `{ status: resolved\|dismissed, note? }`，`ReportResponse` |
| PATCH | `/admin/novels/:id/moderation` | 管理员 | 体 `ModerationUpdate`，`NovelResponse`；每次动作写 `moderation_events` |
| GET | `/admin/users?q&status&cursor&limit` | 管理员 | 用户搜索 + 状态筛选，`AdminUserListResponse` |
| POST | `/admin/users/:id/ban` | 管理员 | 体 `{ reason, until? }`；`until` 为空 = 永久封禁，有值 = 限期禁言 |
| POST | `/admin/users/:id/unban` | 管理员 | 解封 |
| GET | `/admin/moderation-events?targetType&targetId&actorId&action&cursor&limit` | 管理员 | 审计日志，时间倒序 |
| POST | `/admin/comments/:id/hide` \| `/restore` | 管理员 | 留言处理 |

社交 / 社区（此前 README 遗漏，§4.7）：

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| PUT / DELETE | `/users/:id/follow` | 登录 | 关注 / 取关 |
| GET | `/users/:id`、`/u/:handle` | — | 作者资料 |
| GET | `/users/:id/followers`、`/following` | — | 关注关系分页 |
| PUT / DELETE | `/users/:id/block` | 登录 | 拉黑 / 取消 |
| GET | `/feed` | 登录 | 关注动态流 |
| GET / POST | `/novels/:id/comments` | POST 需登录 | 两级留言；POST 过审核 |
| DELETE | `/novels/:id/comments/:cid` | 作者或管理员 | 删除留言 |
| POST | `/novels/:id/comments/:cid/reports` | 登录 | 举报留言（去重 + 限流） |
| GET | `/me/points`、`/me/badges` | 登录 | 积分与徽章 |
| GET | `/ranking` | — | 榜单（进程内缓存 120s） |

网页（`text/html`，严格 CSP，零 JS，整体挂 `web` 读限流）：`GET /`（最新 20 本）、`GET /n/:id`（详情、目录、“改编自 X 第 vN 版”）、`GET /n/:id/c/:index`（正文、上下章、服务端计浏览）、`GET /u/:handle`（作者主页）、`GET /admin`（管理页：举报队列 / 用户封禁 / 操作记录，`?token=` 或 Bearer 鉴权，表单动作 POST 到 `/admin/actions/*`）。

> 管理页的 `?token=` 会进地址栏与访问日志，只适合内网或少量管理员应急使用；正式后台应改为带 cookie 的前端。

## 运维

- **备份与恢复**：`bun run db:backup` / `bun run db:restore`，策略与演练流程见 [BACKUP.md](./BACKUP.md)。
- **管理员授予**：`bun run admin:grant <email>` / `admin:revoke` / `admin:list`。注意 `ADMIN_EMAILS` 非空时它是权威名单，CLI 授予但不在名单里的管理员会在下次登录时被降级。
- **定时 GC**：进程内每小时清理过期草稿、过期会话与孤儿 blob（24 小时宽限期）。

## 许可与二创规则

- `all-rights-reserved` 强制 `allowDerivatives=false`（创建与修改时自动覆盖）。
- fork 需要源小说公开、审核通过且 `allowDerivatives=true`；fork 记录即授权证明，作者之后关闭二创不影响已 fork 的用户拉取 bundle 与发布二创。
- `cc-by-sa` / `cc-by-nc-sa` 的二创必须使用与原作相同的许可（创建与修改时校验）。
- 一个 fork 记录只能发布一本二创。
- 谱系字段反规范化在 `novels` 表（`sourceNovelId / sourceVersionId / rootNovelId / depth / forkId`）。

## 发布协议（桌面端）

1. `POST /novels` 得到 `novelId`。
2. 计算全部章节 hash（`hashChapterContent`）与 `storylineHash`，`POST /novels/:id/versions`（带 `Idempotency-Key`）→ `{ version, missingHashes }`。
3. 按 ≤20 个 / ~3MB 一批 `POST /blobs` 上传缺失内容。
4. `POST .../commit`；若 409 `BLOBS_MISSING` 回到第 3 步。
5. 更新时同流程，服务端只索要变化章节的 blob；崩溃后 `GET .../versions/:vid` 续传，或用同一 `Idempotency-Key` 重放第 2 步。

## 切换 PostgreSQL

Schema 仅使用 `text / integer / integer{boolean} / integer{timestamp_ms} / text{json}` 五种列；除 `src/db/search.ts` 外没有方言 SQL。迁移时复制 `schema.ts` 为 pg 版本、替换客户端为 `drizzle-orm/bun-sql` 即可。
