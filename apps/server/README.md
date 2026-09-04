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
| `TRUST_PROXY` | 0 | 为 1 时才看 `X-Forwarded-For`。**必须同时配 `TRUSTED_PROXIES`**，否则退化成「无条件采信」的旧行为（不推荐） |
| `EXTRA_ORIGINS` | 空 | 逗号分隔的额外 CORS 来源；默认已允许 `tauri://localhost`、`http://tauri.localhost`、`http://localhost:1420` |
| `ADMIN_EMAILS` | 空 | 逗号分隔的管理员名单。**仅当邮箱已验证时才生效**（P0-3）；名单为空时完全不动 `role`，授权交给 `bun run admin:grant` |
| `PUBLIC_BASE_URL` | 空 | 写入 bundle 的 `server.baseUrl` |
| `TRUSTED_PROXIES` | 空 | 可信代理 IP / CIDR 列表（IPv4 / IPv6 均可，逗号分隔）。直连来源命中名单才采信 XFF，并从右往左取第一个不在名单里的一跳 |
| `MAIL_TRANSPORT` | `console` | 邮件出口：`console` 只打印（开发）、`smtp`（nodemailer）、`resend` |
| `MAIL_FROM` | `The Water <no-reply@localhost>` | 发件人 |
| `SMTP_URL` | 空 | `MAIL_TRANSPORT=smtp` 必填，形如 `smtps://user:pass@smtp.example.com:465` |
| `RESEND_API_KEY` | 空 | `MAIL_TRANSPORT=resend` 必填 |
| `MODERATION_MODE` | `rules` | `off` 关闭审核（仅测试）、`rules` 本地规则引擎 |
| `MODERATION_BLOCKLIST_PATH` | 空 | 追加违禁词表文件（每行一条，`#` 注释）。**生产必须按当地法规维护此表，内置种子表只是兜底** |
| `STORAGE_QUOTA_BYTES` | 200MB | 每用户 blob 存储配额，0 表示不限 |
| `BACKUP_DIR` | `./data/backups` | `bun run db:backup` 的输出目录，见 [BACKUP.md](./BACKUP.md) |
| `DOWNLOAD_URL` | 空 | 桌面端安装包下载地址，网页 CTA 用；留空时 `/download` 明说未配置 |
| `LOG_FORMAT` | `text` | 请求日志格式：`off` 不打、`text` 人读、`json` 一行 JSON（给日志采集器） |
| `METRICS_ENABLED` | 1 | `GET /metrics` 开关（Prometheus 文本格式） |
| `METRICS_TOKEN` | 空 | 非空时 `/metrics` 需要 `Authorization: Bearer <token>` 或 `?token=` |
| `ERROR_REPORTING` | `log` | 错误上报：`off` 不报、`log` 结构化打印、`sentry` 走注册的上报出口 |
| `SENTRY_DSN` | 空 | Sentry DSN。**服务端不内置 SDK**，见下方「错误上报」 |
| `SENTRY_ENVIRONMENT` | `production` | 上报时带的环境名 |

## 目录

```
src/index.ts            加锁迁移 → createApp → Bun.serve → 每小时 GC（草稿 / 会话 / blob / 限流计数 / 缓存 / 检索队列）
src/app.ts              组合根（测试也用）：request-id、请求日志与指标、client-id、CORS、compress、bodyLimit、鉴权、限流、路由
src/db/{schema,client,migrate,seed,search,fts}.ts   search.ts / fts.ts 是允许方言 SQL 的文件；migrate.ts 带迁移锁
src/lib/{errors,ids,tokens,cursor,moderation,time,cache,metrics,net,reporting}.ts
src/middleware/{auth,rate-limit,client-id,error-handler,request-id,validate,observability}.ts
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
- 限流（**共享滑动窗口**，计数落 `rate_limit_counters` 表，多实例共用一份配额）：登录 10/分/IP，注册 5/时/IP，blobs 60/分/用户，GET 300/分/IP。
- 浏览搜索走 FTS5（中文重叠 bigram 切分，见「全文检索」）；FTS5 不可用时自动回退 `LIKE`。

## 端点（前缀 `/api/v1`）

| 方法 | 路径 | 鉴权 | 说明 / 响应 schema |
|---|---|---|---|
| GET | `/health`（也在根路径） | — | `HealthResponse`；DB 探不通时 503 + `ReadinessResponse` |
| GET | `/health/ready`（也在根路径） | — | `ReadinessResponse`（逐项检查明细，就绪探针用） |
| GET | `/metrics`（仅根路径） | 见 `METRICS_TOKEN` | Prometheus 文本格式 |
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
| GET | `/ranking` | — | 榜单（缓存 120s，落 `cache_entries` 表，多实例共享同一份快照） |

网页（`text/html`，严格 CSP，零 JS，整体挂 `web` 读限流）：`GET /`（最新 20 本）、`GET /n/:id`（详情、目录、“改编自 X 第 vN 版”）、`GET /n/:id/c/:index`（正文、上下章、服务端计浏览）、`GET /u/:handle`（作者主页）、`GET /admin`（管理页：举报队列 / 用户封禁 / 操作记录，`?token=` 或 Bearer 鉴权，表单动作 POST 到 `/admin/actions/*`）。

> 管理页的 `?token=` 会进地址栏与访问日志，只适合内网或少量管理员应急使用；正式后台应改为带 cookie 的前端。

## 运维

- **系统依赖**：分享图（og:image）用 `@resvg/resvg-js` 把 SVG 渲染成 PNG，**渲染中文需要系统装有中文字体**。
  Debian / Ubuntu 上 `apt-get install -y fonts-noto-cjk`，Alpine 上 `apk add font-noto-cjk`；
  漏装不会报错，只会渲染出一整排豆腐块。容器镜像里请把这一行写进 Dockerfile。
- **备份与恢复**：`bun run db:backup` / `bun run db:restore`，策略与演练流程见 [BACKUP.md](./BACKUP.md)。
- **管理员授予**：`bun run admin:grant <email>` / `admin:revoke` / `admin:list`。注意 `ADMIN_EMAILS` 非空时它是权威名单，CLI 授予但不在名单里的管理员会在下次登录时被降级。
- **定时 GC**：进程内每小时清理过期草稿、过期会话、孤儿 blob（24 小时宽限期）、过期限流计数、过期缓存，并兜底排空检索队列。
- **迁移加锁**：启动仍会自动迁移，但全程持有 `schema_lock` 单行锁（`BEGIN IMMEDIATE` 保证「检查 + 占位」原子）。
  滚动部署时后启动的实例会等前一个跑完；超过 30s 拿不到锁就报错退出，超过 120s 的陈旧锁视为持有者已崩溃并强抢。
- **健康检查**：`GET /health` 现在会探一次 DB，探不通返回 **503**（此前数据库锁死也返绿）。
  `GET /health/ready` 无论通过与否都返回逐项明细，适合做 readiness 探针；两者在根路径与 `/api/v1` 下各有一份。
- **请求日志**：每个请求一行结构化日志（方法 / 路径 / 路由模板 / 状态码 / 延迟 / requestId / 用户 id / IP），
  格式由 `LOG_FORMAT` 控制（`text` 人读、`json` 给采集器、`off` 关闭）。
- **指标**：`GET /metrics` 输出 Prometheus 文本，含 `http_requests_total`（method / route / status）、
  `http_request_duration_seconds` 直方图、`http_requests_in_flight`、`process_uptime_seconds`。
  route 标签用的是**路由模板**（`/api/v1/novels/:id`），未匹配的路径统一归到 `<unmatched>`，避免指标基数被扫描器打爆。
- **错误上报**：`ERROR_REPORTING=log` 时 5xx 会打一行结构化 JSON；`=sentry` 时走 `setErrorTransport()` 注册的出口。
  **仓库里不含 Sentry SDK**——不需要它的部署不该为它付出依赖。要接的话装 `@sentry/bun` 后在 `index.ts` 里注册一次即可：

  ```ts
  import * as Sentry from '@sentry/bun';
  import { setErrorTransport } from './lib/reporting';
  Sentry.init({ dsn: env.sentryDsn, environment: env.sentryEnvironment });
  setErrorTransport((r) => Sentry.captureException(r.error, { tags: { requestId: r.requestId ?? '' } }));
  ```

## 全文检索

浏览搜索（`GET /novels?q=`）走 FTS5 虚拟表 `novels_fts`，不再用前导通配的 `LIKE '%q%'` 全表扫描。

中文分词是自己做的：SQLite 自带分词器对中文都不可用——`unicode61` 把一整串汉字当成一个词，
`trigram` 要求查询至少 3 个字，中文里最常见的双字词就搜不到。方案是 **unicode61 + 应用层重叠 bigram 切分**
（`src/db/fts.ts`，与桌面端阅读器 `apps/desktop/src/documents/fts.ts` 同一套思路）：

- 入库：「中国人民」→「中国 国人 人民 民」（末字单独补一个 token，保证单字查询能作为前缀命中）；
- 查询：「国人民」→ `"国人 人民"` 短语查询，要求这些 bigram 连续出现，等价子串匹配且避开二元切分常见的假命中。

索引同步分两步，因为触发器写不出 bigram：`novels` 上的三个触发器把变动的 id 写进 `novels_fts_pending` 队列，
应用层在**带 `q` 的请求进来时**排空队列（空队列的代价是一次 `LIMIT 1`），每小时 GC 再兜一次底。
`0004` 迁移会把老库里已有的作品全部排进队列，因此升级后第一次搜索即完成回填。

FTS5 不可用时（构建没编、或索引写入失败）自动回退到转义过的 `LIKE`，语义一致，只是慢。
虚拟表刻意**不在迁移 SQL 里建**：没编 FTS5 的构建上 `CREATE VIRTUAL TABLE` 会让整次迁移失败，
所以由 `ensureFtsSchema()` 在迁移之后 try/catch 建。

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

## 为什么是 SQLite-only

**本服务只支持 SQLite，这是刻意的架构选择，不是待办事项。** 此前这里写着「切换 PostgreSQL 只需替换客户端」，
那句话从来没有成立过：`db/search.ts` 依赖 `json_each`，schema 全部来自 `sqlite-core`，
在线备份是 `VACUUM INTO`，浏览搜索现在还多了一张 FTS5 虚拟表与三个 SQLite 触发器。
留着一句做不到的承诺，比明确说不做更糟。

理由：

- **部署形态就是单文件**。这个产品的云端是「一台机器 + 一个 sqlite 文件 + WAL」，
  备份是复制一个文件，恢复是换回一个文件（见 [BACKUP.md](./BACKUP.md)）。
  上 Postgres 等于给每个自建用户多加一个必须运维的有状态服务。
- **写入模型天然单写者**。内容寻址的 blob 一次写入永不修改，版本提交是短事务，
  最热的写是浏览计数与限流计数——这些在 WAL 模式下的单写者串行化里完全不构成瓶颈。
- **真正贵的东西不在数据库里**。章节正文按 hash 去重存 blob，客户端本地已有的内容不会重复上传。
- **迁移成本会随功能增长**。FTS5 之后再想迁移，等于连中文分词方案一起重写。

**规模上限（超过这些就该重新评估，而不是硬扛）**：

| 维度 | 舒适区 | 说明 |
|---|---|---|
| 库文件大小 | < 50 GB | `VACUUM INTO` 备份耗时与磁盘余量是先出问题的那一环 |
| 并发写 | < 200 写请求/秒 | 单写者串行；`busy_timeout=5000`，再高就会看到 `SQLITE_BUSY` |
| 并发读 | 几千/秒 | WAL 下读不阻塞写，通常先撞到 CPU 而不是数据库 |
| 实例数 | 共享同一块存储的少数几个 | 限流、缓存、检索索引都已下沉到库里，但 SQLite 不适合跨主机共享 |

**触到上限时的正确做法**不是「换个 driver」，而是：先把 blob 挪到对象存储，再把读扩到只读副本（`litestream` / `LiteFS`），
最后才考虑换库——那时是一次带数据迁移脚本的独立项目，不是改一行客户端。
