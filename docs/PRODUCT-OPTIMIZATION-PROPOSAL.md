# The Water 产品优化 / 调整建议方案

> 版本：v1.0 · 2026-09-04 · 提交方：产品 · 接收方：技术部负责人
>
> 本方案基于对当前代码库（桌面端、服务端、共享包）的逐模块调研与验证形成，每条问题都给出代码落点，技术负责人可直接定位。方案只提「问题 → 建议 → 验收」，具体技术实现由技术部定。

---

## 目录

0. [摘要与总体判断](#0-摘要与总体判断)
1. [P0 上线阻断项](#1-p0-上线阻断项)
2. [P1 核心体验：阅读 / 写作 / 改写](#2-p1-核心体验)
3. [P2 社区与增长](#3-p2-社区与增长)
4. [P3 技术债与长期](#4-p3-技术债与长期)
5. [排期建议与依赖](#5-排期建议与依赖)
6. [附录](#6-附录)

---

## 0. 摘要与总体判断

### 0.1 现状

五大功能（PDF 阅读、一键生成小说、一键改写、公共区、社区）都已闭环，可以端到端跑通。工程基线健康：

| 检查 | 结果 |
|---|---|
| `bun run typecheck`（shared / server / desktop） | 全部通过 |
| `bun run test` | shared 29、server 74、desktop 260，共 363 个用例全绿 |
| 代码 TODO / FIXME 标记 | 零条（未完成的部分没有留标记，而是以「空实现」或「未接线」的形式存在） |

代码质量整体很高：契约测试覆盖所有端点、幂等发布协议、内容寻址去重、确定性的改写影响算法、四层文风规格。这些是产品护城河，要守住。

### 0.2 核心判断

产品当前处于**「功能齐、底座空」**的状态。功能面已经超过同类开源项目，但作为一个要对外的 UGC 平台 + 付费 API 消耗型桌面软件，以下底座**全部缺失**：

| 缺失项 | 后果 |
|---|---|
| 内容审核是空实现（`noopModerator` 接入生产） | 任何内容无条件公开，平台法律风险 |
| 无邮件系统 → 无找回密码、无注销账号 | 忘记密码 = 账号与已发布作品永久失联 |
| 管理员按未验证邮箱自动授予 | 抢注邮箱即可获得管理员 |
| 无通知系统 | 关注 / 留言 / 派生 / 徽章全部无感知，社区无法形成互动回路 |
| 服务端无备份、内容存 SQLite 且永不回收 | 单文件即全部资产，且无限增长 |
| 桌面端无请求超时、无错误边界、无日志、无自动更新 | 任务会永久挂起；白屏无法定位；线上问题无法复现；无法推送修复 |
| 仓库零提交 | 无历史、无回滚、无 CI |

### 0.3 建议节奏

```
P0 上线阻断（约 2–3 周） → P1 核心体验（约 4–6 周） → P2 社区与增长（约 6–8 周） → P3 技术债（持续）
```

P0 不做完不建议对任何外部用户开放公共区。P1 中的「首启引导 / 超时 / 成本统计」建议与 P0 并行，它们决定了第一批用户能否留下。

---

## 1. P0 上线阻断项

不做不能对外。每项都给出验收标准，建议作为「上线检查清单」。

### P0-1 工程基线：仓库首提 + CI

- **问题**：`git log` 显示 `main` 分支零提交，`apps/`、`packages/`、`docs/` 全部处于未跟踪状态。没有历史、没有分支、无法 bisect、无法回滚。
- **建议**：立即完成首次提交；配置 CI 跑 `bun run typecheck && bun run test`；`main` 加分支保护，PR 必须过 CI。
- **验收**：`git log` 有历史；任何 PR 未过 CI 不可合并。

### P0-2 内容审核：从空实现到可用

- **问题**：
  - `apps/server/src/lib/moderation.ts` 只有 20 行接口 + `noopModerator`，`apps/server/src/index.ts:15` 把 `noopModerator` 接进生产。所有作品无条件过审。
  - 审核钩子只在 `versions/service.ts` 的 `commitVersion` 触发。`PATCH /novels/:id`（标题 / 摘要 / 标签）、留言、昵称 / 简介 / handle 均不过审。「干净内容过审后改标题」是明显的绕过路径（`docs/PLAN.md` §7.6 也承认留言未接审核）。
- **建议**：
  1. 实现最小可用的 `ContentModerator`：敏感词表 + 可选第三方文本审核 API，命中即 `hidden` 进人工复审队列。
  2. 审核输入形状从「整本小说」扩展为「任意文本片段」，让元数据编辑、留言、个人资料复用同一通道。
  3. 复审结果通知作者（依赖 P2 通知系统，过渡期可用邮件）。
- **验收**：含敏感词作品 commit 后状态为 `hidden`；修改标题为敏感词触发复审；留言含敏感词被拦截。

### P0-3 管理员授予：关闭邮箱抢注提权

- **问题**：`apps/server/src/modules/auth/service.ts:26,108-113` 在注册**和登录**时按 `ADMIN_EMAILS` 匹配邮箱自动设为 `admin`。系统没有邮箱验证，先注册该邮箱的人即成为管理员。且只升不降，从环境变量移除邮箱不会撤销已有管理员。
- **建议**：改为显式授予（seed 脚本或 CLI 命令 `bun run admin:grant <email>`），或在邮箱验证（P0-4）落地后才允许匹配；同步支持降级。
- **验收**：用 `ADMIN_EMAILS` 中的邮箱新注册账号，`role` 仍为 `user`。

### P0-4 账号生命周期：邮件、找回密码、改密、注销

- **问题**：`apps/server` 全仓无 SMTP / 邮件相关代码。没有邮箱验证、没有找回密码、没有修改密码（`packages/shared/src/api/auth.ts:31-35` 的 `UpdateProfileRequestSchema` 只有 displayName / handle / bio）、没有注销账号（无 `DELETE /auth/me`，且 `users` 被 `novels.authorId`、`comments.authorId` 外键引用，手工删除会失败）。
- **建议**：
  1. 接入邮件服务（Resend / SMTP 皆可），环境变量进 `env.ts`。
  2. 新增：`POST /auth/password/forgot`、`POST /auth/password/reset`、`PATCH /auth/password`、`POST /auth/email/verify`、`DELETE /auth/me`。
  3. 注销策略：作品可选「随账号删除」或「保留为匿名作者」；提供数据导出（个人资料 + 作品 bundle 打包）。
  4. 桌面端 `AccountPanel` 补齐入口。
- **验收**：忘记密码可通过邮件重置；可修改密码；可注销并下载数据。

### P0-5 数据安全：备份、blob 回收、配额

- **问题**：
  - 服务端无任何备份脚本或文档。
  - 章节内容存在 `blobs.content` 的 `text` 列（`apps/server/src/db/schema.ts:136-143`），整个平台所有版本所有章节都在一个 SQLite 文件里。
  - `gcDrafts`（`versions/service.ts:273-286`）只删过期草稿行，**从不回收 blob**。每次失败发布、每本软删作品的内容永久驻留。
  - `POST /blobs` 无每用户配额（60 次/分 × 20 个 × ~200KB），是存储耗尽攻击面。
- **建议**：每日 `VACUUM INTO` 备份 + 保留策略（7 天/4 周/12 月）+ 恢复演练文档；blob 引用计数并定时 GC；每用户存储配额与提示。中期评估 blob 外置到对象存储。
- **验收**：能从备份文件恢复出可用服务；孤儿 blob 在 GC 后被清理；超配额上传返回明确错误。

### P0-6 审核后台：管理页、封禁、审计日志

- **问题**：
  - 没有任何管理员 UI（服务端无管理页，桌面端 `grep admin` 为空），当前审核靠 curl。
  - `users.role` 只有 `user | admin`（`schema.ts:21`），无封禁 / 禁言 / 冻结。惯犯只能逐本隐藏作品，账号仍可留言、fork、关注。
  - `admin/service.ts:41,59` 的 `setModeration` 拿到 `admin` 参数只用来渲染响应，**不记录操作者**；`resolveReport` 完全不记录处理人。无 `moderation_events` 表。
  - 举报 `POST /novels/:id/reports` 允许匿名、无限流、无去重（`social/service.ts:110`），可零成本刷爆举报队列。
  - 积分冲正只能一次（`incentive/service.ts:311` dedupe key），恢复作品不返还，二次下架不再冲正。
- **建议**：最小管理页（举报队列、作品 / 留言处理、用户封禁与解封、操作记录）；`moderation_events` 表记录操作者 / 对象 / 动作 / 原因 / 时间；举报加登录要求或限流 + 同人同对象去重。
- **验收**：每次审核动作可追溯到人；被封禁账号无法写入任何内容。

### P0-7 桌面稳定性：LLM 请求超时

- **问题**：`grep -rn timeout apps/desktop/src` 返回空。`llm/openaiCompatible.ts`、`llm/anthropic.ts` 均无首字节超时和空闲超时。供应商建立 SSE 连接后停止发送，任务将永久停在 `running`，唯一出路是用户手动暂停。
- **建议**：每次调用加「首字节超时」（如 60s）与「流空闲超时」（如 90s），超时归类为可重试的 `network` 错误走现有 `withRetry`（`llm/retry.ts:139`）。设置页可调。
- **验收**：用测试假服务停发数据，任务在超时后自动重试或失败，不再永久挂起。

### P0-8 桌面稳定性：错误边界、兜底路由、CSP

- **问题**：
  - 全仓无 `ErrorBoundary`。任何渲染异常直接白屏，只有 `main.tsx:9-10` 的 `window.onerror` 弹 toast。
  - `app/router.tsx` 无 404 路由、无 `errorElement`；顶层未知路径渲染空壳。
  - `src-tauri/tauri.conf.json:24` `"csp": null`，CSP 关闭。
- **建议**：根级 + 每个 feature 级错误边界（显示「出错了 / 重试 / 反馈」）；兜底路由；按实际需要的 `connect-src`（各供应商域名、云端地址）、`img-src`、`worker-src`（pdf.js）配置 CSP。
- **验收**：人为抛渲染异常不白屏；访问不存在路径显示提示页；CSP 开启后 PDF 与 LLM 流式均正常。

### P0-9 桌面数据：软删除、回收站、本地备份

- **问题**：
  - `db/repos/novelsRepo.ts:55` 的 `deleteNovel` 是 `DELETE FROM novels` 级联删除全部章节 / 版本 / 故事线，只有 `window.confirm` 一道门（`features/library/LibraryPage.tsx:99`）。文档删除同样硬删，且 `LibraryPage.tsx:66` 先删 DB 行再删文件，文件删除失败会留下孤儿 PDF。
  - 无本地库备份 / 导出 / 导入，无「打开数据目录」。
- **建议**：`novels` / `documents` 增加 `deleted_at`，回收站保留 30 天；设置页加「备份数据库」「从备份恢复」「打开数据目录」；启动时清理孤儿文件。
- **验收**：误删小说可在回收站恢复；备份文件可导入到新安装。

### P0-10 首启引导

- **问题**：`app/bootstrap.ts` 只在存在 `*_API_KEY` 环境变量时静默种一条供应商。普通用户首次打开进入空书架，没有任何提示，直到第一次调用 AI 才收到 `llm/registry.ts:54` 抛出的「尚未配置任何 AI 供应商」。
- **建议**：首启向导三步：选供应商 → 填 Key（含获取 Key 的链接）→ 测试连接；成功后引导「导入一本 PDF」或「写第一本小说」。已有供应商则跳过。
- **验收**：新用户 3 步内完成首个成功的 AI 调用。

---

## 2. P1 核心体验

### 2.1 小说生成流水线

| # | 问题 | 代码落点 | 建议 |
|---|---|---|---|
| 1 | 大纲与章节表在**前台**执行，不持久化、不可恢复；崩溃即全丢。重跑章节表会先 `deleteChaptersFrom(novelId, 1)` 清空已有章节 | `novel/service.ts:63,83,103` | 改为后台 job 步骤（`outline` / `chapter_table` 两种步骤类型已在 `jobsRepo.ts:7` 声明但 `jobs/steps/index.ts` 无 handler）；已有章节时先弹二次确认并自动落快照 |
| 2 | 所有步骤共用「写作」模型：总结、风格审校、设定校对、拆书都用最贵的写作模型 | `jobs/runner.ts:71` 固定 `providerForPurpose('writing')`；`job.providerId` 所有调用点传 `null`（`service.ts:143,156,170,178,189`） | 按步骤用途分配模型（写章用强模型，summarize / styleReview / consistency 用便宜模型）；向导第三步（i18n 已命名「模型与确认」）真正提供模型选择 |
| 3 | **无成本 / 用量统计**。token usage 已逐条落库（`chapter_versions.usage`、`ai_messages.usage`）但从未聚合展示 | `grep inputTokens src/features` 为零 | 内置价格表（按供应商 / 模型，可编辑）；每任务 / 每本 / 每月用量卡片；开始生成前的费用预估（替换 `RewritePlanDialog.tsx:88` 的 `targetChars*2` 粗估）；预算上限告警 |
| 4 | 暂停 / 崩溃后续写不复用已生成文本，整步从头重跑并重复计费 | `runner.ts:116-118` 只保存 `partial_text` 供展示 | 以 `partial_text` 作为续写种子（「以下是已写部分，请从此继续」） |
| 5 | `context_length` 错误不自动缩上下文重试；`contextWindow` 是用户手填数字，填错静默 400 | `retry.ts:7`、`ProviderForm.tsx:19` 默认 128000 | 预置按模型自动填并锁定；命中 `context_length` 时自动缩一档重试一次 |
| 6 | 任一步骤失败即整任务失败；UI 只有「全部重试 / 全部跳过」；`attempts` 字段从未用于重试决策 | `JobsTab.tsx:104`、`runner.ts:170` | 单步重试 / 跳过；步骤级自动重试策略（如 2 次） |
| 7 | `adjust_length` 一步可产两个版本，但幂等只认一个；崩在两次之间会漏掉第二次 | `adjustLengthStep.ts:11` `MAX_EXPAND_PASSES=2` | 每个 pass 独立幂等键 |
| 8 | 全局严格串行单任务：一本长篇跑着，其他小说和阅读器聊天都排队 | `runner.ts:46` 单循环；`RateGate` 任务与聊天共用 | 最少「任务池 / 聊天池」分离；其次可配置并发数（供应商级） |
| 9 | 供应商 JSON 修复只有 1 轮，失败即整任务失败；json_object 模式把完整 schema 塞进 user 消息，未计入预算 | `llm/json.ts:180,133` | 修复轮次可配；schema 注入计入上下文预算 |
| 10 | 供应商预设硬编码（模型名、上下文、输出上限） | `llm/factory.ts:19` | 预设可远程更新或至少集中到一份可编辑配置 |

### 2.2 一键改写

| # | 问题 | 代码落点 | 建议 |
|---|---|---|---|
| 1 | 改写前无正文预览、改写后无逐章接受 / 拒绝，新版本直接成为 current | `RewritePlanDialog.tsx` 只展示故事线 diff；`createVersion` 直接置 current | 改写结果先落「待采纳」版本；逐章旧 / 新对比后采纳或丢弃 |
| 2 | 版本历史只有元数据（稿号 / 字数 / 来源 / 时间），无文本 diff；无法删除版本 | `ChaptersTab.tsx:200,237` | 版本间 diff 视图；版本清理策略（保留最近 N 个 + 手动钉住） |
| 3 | 编辑器每 2 秒空闲即建一个新版本，手动编辑几分钟就产生几十个版本 | `ChaptersTab.tsx:145` | 自动保存合并为「会话级」版本（离开章节或 5 分钟无操作才封版） |
| 4 | `pre_rewrite` 快照类型存在但从未写入；改写前只落 `user_commit` | `service.ts:161` | 改写前自动落 `pre_rewrite`，提供「撤销这次改写」一键回滚 |
| 5 | 连续性涟漪章默认不勾，只有一个总开关 | `affected.ts:298` | 保留默认，但按弧分组勾选；显示每章预估费用 |

### 2.3 写作框架（文风 / 题材 / 质检）

| # | 问题 | 代码落点 | 建议 |
|---|---|---|---|
| 1 | 学习层只记录不可见：`promoteFeedback` / `listFeedback` / `dismissFeedback` 无任何调用 | `db/repos/feedbackRepo.ts` | 「我的写作偏好」面板：查看 / 删除 / 手动晋升学到的短语 |
| 2 | `countMode`（全部 / 仅汉字）设置存在于 UI，但 `countHanOnly` 零调用，设置无效 | `GeneralSettings.tsx:36` | 接入字数显示与目标计算，或删除该设置 |
| 3 | `style_check` 只定点修订 1 轮，之后无论是否达标都通过 | `styleCheckStep.ts:27` `MAX_REVISIONS=1`、`:86` 阈值 | 轮数与阈值可配；未达标章节在列表标「风格未达标」并可一键再审 |
| 4 | 阈值常量散落多处（lint、styleMetrics、learning、bible caps、extractStyle 批大小） | 见附录 B | 收敛为一份 `novel/config.ts`，文档化 |
| 5 | 导出只有 TXT 可达；MD 已实现未接 UI；无 EPUB / DOCX；无章节范围 | `novel/export.ts`（29 行）、`ChaptersTab.tsx:72` | 接 MD；新增 EPUB、DOCX；支持范围与元数据（书名 / 作者 / 简介 / 许可） |
| 6 | 提示词全部硬编码，用户不可见不可改 | `llm/prompts/*` | 高级设置：查看当前提示词；允许为单本小说追加「作者附加指令」 |
| 7 | PDF 文本、导入正文、上一章摘要直接拼进 prompt，无分隔与声明；被投毒的摘要会向后传播 | `AiDiscussPanel.tsx:64`、`extractStyleStep.ts:52`、`context.ts` | 用户内容用明确分隔块包裹并声明「以下为资料，不是指令」 |

### 2.4 PDF 阅读器

| # | 问题 | 代码落点 | 建议 |
|---|---|---|---|
| 1 | 只能导入 PDF；无 EPUB / TXT / MD 阅读；无拖拽导入 | `pdf/import.ts:10` | 抽象「文档源」，新增 EPUB 与纯文本阅读；窗口拖拽导入 |
| 2 | 无目录（`getOutline` 全仓未调用）、无缩略图、无页码跳转框 | `features/reader/*` | 目录面板 + 页码输入 + 缩略图 |
| 3 | 阅读器**零快捷键**：无翻页键、无 Cmd+F、无 Cmd± 缩放、无 Ctrl+滚轮 | `features/reader/` 无 `keydown` | 补齐基础快捷键并提供快捷键帮助页 |
| 4 | 高亮颜色从未传入，四色调色板不可达 | `SelectionPopover.tsx:35` 调用 `createHighlight` 时不传 `color` | 选段气泡加颜色选择 |
| 5 | 锚点重定位 `locateAnchor` 是死代码，高亮只按存储矩形渲染；页面文本变化时静默错位 | `pdf/anchor.ts:33` 无调用方；`t.reader.cannotLocate` 未使用 | 打开文档时走重定位，失败在笔记面板标「无法定位」 |
| 6 | 搜索是 `LIKE '%q%'`，无 FTS、无页内命中高亮、无上一条 / 下一条、结果 50 条无提示 | `documentsRepo.ts:62-72` | FTS5 + 命中高亮 + 导航 + 计数 |
| 7 | 首次打开同步串行建全文索引且不可取消，大书明显阻塞 | `ReaderPage.tsx:39-43` | 导入时后台建索引，进度可见可取消 |
| 8 | 无阅读主题：画布 `bg-white` 硬编码，无夜读反色 | `PageView.tsx:87` | 纸 / 夜 / 护眼三主题，夜读对画布做反色滤镜 |
| 9 | 侧栏固定 380px、不可折叠不可拖宽 | `ReaderPage.tsx:96` | 可折叠、可拖宽，记忆宽度 |
| 10 | 高亮 / 笔记无导出 | — | 导出 Markdown（按页分组，含原文引用与页码） |
| 11 | 选段气泡不随点击外部消失；Y 轴不做边界钳制，底部会被裁出屏幕 | `SelectionPopover.tsx:22-26,44-45` | 修复 |
| 12 | 扫描版 / 加密 PDF 无任何提示（无文字层、搜索为空） | — | 检测并提示；OCR 列为长期 |
| 13 | 每次增删改高亮后全量重取列表，每页每次渲染都过滤全部高亮 | `readerStore.ts`、`HighlightLayer.tsx:11` | 乐观更新 + 按页索引 |

### 2.5 设置与外观

| # | 问题 | 代码落点 | 建议 |
|---|---|---|---|
| 1 | `theme` 设置声明了 `system/light/dark` 但无 UI 写入、无代码读取；只能跟随系统 | `settingsRepo.ts:7`、`index.css:62` | 三选主题 |
| 2 | 无代理设置；`extraHeaders` 字段存在但无输入框；无超时 / 并发配置 | `ProviderForm.tsx:49` | 补齐高级项 |
| 3 | 删除供应商不清理 `defaultProviderId` 与三项用途覆盖，可指向已删 id | `ProvidersPage.tsx:36-42` | 删除时级联清理并提示 |
| 4 | 无「关于 / 版本号 / 检查更新 / 日志目录」 | — | 通用页加「关于」 |
| 5 | 桌面注册不传 `handle`，用户无法在注册时选用户名（服务端已支持） | `sync/api.ts:157` | 注册表单加用户名 |
| 6 | 服务器地址 `onBlur` 即保存，无格式校验与连通性检查 | `AccountPanel.tsx:57` | 校验 + 「测试连接」 |
| 7 | 确认框混用原生 `window.confirm` 与自定义 `Dialog` | `LibraryPage`、`ProvidersPage:39`、`AccountPanel`、`RemoteNovelPage` | 统一为自定义确认对话框 |

---

## 3. P2 社区与增长

### 3.1 通知系统（最大的参与度缺口）

- **问题**：服务端无通知表、无端点；桌面端无小红点。用户获得关注、留言、回复、派生、徽章、作品被隐藏，全部无感知。而积分引擎（`modules/incentive/service.ts` 的 `award()`）已经在处理所有这些事件，事件源是现成的。
- **建议**：`notifications` 表 + `GET /me/notifications` + 已读标记；在 `award()` 与审核动作处发通知；桌面端侧栏小红点 + 通知列表；可选系统通知（依赖 `tauri-plugin-notification`）。
- **验收**：被关注 / 被留言 / 作品被派生 / 获得徽章 / 作品被隐藏时，作者在应用内看到通知。

### 3.2 发布管理：下架与回滚

- **问题**：`UpdateNovelRequestSchema`（`packages/shared/src/api/novels.ts:28`）只允许 `public | unlisted`，首次提交后无法回到 `unpublished`，唯一的「下架」是不可逆的软删除；`currentVersionId` 只前进（`versions/service.ts:239`），发错版本无法回滚。
- **建议**：允许 `visibility` 回到 `unpublished`（保留数据与谱系）；新增「设 vN 为当前版本」；桌面端「我的发布」页显示版本列表并可回滚。

### 3.3 刷量防护

| 问题 | 代码落点 | 建议 |
|---|---|---|
| `forks` 无 `(userId, sourceNovelId)` 唯一约束，`createFork` 无条件 `forkCount+1` 且无限流；`forkCount`、作者页 `derivedCount`、`forked_1/forked_10` 徽章都可单账号循环刷 | `schema.ts:161-178`、`forks/service.ts:65-68` | 加唯一约束（重复 fork 返回既有记录）；fork 限流 |
| `X-Client-Id` 由客户端提供，轮换即可刷 `viewCount`（积分有 30/日上限，但展示数无上限） | `middleware/client-id.ts:24-25` | 展示数按 IP+UA 二次去重；或只展示积分口径 |
| 无限流的写端点：`POST /novels`、`versions`、`commit`、`forks`、`like`、`view`、`reports`；网页路由整体无限流 | `app.ts:106-109` 限流只挂在 `api` 子应用 | 补齐限流规则；网页路由挂读限流 |

### 3.4 发现与检索

- 无用户搜索（只有按 id / 精确 handle）。
- 无标签目录、无标签计数、无热门标签；标签是自由文本无归一化（`search.ts:19-21`）。
- 无书架 / 想读 / 收藏夹，`GET /me/likes` 同时充当喜欢与书签。
- 无阅读进度云同步（`readerStore` 只管本地 PDF）。
- 动态流无折叠（10 章更新 = 10 条）、无已读态。
- **建议**：标签目录 + 热门标签 + 用户搜索 + 「想读」列表 + 云端阅读进度 + 动态折叠。

### 3.5 网页阅读页（对外唯一的公开入口）

| 问题 | 代码落点 | 建议 |
|---|---|---|
| 无分页：首页固定最新 20 本；目录硬上限 200 章（数据模型允许 500）；作者页 50 本 | `web/routes.tsx:33,39,60` | 全部分页 |
| 无搜索 / 筛选 / 标签页 / 热门页；`BrowseQuery` 的排序筛选只有 API 有 | — | 最小的浏览页 |
| 无 `robots.txt`、`sitemap.xml`、`canonical`、JSON-LD `Book/Chapter`、`rel=prev/next`、RSS | — | 补齐 SEO 基础与连载 RSS |
| `og:image` 是 SVG，微信 / 推特抓取器不渲染，分享卡片实际失效（`cover.ts:15-16` 自述） | `routes.tsx:41` | 输出 PNG 封面（服务端光栅化或预渲染） |
| 页面无任何转化入口：无注册、无下载桌面端、无点赞留言 | — | 底部 CTA：下载桌面端 / 登录后互动 |
| 移动端目录强制两栏 | `layout.tsx:15` | 窄屏单栏 |
| 无字号 / 行距 / 宽度 / 主题切换（零 JS 设计） | — | 允许极少量客户端 JS 做阅读偏好，或用 CSS-only 方案 |

### 3.6 留言与会话

- 留言：无编辑、无点赞、无 @、只能挂在作品级，不能锚到章节 / 段落。建议先做「章节级留言」，与阅读体验绑定。
- 会话：`sessions.clientLabel` 已记录（`auth/service.ts:62`）但用户看不到设备列表，只能「全部退出」。建议加 `GET /auth/sessions` 与单设备注销。
- 账号枚举：注册 `EMAIL_TAKEN` 与登录时无账号直接跳过 argon2 校验（`auth/service.ts:74,105-107`）构成时序侧信道。建议登录走恒定时间路径。

### 3.7 许可与署名

- `-nc`（非商业）许可无任何强制或提示；缺人类可读的许可文本页与机器可读署名块（bundle 只有 `author` 与 `lineage`）。
- **建议**：作品页显示许可全文链接；bundle 与导出文件带署名块；派生发布时强制展示原作署名。

---

## 4. P3 技术债与长期

### 4.1 国际化

- 只有 `i18n/zh.ts`，无 locale 切换机制；`index.html` 硬编码 `lang="zh-CN"`。
- 大量页面直接写中文字面量绕过 `t`：`t.library.*`、`t.reader.*` 多数键零引用；`JobsTab.tsx:13` 与 `LibraryPage.tsx:110` 各自维护了与 `t.jobs.status` 不同措辞的状态标签表。
- 界面混杂英文：`Base URL`、`API Key`、`json_object`、`THE WATER · 读者`。
- **建议**：先统一走 `t`（消除三套标签表），再引入 locale 切换，为英文版留通道。

### 4.2 测试

| 区域 | 现状 |
|---|---|
| 桌面 UI | 零测试（`vitest.config.ts` 只 include `test/**/*.test.ts`，无 jsdom / testing-library） |
| 桌面 stores | 零测试 |
| `sync/*`（发布 / fork 协议桌面侧） | 零测试（只有服务端侧测试） |
| `novel/service.ts`（大纲 / 章节表 / 启动生成 / 改写 / 导入） | 零测试，包含 `deleteChaptersFrom` 的破坏性路径 |
| `novel/export.ts`、`jobs/planner.ts`、cancel / skip 路径、`adjust_length` 多 pass 幂等 | 零测试 |
| 服务端 | 缺并发（双 commit、同 idempotency key 并发）、迁移对**已有数据**回填（`0001_complex_speed.sql:83-88` handle 回填与唯一索引顺序）、lineage 500 截断、`gcSessions`、blob 孤儿 |
| shared | `bundle`、`hash`、`storyline`、`style`、`api/*` 无 shared 侧测试 |
| E2E | 无（无 Playwright / tauri-driver） |

**建议**：先补 `novel/service.ts` 与 `sync/*`；再引入组件测试；最后一条 tauri-driver 冒烟（导入 PDF → 问 AI → 生成 1 万字小说）。

### 4.3 可观测性

- 桌面：无日志文件（无 `tauri-plugin-log`）、无崩溃上报；用户报 bug 没有任何可附带的产物。
- 服务端：无访问日志、无延迟 / 状态码分布、无指标端点、无错误上报；健康检查 `app.ts:74-78` 不探 DB，数据库锁死时依然绿。
- **建议**：桌面 `tauri-plugin-log` + 「导出诊断包」；服务端结构化请求日志 + `/health` 探 DB + 接 Sentry。

### 4.4 发布、更新与多平台

- 无 `tauri-plugin-updater`、无签名、无更新端点；`version 0.1.0` 从不展示。
- 无单实例保护（双开共用同一 SQLite）、无窗口状态记忆、无系统通知、无托盘。
- `closeToDock` 仅 macOS 有效；`keyring` 只启用 `apple-native`，非 macOS 构建无密钥存储；但 `bundle.targets = "all"`。
- **建议**：明确「v1 仅 macOS」并在打包配置中收敛；或补齐跨平台密钥后端。无论哪条，都先做自动更新与签名。

### 4.5 服务端架构

- 限流与榜单缓存在进程内存（`rate-limit.ts`、`incentive/service.ts:434-445`），多实例下配额翻倍、榜单不一致。
- 启动自动迁移无锁（`index.ts:12`），滚动部署两个实例会竞争。
- README 描述的 Postgres 切换**未实现**：`db/search.ts` 依赖 SQLite `json_each`，schema 全是 `sqlite-core`。
- 浏览搜索 `LIKE '%q%'` 前导通配全表扫描，无 FTS5。
- `TRUST_PROXY=1` 无条件取第一个 `X-Forwarded-For`（`client-id.ts:11-14`），无可信代理列表。
- **建议**：限流 / 缓存下沉到共享存储（Redis 或 SQLite 表）；迁移加锁；FTS5；`TRUST_PROXY` 改为可信代理列表；Postgres 要么真做要么从 README 删掉。

### 4.6 数据层小问题（改动小，建议顺手修）

| 问题 | 代码落点 |
|---|---|
| `listMyLikes` 先切页后过滤非公开，页面变短但 `nextCursor` 非空 | `social/service.ts:77` |
| `popular / likes / forks` 排序的游标基于可变计数器，翻页时条目漂移 | `browse/service.ts:63-68` |
| `listVersions` 无分页返回全部 | `versions/service.ts:154-168` |
| lineage 后代查询 `.limit(500)` 无 `ORDER BY`，超限时返回任意切片 | `lineage.ts:44-50` |
| 每个祖先节点 N+1 查作者名与版本号 | `lineage.ts` |
| `job_steps.partial_text` 只在 `stepDone` 清理，失败 / 放弃的步骤永久保留全文 | `runner.ts` |
| 书架页每本小说一次 `novelCharCount` 查询（N+1） | `LibraryPage.tsx:101-104` |
| 供应商 token 估算存在两份不同实现（`llm/tokens.ts` 与 `llm/prompts/estimate.ts`），流水线只用后者 | — |

### 4.7 代码整理

- `ChatPage.tsx:3` 自述仍是「scaffolding」，其 `Bubble` 组件被阅读器 `AiDiscussPanel` 反向依赖；两处重复约 60 行会话 / 流式 / 中止逻辑。
- `AppShell.tsx` 导航高亮用 `q.includes('tab=novels')` 字符串匹配。
- 各列表页各自维护 `useState + useEffect + cursor + busy`，错误处理样板重复约 8 次，无请求去重与卸载取消。建议引入轻量数据层（如 TanStack Query）。
- `docs/PLAN.md` 第六阶段「用量 / 费用统计」与「`thewater://` 深链」未实现（`grep thewater://` 为空）。
- `apps/server/README.md` 端点表缺 `users`、`feed`、`comments`、`incentive` 四组约 20 个端点与 `/u/:handle` 网页。
- `users/service.ts:3` 注释「后续步骤接入」已过期（`awardFollow` 已接）。
- 无障碍：全仓仅 5 处 `aria-*`；`Dialog` 无 `role="dialog"`、无焦点陷阱；多处删除按钮 `opacity-0 group-hover` 键盘不可达；toast 无 `aria-live`。

---

## 5. 排期建议与依赖

按 1 前端 + 1 后端 + 1 全栈粗估。

| 批次 | 内容 | 粗估 |
|---|---|---|
| **P0** | 首提 + CI（0.5 天）；审核最小实现 + 扩展钩子（3 天）；管理员授予改造（0.5 天）；邮件 + 找回密码 + 改密 + 注销（4 天）；备份 + blob GC + 配额（3 天）；管理页 + 封禁 + 审计（4 天）；超时（1 天）；错误边界 + 404 + CSP（1.5 天）；软删除 + 回收站 + 本地备份（3 天）；首启引导（2 天） | 约 2–3 周 |
| **P1** | 大纲 / 章节表后台化（3 天）；分用途选模型（2 天）；成本统计与预估（4 天）；续写复用部分文本（1 天）；context_length 自动降档（1 天）；单步重试 / 跳过（1 天）；改写待采纳 + diff（4 天）；版本合并策略（1 天）；学习层面板（2 天）；导出 MD/EPUB（3 天）；阅读器目录 / 快捷键 / 颜色 / 重定位 / FTS / 主题 / 侧栏（8 天）；主题与设置补齐（2 天） | 约 4–6 周 |
| **P2** | 通知系统（5 天）；下架与回滚（2 天）；刷量防护（2 天）；标签目录 + 用户搜索 + 想读 + 进度同步（6 天）；网页分页 / SEO / PNG 封面 / CTA（5 天）；章节级留言 + 设备列表（4 天）；许可展示（1 天） | 约 6–8 周 |
| **P3** | i18n 统一；测试补齐；日志与监控；自动更新与签名；服务端限流 / 缓存下沉；FTS；数据层小修 | 持续 |

**关键依赖**

- P0-4（邮件）是 P0-3（邮箱验证后授予管理员）与注销账号的前置。
- 通知系统依赖积分引擎已有的事件点，建议同一人做。
- EPUB 阅读依赖阅读器先抽象「文档源」，与「导出 EPUB」共享解析 / 生成库。
- 自动更新依赖签名与 CI 产物，建议与 P0-1 一起把 CI 打包流水线搭起来。

---

## 6. 附录

### A. 关键文件定位清单

| 主题 | 文件 |
|---|---|
| 审核空实现 | `apps/server/src/lib/moderation.ts:16`、`apps/server/src/index.ts:15` |
| 管理员授予 | `apps/server/src/modules/auth/service.ts:26,108-113` |
| 审核动作不记录操作者 | `apps/server/src/modules/admin/service.ts:41,59` |
| 举报匿名无限流 | `apps/server/src/modules/social/service.ts:110` |
| blob 存储与 GC | `apps/server/src/db/schema.ts:136-143`、`apps/server/src/modules/versions/service.ts:273-286` |
| fork 无唯一约束 | `apps/server/src/db/schema.ts:161-178`、`modules/forks/service.ts:65-68` |
| 限流只挂 api 子应用 | `apps/server/src/app.ts:106-109` |
| 可见性不可回退 / 版本只前进 | `packages/shared/src/api/novels.ts:28`、`modules/versions/service.ts:239` |
| 网页硬上限 | `apps/server/src/web/routes.tsx:33,39,60` |
| SVG og:image | `apps/server/src/web/routes.tsx:41`、`web/cover.ts:15-16` |
| 无超时 | `apps/desktop/src/llm/openaiCompatible.ts`、`llm/anthropic.ts`（全仓 `timeout` 零命中） |
| CSP 关闭 | `apps/desktop/src-tauri/tauri.conf.json:24` |
| 硬删除 | `apps/desktop/src/db/repos/novelsRepo.ts:55`、`features/library/LibraryPage.tsx:66,99` |
| 前台大纲 / 清空章节 | `apps/desktop/src/novel/service.ts:63,83,103` |
| 固定写作模型 | `apps/desktop/src/jobs/runner.ts:71` |
| 费用粗估 | `apps/desktop/src/features/studio/RewritePlanDialog.tsx:88` |
| 自动保存建版本 | `apps/desktop/src/features/studio/ChaptersTab.tsx:145` |
| 学习层无 UI | `apps/desktop/src/db/repos/feedbackRepo.ts` |
| 无效设置 | `apps/desktop/src/db/repos/settingsRepo.ts:7`（theme）、`features/settings/GeneralSettings.tsx:36`（countMode） |
| 高亮颜色未传 | `apps/desktop/src/features/reader/SelectionPopover.tsx:35` |
| 锚点重定位死代码 | `apps/desktop/src/pdf/anchor.ts:33` |
| 搜索 LIKE | `apps/desktop/src/db/repos/documentsRepo.ts:62-72` |
| 首次打开建索引阻塞 | `apps/desktop/src/features/reader/ReaderPage.tsx:39-43` |
| 注册不传 handle | `apps/desktop/src/sync/api.ts:157` |
| 首启种子 | `apps/desktop/src/app/bootstrap.ts`、`llm/registry.ts:54` |

### B. 已确认的硬编码常量

| 类别 | 值 | 位置 |
|---|---|---|
| 供应商预设 | DeepSeek `deepseek-chat` 128k/8k；Qwen `qwen-plus` 131k/8k；Kimi `kimi-k2-0711-preview` 131k/8k；OpenAI `gpt-4.1` 1M/32k；Anthropic `claude-sonnet-4-5` 200k/16k | `llm/factory.ts:19` |
| CJK token 比率 | openai 兼容 0.7；Anthropic 1.0（按传输层而非模型） | `openaiCompatible.ts:85`、`anthropic.ts:120` |
| 重试 | 429 最多 6 次（基 2s，±20% 抖动，上限 60s）；5xx / 网络最多 4 次（基 1s） | `llm/retry.ts:139` |
| RateGate | 最小间隔 300ms；429 冷却 2s | `llm/retry.ts:188` |
| JSON 修复 | 1 轮，temperature 0 | `llm/json.ts:180` |
| 上下文预算 | 安全余量 1500；chapterPlans 1500 / bible 3000 / summaries 2500 / style 1800 / prevTail 1000 / logline 500；prevTail 800 字 | `llm/prompts/context.ts:132` |
| 字数控制 | 每章 3000；章数 3–150；单章最少 500；>4500 拆两半；<0.88 扩写（≤2 次）；>1.2 精简；请求 1.08 倍；重分配夹紧 ±30% | `novel/wordBudget.ts` |
| 输出上限公式 | `min(maxOutputTokens, ceil(target*1.6)+400)` | `novel/wordBudget.ts` |
| 风格审校 | 修订 1 轮；综合分 = LLM 0.6 + 指标 0.4；及格线 `styleFidelity`（默认 0.75）×100；指令上限 12 | `jobs/steps/styleCheckStep.ts:27,86,92` |
| 拆书 | 批 9000 字；最多 4 批；每章摘 3000 字；采样 ≤8 章 | `jobs/steps/extractStyleStep.ts:18` |
| Lint | 结构检查最少 600 字；burstiness <0.30 警告；段落均匀 <0.25；AI 味分 = 100 − 命中率×12 | `novel/lint.ts` |
| 学习层 | 出现 2 次晋升；n-gram 2–6；软禁用上限 100 | `novel/learning.ts` |
| 圣经上限 | timeline 5000 / facts 1000 / openThreads 500 / relationships 50 | `novel/bible.ts:9` |
| 温度 | 写章 0.85；改写 0.85 / 修订 0.7；调长 0.6；大纲 0.7；章节表 0.5；改写计划 0.4；总结 0.3；风格审校 0.2；设定校对 0.1；选段讨论 0.4 | `llm/prompts/*` |
| 编辑器 | 自动保存 2s 空闲；lint 防抖 500ms，<200 字跳过 | `ChaptersTab.tsx` |
| 服务端限流 | 登录 10/分/IP；注册 5/时/IP；blobs 60/分/用户；GET 300/分/IP；留言 10/分/用户；社交 60/分/用户 | `middleware/rate-limit.ts` |
| 请求体 | 默认 256KB；versions 1.5MB；blobs 4MB；Bun 总上限 8MB | `app.ts:31-46` |
| 会话 | 30 天滑动，每小时最多续一次 | `lib/tokens.ts`、`middleware/auth.ts` |
| 榜单缓存 | 120s，进程内 | `incentive/service.ts:434` |

### C. 与 `docs/PLAN.md` 已知限制的对应

| PLAN.md §7.6 条目 | 本方案对应 |
|---|---|
| `og:image` 是 SVG，微信 / Twitter 不渲染 | §3.5 PNG 封面 |
| 改 `handle` 旧链接失效 | 建议保留 handle 历史表做 301（列入 P2 发现与检索） |
| 匿名浏览计分可通过轮换 `X-Client-Id` 刷 | §3.3 刷量防护 |
| 留言未接 `ContentModerator` | P0-2 审核扩展到任意文本 |
| §5 第六阶段「用量 / 费用统计」未做 | §2.1 第 3 条 |
| §5 第六阶段「`thewater://` 深链」未做 | 列入 P3，与分享链接「在桌面端打开」联动 |
