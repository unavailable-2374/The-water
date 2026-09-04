# The Water · AI 阅读器与小说工坊

桌面应用（Tauri 2 + React）+ 云端公共区服务（Bun + Hono），四大功能：

1. **PDF 阅读**：导入 PDF，选中文字即可「问 AI」、高亮、写笔记，支持全文搜索。
2. **一键生成小说**：输入题材/风格/禁忌/字数与故事框架 → 生成大纲 → 章节表 → 后台逐章写作（可暂停、续写、重生成、扩写/精简，退出应用后可恢复）。
3. **一键改写**：每本小说都有可编辑的故事线（人物 / 设定 / 故事弧 / 情节点 / 章节计划）。修改后点「计算需改写章节」，系统按规则算出受影响章节与原因，一键改写。
4. **公共区**：把小说发布到云端，其他读者可在线阅读、点赞，也可「派生二创」到本地库，改写后再发布，带完整溯源。
5. **社区**：@用户名与作者主页、关注与屏蔽、关注动态流、作品留言、站外分享链接与分享图，以及积分 / 等级 / 徽章 / 榜单的激励计划。

## 目录

```
apps/desktop    Tauri 2 桌面应用（所有业务逻辑在 TypeScript；Rust 只做插件 + 钥匙串命令 + SQL 迁移）
apps/server     公共区服务：Bun + Hono + Drizzle（SQLite，可切 Postgres）+ 极简网页阅读页
packages/shared 两端共用的 zod schema、hash、字数统计
```

## 环境要求

macOS（已在 Apple Silicon 验证）、Bun ≥ 1.3、Rust stable、Xcode 命令行工具。

## 运行

```bash
bun install

# 桌面应用（首次编译 Rust 需几分钟）。若希望自动读取 DeepSeek key，请在有该环境变量的终端中启动：
export DEEPSEEK_API_KEY=sk-...
bun run dev                      # = bun run --filter desktop tauri dev

# 公共区服务（另开终端）
cd apps/server && cp .env.example .env
bun run db:migrate && bun run db:seed   # 种子账号 writer@example.com / password123
bun run dev                              # http://localhost:8787 ，网页阅读页在 / ，API 在 /api/v1
```

桌面端：设置 → 模型供应商 添加 DeepSeek / Qwen / Kimi / OpenAI / Anthropic（API Key 存入系统钥匙串）；设置 → 云端账号 填写服务器地址并注册登录后即可发布与二创。

社区功能在「公共书房」里：顶部可切 书房 / 动态 / 榜单，作品页可关注作者、留言、分享；设置 → 云端账号 可编辑 @用户名与简介、查看积分与徽章，设置 → 关注与屏蔽 管理名单。若要让分享链接对站外可用，请在服务端 `.env` 里设置 `PUBLIC_BASE_URL`。

## 测试与类型检查

```bash
bun run typecheck        # 三个工作区的 tsc
bun run test             # desktop + shared 用 vitest，server 用 bun test
```

桌面端测试不依赖 Tauri：数据库用 `node:sqlite` 内存库跑同一份迁移，模型调用用脚本化的 SSE 假服务。`test/jobs/runner.test.ts` 会真实跑完「写章 → 调字数 → 总结与圣经」任务链，并验证崩溃恢复与暂停/续写。

## 打包

```bash
bun run --filter desktop tauri build     # 产物在 apps/desktop/src-tauri/target/release/bundle/
```

## 设计文档

完整方案（架构、数据表、API 契约、发布/fork 协议、改写算法）见 `docs/PLAN.md`。

写作标准化框架（文章类型模版、StyleProfile 文风规格、二创保味协议、AI 味词表）见 `docs/writing/README.md`。

产品优化 / 调整建议方案（按 P0–P3 分级、附代码落点）见 `docs/PRODUCT-OPTIMIZATION-PROPOSAL.md`。
