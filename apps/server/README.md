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
| `ADMIN_EMAILS` | 空 | 逗号分隔；注册/登录时匹配的邮箱自动获得 `admin` 角色 |
| `PUBLIC_BASE_URL` | 空 | 写入 bundle 的 `server.baseUrl` |

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
| GET / PATCH | `/auth/me` | 登录 | `MeResponse`（PATCH 体 `UpdateProfileRequest`） |
| POST | `/novels` | 登录 | 创建小说，体 `CreateNovelRequest`（可带 `source.forkId` 创建二创），`NovelResponse`（201）。首次提交前 `visibility=unpublished` |
| GET | `/me/novels` | 登录 | 我的小说，`NovelListResponse` |
| GET | `/novels` | — | 浏览，查询 `BrowseQuery`（sort / q / tag / license / writingStatus / allowDerivatives / originalsOnly / cursor / limit），`NovelListResponse` |
| GET / PATCH / DELETE | `/novels/:id` | PATCH/DELETE 作者 | `NovelResponse`；DELETE 为软删除，`OkResponse` |
| POST | `/novels/:id/versions` | 作者 | 头 `Idempotency-Key`（必填），体 `CreateVersionRequest`，返回 `CreateVersionResponse`（新草稿 201，同 key 重放 200 并附最新 `missingHashes`） |
| GET | `/novels/:id/versions` | — | `VersionListResponse`（作者可见草稿） |
| GET | `/novels/:id/versions/:vid` | — | `VersionStatusResponse`（草稿对作者附 `missingHashes`） |
| DELETE | `/novels/:id/versions/:vid` | 作者 | 中止草稿，`OkResponse`；已提交版本不可删 |
| POST | `/novels/:id/versions/:vid/commit` | 作者 | 提交：blob 不齐 → 409 `BLOBS_MISSING`（`details.missingHashes`）；已提交则幂等返回；`CommitVersionResponse` |
| POST | `/blobs` | 登录 | 体 `UploadBlobsRequest`（≤20 个），服务端归一化后重算 sha256，不匹配进 `rejected`；`UploadBlobsResponse` |
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
| PATCH | `/admin/novels/:id/moderation` | 管理员 | 体 `ModerationUpdate`，`NovelResponse` |

网页阅读（`text/html`，严格 CSP，零 JS）：`GET /`（最新 20 本）、`GET /n/:id`（详情、目录、“改编自 X 第 vN 版”）、`GET /n/:id/c/:index`（正文、上下章、服务端计浏览）。

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
