# 产品优化方案落地追踪

> 对应 `docs/PRODUCT-OPTIMIZATION-PROPOSAL.md` v1.0 的 79 条建议。
> 状态：✅ 已完成 · 🚧 部分完成 · ⏸ 待排期 · ❌ 不做（附理由）

| 检查 | 开工前 | 现在 |
|---|---|---|
| `bun run typecheck` | 三工作区通过 | 三工作区通过 |
| `bun run test` | 363 例全绿 | **1001 例全绿**（shared 29 / server 232 / desktop 740） |
| git 历史 | 零提交 | 有历史 + CI |

---

## 总览

| 批次 | 条数 | 状态 |
|---|---|---|
| P0 上线阻断 | 10 | ✅ **10 / 10** |
| P1 核心体验 | 39 | ✅ **39 / 39** |
| P2 社区与增长 | 18 | ✅ **18 / 18** |
| P3 技术债与长期 | 12 | ✅ **12 / 12** |

---

## P0 上线阻断（10 / 10）

| # | 条目 | 落点与要点 |
|---|---|---|
| P0-1 | 仓库首提 + CI | `.github/workflows/ci.yml`：三工作区 typecheck + test + **迁移空库回放** + macOS 前端构建与 `cargo check`；分支保护步骤见 `.github/workflows/README.md` |
| P0-2 | 内容审核 | `noopModerator` 换为规则引擎（字符归一化抗「办·证」式分隔绕过 + 内置种子词表 + `MODERATION_BLOCKLIST_PATH` 外挂）。钩子从只有 `commitVersion` 扩到 `POST/PATCH /novels`、留言、昵称/简介/handle —— **「干净内容过审后改标题」的绕过路径已封死**。拦截即写 `auto_reject` 审计 |
| P0-3 | 管理员授予 | 改为「邮箱已验证 + 在 `ADMIN_EMAILS`」双条件并支持降级；`admin:grant/revoke/list` CLI |
| P0-4 | 账号生命周期 | 邮件出口（console / SMTP / Resend）+ 9 个端点；令牌只存哈希、一次性、verify 24h / reset 1h；**注销走匿名化而非物理删除**（避开外键），支持「作品随账号删」与「保留为匿名作者」；数据导出 |
| P0-5 | 备份 / blob 回收 / 配额 | `VACUUM INTO` 在线备份 + GFS 7日/4周/12月轮转；恢复连 `-wal`/`-shm` 整组留底并在失败时回滚；`gcBlobs` 按 `version_chapters` **与未过期草稿的 manifest** 双来源判定引用 + 24h 宽限期；每用户配额（重复上传不占额度）；`BACKUP.md` 含恢复验证 SQL 与季度演练清单 |
| P0-6 | 审核后台 | 零 JS 管理页 `/admin` + 6 个管理 API；封禁在鉴权层生效（非 GET 一律 403），禁言到期自动恢复并留痕；12 种审计动作全部落 `moderation_events` |
| P0-7 | LLM 请求超时 | 首字节 60s / 流空闲 90s 双计时器，**按 SSE 消息粒度计时**（按 token 计时会把 deepseek-reasoner 的思考阶段误判为空闲）；超时真 `abort()` 断链并归类为可重试 network 错误 |
| P0-8 | 错误边界 / 404 / CSP | 三层错误边界（根级 / 路由 `errorElement` / 每页 `FeatureBoundary`）+「重试 / 复制错误详情 / 导出诊断包」；`*` 兜底路由；CSP 由 `src/app/csp.ts` 单一出处生成并有逐字比对测试 |
| P0-9 | 软删除 / 回收站 / 本地备份 | 小说与文档软删 + 30 天回收站；永久删除改为「先删文件再删行」，文件删失败即中止，**不再产生孤儿 PDF**；启动清理过期项与孤儿文件；设置页备份 / 恢复 / 打开数据目录 |
| P0-10 | 首启引导 | 三步向导（选预设 → 填 Key，附各家申请页链接 → 自动真发一次最小请求）；**测试通过才写库**，失败不留脏供应商行 |

---

## P1 核心体验（39 / 39）

### 2.1 小说生成流水线（10 / 10）
大纲与章节表后台化（**分批可恢复**，全部批次跑完才动数据库；重建前自动落 `pre_rewrite` 快照）· 按步骤用途分配模型（建任务时**冻结**选择，跑到一半改设置不换模型）· 用量与费用统计（费用按**记账当时**价格存快照，改价不改写历史账单）· 以 `partial_text` 为种子续写 · `context_length` 自动降档 · 单步重试 / 跳过（`attempts` 终于参与决策）· `adjust_length` 每 pass 独立幂等键 · 任务池与聊天池分离（**429 冷却按 providerId 共享**，因为配额按 Key 算）· JSON 修复轮次可配 + schema 注入计入预算 · 供应商预设集中化

### 2.2 一键改写（5 / 5）
待采纳版本 + 逐章采纳 / 丢弃 · 两级 LCS 文本 diff（段落对齐后把「删一段 + 加一段」下钻到句级）+ 版本清理与钉住 · 自动保存合并为会话级版本 · `pre_rewrite` 快照与一键撤销 · 涟漪章按弧分组勾选 + 每章预估费用

### 2.3 写作框架（7 / 7）
学习层面板 · **`countMode` 选择删除而非接线**（全链路字数口径是 `countZh`，只改显示会让进度条永远到不了 100%，比无效开关更糟）· `style_check` 轮数与阈值可配 + 未达标标记 · 阈值常量收敛到 `novel/config.ts` · 提示词可见（**用示例输入调真模板函数渲染**，改模板界面自动跟着变）+ 单本作者附加指令 · `wrapUntrusted()` 资料块隔离（正文含同款标记会被打断，无法伪造边界）· 导出接 MD 并新增 EPUB / DOCX 与章节范围

### 2.4 PDF 阅读器（13 / 13）
FTS5 中文检索（**unicode61 + 应用层重叠 bigram + 短语查询**，因为 SQLite 自带分词器对中文全不可用）· 锚点重定位四态自愈 · 13 组快捷键 + 帮助浮层 · 目录 / 缩略图 / 页码跳转 · 纸/夜/护眼三主题 · 可折叠可拖宽侧栏 · 乐观更新 + 按页索引 · 后台索引队列 · 扫描版与加密 PDF 检测 · 高亮颜色 · 笔记导出 Markdown · 选段气泡修复 · **文档源抽象**（PDF / TXT / MD / EPUB 共用虚拟滚动、锚点、高亮层、命中层）+ 拖拽导入

### 2.5 设置与外观（7 / 7）
主题三选端到端接通 · 供应商高级项（代理 / 请求头 / 超时 / 并发）+ 按模型锁定上下文窗口 · 删除供应商级联清理 · 关于页（版本 / 目录 / 检查更新 / 诊断包）· 注册传 handle · 服务器地址校验 + 测试连接 · **原生 `window.confirm` 全仓归零**

---

## P2 社区与增长（18 / 18）

- **通知系统**：10 种通知，事件源复用积分引擎的 `award()`。通知与积分**各有各的去重键** —— 积分日上限吃掉的分不会顺带把通知也吃掉；审核类通知的 key 带动作时刻，「隐藏→恢复→再隐藏」该收三次
- **下架与回滚**：`visibility` 可回 `unpublished`；`PUT /novels/:id/current-version`。回滚**不写 `lastPublishedAt`、不记动态、不发积分** —— 否则回滚会把作品顶到「最新」最前并给关注者一条假更新
- **刷量防护**：fork 幂等 + 限流；举报要求登录 + 去重键 + 5/小时；`viewerKey` 绑 IP 前缀使轮换 `X-Client-Id` 失效；写端点与网页路由限流补齐
- **发现与检索**：标签目录（归一化**只降 ASCII 大小写**，与迁移回填的 SQLite `lower()` 对齐）· 用户搜索 · 想读书架 · 云端阅读进度 · 动态折叠 + 已读态 · 改名 301
- **网页阅读页**：全部分页（**200 章硬上限已删**）· `/browse` 与 `/tags` · robots / 分片 sitemap / canonical / JSON-LD / RSS · **PNG 封面**（`@resvg/resvg-js` + 自写极小 PNG 编码器兜底）· CTA 与 `/download` · 移动端单栏 · **零 JS 零 CSP 变更的阅读偏好**
- **留言与会话**：章节级留言 · 编辑（15 分钟窗口）· 点赞 · @提及（正则放 shared，服务端解析与桌面端渲染同源并有交叉断言）· 设备列表与单设备注销 · 登录恒定时间路径
- **许可与署名**：许可全文链接与 `-nc` 提示 · 机器可读署名块进 bundle 与导出 · 二创发布前强制展示原作署名（不可折叠不可跳过）

---

## P3 技术债与长期（12 / 12）

- **i18n**：三套状态标签表合并；**词典 1411 条 key，零引用为 0**；en 是真翻译不是占位；`t` 是惰性 Proxy（模块顶层引用与渲染时引用永远一致，根治「切语言不更新」）；**缺 key / 多 key 都编译期报错**
- **测试**：363 → 1001 例
- **可观测性**：服务端结构化请求日志 + `/health` 探 DB + `/health/ready` + Prometheus `/metrics` + 错误上报接口预留（未引 SDK）；桌面 `tauri-plugin-log` + **导出诊断包（钥匙串从头到尾没被读取）**
- **发布与更新**：`tauri-plugin-updater` + 签名 + release 工作流；单实例保护；窗口状态记忆
- **服务端架构**：限流与榜单缓存下沉共享表（算法从滑动日志换成**滑动窗口计数器**，行数上界是活跃主体数而非请求数）· 迁移加锁 · FTS5 · `TRUSTED_PROXIES` 接上 · **Postgres 决定不做并写清理由**
- **数据层小修**：`listMyLikes` 可见性下推 · 计数排序游标加稳定次键 · `listVersions` 分页 · lineage 确定性排序与截断标记 · N+1 消除 · token 估算两份实现合一
- **代码整理**：`ChatPage`/`AiDiscussPanel` 反向依赖消除 · 导航高亮改路由匹配 · 自写数据层 hook 迁移 24 个文件 · **无障碍 `aria-*` 从 5 处涨到 609 处**（`Dialog` 焦点陷阱、hover 删除按钮键盘可达、toast `aria-live`、`prefers-reduced-motion`）

---

## 需要人工处理的三件事

### 1. CSP 的 GUI 验证（P0-8）
CSP 从 `null` 改为严格策略，我们跑不了 GUI。以下每条要在 `tauri dev` 与 `tauri build` 各跑一次，devtools Console 出现任何 `Refused to …` 即为失败：

1. 导入并打开 PDF → 渲染正常 + 文字可选中
2. 打开含 JPEG2000 / JBIG2 图的 PDF（验 wasm）
3. 设置页「测试连接」+ 跑一次流式生成（Console 不应出现 `IPC custom protocol failed`）
4. 登录云端账号 + 浏览公共书房
5. 「打开数据目录」「去申请 Key」外链
6. EPUB / TXT / Markdown 阅读

> 背景：LLM 与云端请求全部走 `@tauri-apps/plugin-http`，它内部是 `invoke('plugin:http|fetch')`，由 Rust 端出网、不经过 webview 网络栈。所以 **`connect-src` 管不到供应商域名**，真正的出站白名单是 `src-tauri/capabilities/default.json` 的 `http:default` scope。`plugin-updater` 同理。

### 2. 自动更新的密钥与端点（P3 §4.4）
`tauri.conf.json` 的 `plugins.updater.endpoints` 目前是按 git user 猜的占位，`pubkey` 为空。按 `docs/RELEASE.md` §1 生成密钥对后填入。release 工作流在这两项缺失时会直接失败并给中文提示，不会产出「装了却更新不了」的包。

### 3. 内置价格表核对（P1 §2.1）
`novel/pricing.ts` 的 16 条默认价格标注了抓取时间 `2026-05`，是各供应商公开定价页的列表价。发版前请按最新定价核对。结构上它们是可改的默认值，不是硬编码事实。

### 部署依赖
Linux 服务器需安装中文字体（Debian/Ubuntu `fonts-noto-cjk`），否则 og:image 的 PNG 封面会渲成豆腐块。

---

## 明确不做的两条（附理由）

- **`countMode`（全部 / 仅汉字）**：删除而非接线。全链路字数口径是 `countZh`，目标字数、扩写/精简判定、预算重分配、提示词里的「本章约 N 字」、`char_count` 与服务端 hash 全按这一个口径。只改显示会让编辑器进度永远差 15%、永远到不了 100%，比无效开关更糟。
- **Postgres 切换**：README 那节已删并写清理由。「只需替换客户端」从来没成立过（`json_each`、`sqlite-core`、`VACUUM INTO`），上 FTS5 后又多了虚拟表与三个触发器；给每个自建用户强加一个有状态服务是负收益。README 里给了规模上限表与触顶时的正确顺序。
- **系统托盘**：macOS 上「关窗后还能回来」已由 Dock 图标 + `RunEvent::Reopen` 承担，再加菜单栏图标是第二个功能重复的入口。
- **v1 仅 macOS**：`bundle.targets` 从 `"all"` 收到 `["app","dmg"]`，`keyring` 移进 macOS 条件依赖，非 macOS 的密钥后端**显式报错而不做明文兜底**。补齐跨平台的五处改动清单在 `docs/RELEASE.md` §5。
