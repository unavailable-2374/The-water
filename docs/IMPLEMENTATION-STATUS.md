# 产品优化方案落地追踪

> 对应 `docs/PRODUCT-OPTIMIZATION-PROPOSAL.md` v1.0 的 79 条建议。
> 状态：✅ 已完成 · 🚧 进行中 · ⏸ 待排期 · ❌ 不做（附理由）

本文件由技术侧维护，每完成一批更新一次。基线（开工前）：
`bun run typecheck` 三工作区全过；`bun run test` 363 例全绿（shared 29 / server 74 / desktop 260）。

---

## P0 上线阻断（10 条）

| # | 条目 | 状态 | 落点 |
|---|---|---|---|
| P0-1 | 仓库首提 + CI | ✅ | 首提 `981d040`；`.github/workflows/ci.yml`（typecheck + test + 迁移回放 + macOS 构建）；分支保护步骤见 `.github/workflows/README.md` |
| P0-2 | 内容审核：从空实现到可用 | ✅ | 规则引擎（字符归一化抗绕过 + 内置种子词表 + `MODERATION_BLOCKLIST_PATH` 外挂）已接入生产；审核钩子覆盖 `POST/PATCH /novels`、留言、昵称/简介/handle、版本提交，拦截即写 `auto_reject` 审计 |
| P0-3 | 管理员授予：关闭邮箱抢注提权 | ✅ | 提权改为「邮箱已验证 + 在名单」双条件，登录时升降都做；`admin:grant/revoke/list` CLI（`apps/server/scripts/admin.ts`）|
| P0-4 | 邮件、找回密码、改密、注销 | ✅ | 9 个新端点；令牌只存哈希、一次性、verify 24h / reset 1h；注销走匿名化（保留作品 / 随账号删两种模式）+ 数据导出；桌面端 `AccountSecurity.tsx` 补齐入口 |
| P0-5 | 备份、blob 回收、配额 | ✅ | `VACUUM INTO` 在线备份 + GFS 7日/4周/12月轮转 + 恢复（含旧库连 WAL 留底与失败回滚）+ `BACKUP.md` 演练文档；`gcBlobs` 双来源引用判定 + 24h 宽限期；每用户配额 + `GET /me/storage` |
| P0-6 | 审核后台：管理页、封禁、审计日志 | ✅ | 零 JS 管理页 `/admin`（举报队列 / 用户封禁 / 操作记录）；6 个管理 API；封禁在鉴权中间件生效（非 GET 一律 403），禁言到期自动恢复；12 种审计 action 全部落 `moderation_events` |
| P0-7 | 桌面 LLM 请求超时 | ✅ | 首字节 60s / 流空闲 90s 双计时器（按 SSE 消息粒度计时，避免误杀思考型模型），真 abort 断链，超时归类为可重试 network 错误走既有 `withRetry`；供应商可配 |
| P0-8 | 错误边界、兜底路由、CSP | ✅ | 三层错误边界（根级 / 路由 errorElement / 每页 FeatureBoundary）+「重试 / 复制错误详情」；`*` 兜底 404 路由；CSP 由 `src/app/csp.ts` 单一出处生成并有逐字比对测试。**需人工在 GUI 里跑一遍验证清单，见下** |
| P0-9 | 软删除、回收站、本地备份 | ✅ | 小说与文档软删 + 30 天回收站（可恢复 / 立即永久删）；永久删除改为「先删文件再删行」，文件删失败即中止，不再产生孤儿 PDF；启动时清理过期项与孤儿文件；设置页「备份数据库 / 从备份恢复 / 打开数据目录」 |
| P0-10 | 首启引导 | ✅ | 三步向导（选预设 → 填 Key，附各家申请页链接 → 自动真发一次最小请求测试）；**测试通过才写库**，失败不留脏供应商行；成功后引导「导入 PDF / 写第一本小说」；已有供应商则永不弹 |

---

## P1 核心体验（39 条）

### 2.1 小说生成流水线（10 条） ✅

- **大纲与章节表后台化**：新增 `outlineStep` / `chapterTableStep`；章节表**分批可恢复**（每批结果写回 `job_steps.input.batches`，全部跑完才动数据库，中途中断不留半张表）；已有章节时二次确认并自动落快照，用的正是此前从未被写入过的 `pre_rewrite` 快照类型。
- **按步骤用途分配模型**：6 种用途，优先级为任务参数 > 任务 provider 列 > 全局设置 > registry 默认；建任务时把选择**冻结**进任务参数，跑到一半改设置不会换模型。向导第三步「模型与确认」终于名副其实。
- **用量与费用**：`usage_events` + `model_prices` 两张新表；费用按**记账当时**的价格存快照，改价不改写历史账单；每任务/每本/每月三张卡 + 按用途拆分 + 预算告警 + 开工前费用预估（替换掉 `targetChars*2` 粗估）。
- **续写复用**：以 `partial_text` 为种子，追加 user 说明 + assistant 前缀消息（不动 prompts 目录）；截到句末避免从半句接；挡住「模型又从头写一遍」与「重复结尾」两种情况。
- 单步重试 / 跳过（`attempts` 列终于参与决策，默认 2 次指数退避）、`adjust_length` 每 pass 独立幂等键、任务池与聊天池分离（429 冷却按 providerId 共享，因为配额是按 Key 算的）、context_length 自动降档、JSON 修复轮次可配。

> ⚠️ **内置价格表需要人工核对**：`novel/pricing.ts` 的 16 条默认价格标注了抓取时间 `2026-05`，
> 是各供应商公开定价页的列表价。发版前请按最新定价核对一遍。结构上它们是可改的默认值，不是硬编码事实。
### 2.2 一键改写（5 条） ⏸（第 5 条的费用预估部分已随 §2.1 完成）
### 2.3 写作框架（7 条） 🚧（1 / 7）

第 5 条导出已完成：MD 接上 UI，新增 EPUB 与 DOCX，支持章节范围与元数据（书名 / 作者 / 简介 / 许可）。
其余 6 条（学习层面板、countMode 接线、style_check 轮数可配、阈值常量收敛、提示词可见可改、用户内容分隔声明）待下一批。
### 2.4 PDF 阅读器（13 条） ✅（12.5 / 13）

全部落地，唯一保留的是 EPUB 阅读：TXT / Markdown 已完整可读（分页、目录、划线、搜索、AI 讨论全通），
EPUB 只留接口与明确提示（补一个 `epubSource.ts` 实现 `DocumentSourceBase` 即可接上）。

关键实现：
- **FTS 中文分词**：SQLite 自带分词器对中文都不可用（`unicode61` 把整串汉字当一个词，`trigram` 要求查询至少 3 字，
  最常见的双字词搜不到）。方案是 unicode61 + 应用层重叠 bigram 切分，查询用**短语查询**要求 bigram 连续出现，
  等价子串匹配且避开二元切分的假命中；单字走前缀匹配。FTS 不可用时自动回退 LIKE（并转义 `%_`）。
- **锚点重定位**：`locateAnchor` 从死代码接上，打开文档时整本跑一遍，四态处理 ——
  `moved` 的在渲染后按文字层重算矩形并写回库（自愈），`missing` 的不再按旧矩形乱画而是在笔记面板标出。
- **文档源抽象** `src/documents/`：`DocumentSourceBase` 统一 PDF 与文本，`renderMode: 'canvas' | 'text'` 决定渲染方式，
  虚拟滚动、锚点矩形、高亮层、命中层四者共用。
- 后台索引队列（可见可取消，离开阅读器不中断）、乐观更新 + 按页索引、扫描版/加密 PDF 检测提示、
  高亮笔记导出 Markdown、纸/夜/护眼三主题、可折叠可拖宽侧栏、13 组快捷键 + 帮助浮层、目录/缩略图/页码跳转。
### 2.5 设置与外观（7 条） ✅

1. 主题三选已端到端接通（`settings` 表 → `applyTheme` → `<html data-theme>` → 全仓已有的 `dark:` 类），启动前先按缓存涂一遍防白闪。
2. `ProviderForm` 补齐自定义请求头、代理、首字节/空闲超时、并发，折叠在「高级选项」；模型改下拉并按预设锁定上下文窗口（顺带落了 §2.1 第 5 条前半）。
3. 删除供应商时级联清理 `defaultProviderId` 与三项用途覆盖并提示。
4. 通用页加「关于」：版本号、数据目录 / 日志目录、复制诊断信息。自动更新未做（`tauri-plugin-updater` 未安装，列入 P3）。
5. 注册传 `handle` —— 已随 P0-4 完成。
6. 服务器地址加格式校验 + 「测试连接」（打 `/api/v1/health` 并校验响应格式），不合法不落库。
7. 全仓原生 `window.confirm` 已清零，统一为 promise 化的 `confirm()`。

---

## P2 社区与增长（18 条） 🚧

§3.3 刷量防护已随 P0-6 一并完成 ✅：fork 幂等（唯一约束 + 返回既有记录）+ fork 限流；举报要求登录 + 去重键 + 5/小时限流；
`viewerKey` 绑定 IP 前缀（IPv4 /24、IPv6 前 4 组）使轮换 `X-Client-Id` 失效；写端点与网页路由限流补齐。

数据底座已先行落地（迁移 `0003_lumpy_mister_fear.sql`）：
`notifications`、`comment_likes`、`bookmarks`（想读）、`reading_progress`（云端阅读进度）、
`tags` + `novel_tags`（标签目录，已从现有 `novels.tags` 回填）、`handle_history`（改名 301）、
`comments.chapter_index`（章节级留言）。

---

## P3 技术债与长期（12 条） ⏸

---

## 需要人工在 GUI 里确认的事项

CSP 从 `null` 改为严格策略后，以下每条都要在 `tauri dev` 与 `tauri build` 各跑一次，
devtools Console 出现任何 `Refused to …` 即为失败：

1. 导入并打开 PDF → 渲染正常 + 文字可选中（验 `connect-src asset:`、`font-src data:`、`worker-src blob:`）
2. 打开含 JPEG2000 / JBIG2 图的 PDF（验 `script-src 'wasm-unsafe-eval'`）
3. 设置页「测试连接」+ 跑一次流式生成（验 IPC 未降级：Console 不应出现 `IPC custom protocol failed`）
4. 登录云端账号 + 浏览公共书房
5. 「打开数据目录」「去申请 Key」外链
6. 在 Windows 上重跑 1–5（`http://ipc.localhost` / `http://asset.localhost` 分支与 macOS 不同）

> 重要背景：LLM 与云端请求全部走 `@tauri-apps/plugin-http`，它内部是 `invoke('plugin:http|fetch')`，
> 由 Rust 端出网、不经过 webview 网络栈。所以 **`connect-src` 管不到供应商域名**，
> 真正的出站白名单是 `src-tauri/capabilities/default.json` 的 `http:default` scope。

---

## 已落地的共享底座

| 项 | 位置 |
|---|---|
| 服务端 schema 扩展（P0） | `apps/server/drizzle/0002_flippant_riptide.sql`：`users.status/suspended_until/status_reason/email_verified_at/deleted_at`、`email_tokens`、`moderation_events`、`reports.dedupe_key`（唯一）、`forks(user_id, source_novel_id)`（唯一）、`blobs` 上传者与时间索引。**含对已有数据的回填与去重语句** |
| 服务端 schema 扩展（P2） | `apps/server/drizzle/0003_lumpy_mister_fear.sql`（见上） |
| 服务端环境变量 | `env.ts` 新增 `TRUSTED_PROXIES`、`MAIL_*`、`SMTP_URL`、`RESEND_API_KEY`、`MODERATION_MODE`、`MODERATION_BLOCKLIST_PATH`、`STORAGE_QUOTA_BYTES`、`BACKUP_DIR` |
| 限流规则 | `middleware/rate-limit.ts` 新增 `report`(5/时)、`fork`(20/时)、`write`(120/分)、`password`(5/时)、`web`(240/分) |
| 邮件出口 | `lib/mailer.ts`：console（开发）/ smtp（nodemailer）/ resend；测试用 `memoryMailer`，`makeTestApp().outbox` 可断言 |
| 桌面迁移 | `0004_provider_runtime.sql`（供应商超时 / 代理 / 并发）、`0005_soft_delete.sql`（回收站） |
