# 后端写作 harness：Pi 已启用

当前引擎为 Pi，固定依赖 `@earendil-works/pi-agent-core 1.1.0` 和 `@earendil-works/pi-ai 1.1.0`。Mastra 运行时依赖已移除。模型请求实际经过 Pi 的 Agent 执行循环与事件订阅；不是只更改显示名称。当前未启用实验性的 pi-durable。

实现见 `apps/server/src/modules/writing/piInference.ts` 与 `harness.ts`。参考 [Pi Agent 官方文档](https://github.com/earendil-works/pi/blob/main/packages/agent/README.md)。模型仍为开发者配置的 Lunaroute / deepseek-4.1-flash，用户只需自己的账号登录，不提供供应商密钥。

## 已实现与边界

后端执行持久队列 → 账号/版本绑定/容量/配置校验 → Pi Agent 单轮推理 → 保存真实输出事件和供应商用量。SQLite 的 writing_tasks / writing_task_events 是任务恢复与事件回放的权威存储。Pi Agent 的消息状态仅在单次任务内存在，完成后释放；不自动压缩必需资料，不自动新增推理轮次，不启用文件、shell 或浏览器工具。

Pi 使用项目已有的固定供应商 streamFn 适配器，保留原始 system/user/assistant 消息顺序、JSON Schema、停止词、温度、输出预算、推理预留与断流检查。价格或用量未知时不记免费或零消耗；Pi 临时内存中无法表示可空数值的字段使用 NaN 标识未知，不作为测量结果写入任务记录。公开记录只取供应商实际报告值。

HTTP 断开不取消后端任务；客户端通过幂等键和任务 ID 重连回放。双 worker 的租约与并发控制仍由同一 SQLite 事务执行。运行中取消会中止上游；过期运行租约标记 interrupted，不自动重发结果未知的付费请求。账号权限、正文版本/hash/依赖绑定、作者采纳与本地原子提交继续有效。

**章节场景规划、审校修订、事实提取和正式提交仍由桌面流水线编排。** 退出桌面后，已发送的单次模型请求继续，后续章节步骤不会自行启动。本次切换不等于完整云端连续写作迁移，也不代表写作质量验收完成。

## 配置与启动

开发者在被 Git 忽略的 apps/server/.env（本机权限 0600）或服务管理器中配置：

```dotenv
WRITING_HARNESS_ENABLED=1
LUNAROUTE_API_KEY=
WRITING_MODEL=deepseek-4.1-flash
WRITING_CONCURRENCY=2
WRITING_RETENTION_HOURS=24
WRITING_MAX_OUTPUT_TOKENS=262144
WRITING_REASONING_TOKENS=32000
WRITING_REASONING_EFFORT=low
WRITING_JSON_MODE=json_schema
```

示例密钥留空，实际密钥仅在后端。进程环境优先于 .env；本机曾有不同且失效的继承环境密钥，因此本次使用 `env -u LUNAROUTE_API_KEY bun src/index.ts` 读取已配置的开发者密钥。生产服务应直接提供正确密钥。没有总费用预算上限；单次容量、队列与并发限制仍有效。

Pi 任务全部保存于 DATABASE_URL，现有 SQLite 备份包含任务和事件。旧 WRITING_HARNESS_STORAGE 仅允许留空或指向同一个 DATABASE_URL；配置独立存储时明确报错，避免假称另一个文件仍被使用。旧 Mastra 表保留以兼容已有库，不创建新 Mastra 快照；同库过期任务清理会一并删除对应 writing-inference 的旧快照，不清理其他工作流。旧独立 Mastra 文件由部署方按备份保留策略管理。

旧完成任务仍可在原保留期内读取。引擎变化属于服务配置变化，旧排队任务会通过输入配置 hash 检查明确失败，不静默重新发起付费调用。客户端须使用本次构建；新的能力契约接受 pi 与历史 mastra，新服务只报告 pi。旧版只认识 mastra 的客户端须升级。

本机开发服务 localhost:8787 已切换 Pi；尚未部署外部生产服务。

## Topic-tree 接入（2026-10-09）

已接入真正的 `@earendil-works/pi-coding-agent@1.1.0` 会话宿主和 [pi-topic-tree](https://github.com/unavailable-2374/pi-topic-tree) 0.2.0 扩展。MIT 源码固定在 commit `0902401d01e8cd04de309413f3dba258cb385a84`，来源与适配清单位于 `src/modules/writing/topic-tree/vendor/UPSTREAM.json`。这不是重新实现一个名字相同的检索器。

桌面小说任务的 writing / styleReview / consistency 请求携带 `topicTree` 范围：作品 ID、adopted 正式稿分支、用途、当前已确认故事结构/创作要求/作者附加指令 hash 和当前章节号。非小说、规划、实验方案 API 和旧无范围客户端保持单轮推理。原始工作记录按账号、作品、方案、用途和作者上下文版本隔离；同一范围的任务在 SQLite 领取事务中串行。会话保存于 DATABASE_URL，完成任务与会话快照原子提交；失败/取消不提交新记忆。重建宿主从 SQLite 恢复，回头处理前章不读取后章快照；同章不同候选正文或依赖 hash 不读取旧候选快照。当前正文事实仍由正文 ledger、当前请求与版本绑定提供，历史输出不是事实。

使用上游 thin 投影：最近两轮保持原文，较早记录分类为主题并隐藏；模型需要准确细节时调用真实 `recall_topic`（list/get/search，含中文关键词检索）读取原始会话。摘要只是导航，抽取出的 globalFacts 不提升为确认设定；本次必需资料与作者锁定规则常驻。禁用文件、shell、网络等 coding-agent 内置工具，仅开放历史召回；不加载用户全局扩展、技能、AGENTS 或配置文件。

主调用、工具后续调用、分类和摘要全部使用开发者配置的 Lunaroute 模型并汇总实际供应商 usage。单任务最多 16 次模型调用，这是防止无终止工具循环的执行上限，不是小说章节/字数配额。供应商缺失任何调用的 usage 时，任务总用量标为未知，桌面仅记已报告小计、费用显示未知，不能当作完整账单。只发布工具循环后的最终回答，避免中间说明混入正文/JSON；代价是正文预览要等到本次会话完成，维护调用也增加延迟与费用。分类或摘要失败会明确失败，不合成分类成功或 General 占位结果。

任务事件默认保留 24 小时；私有会话快照另用 `WRITING_MEMORY_RETENTION_DAYS`（默认 90 天，按最近成功更新计算）清理。它们包含私人输入和模型输出，随服务数据库备份，应遵循相同访问与保留策略。能力接口返回 `topicTree.enabled/version/maxModelCalls/scopeRequired`。本次是本机接入，桌面仍负责章节工作流编排，并不宣称整个创作工作流已迁往云端。

真实 TEST 验收通过认证任务接口执行四轮模型调用：最早回合隐藏后，实际调用 recall_topic 搜索原文并正确取回 TEST 密语，SQLite 留存工具结果与主题记录。证据存于 `~/.codex/validation/the-water-topic-tree-20261009/real-topic-tree.json`。这是会话执行与召回证据；小说连续性、伏笔安排或文学质量改善仍须独立评阅。接入不会替作者采纳计划或恢复暂停的生产写作任务。

## 私有接口

全部接口位于 /api/v1，要求登录；提交任务另要求邮箱验证。

- GET /writing/capabilities：返回 engine: pi，不返回供应商密钥。
- POST /writing/tasks：必须携带 Idempotency-Key，请求不能覆盖上游地址、密钥、模型或推理强度。
- GET /writing/tasks/:id?after=N：仅所有者读取，每页最多 100 个连续序号事件。
- DELETE /writing/tasks/:id：所有者取消，重复取消保持相同终态。

终态清除输入正文；输出事件默认保留 24 小时。必需资料超窗、异常断流或容量超限明确失败，不删设定继续生成；length 保留真实截断原因。一般错误不回显上游可能含凭据或私人原文的响应体。

## 验收

[Pi 验收记录](evaluation/pi-verification.json)记录测试、源码 hash 与日志位置：

- TEST SIMULATED 契约覆盖认证、所有者权限、准确上下文、单轮调用、绑定、幂等、磁盘重建、并发、取消、崩溃租约、缺结束标记、未知用量、保留期和旧快照清理。
- [真实纯文本](evaluation/pi-real-smoke.json)与[严格 JSON](evaluation/pi-real-json.json)通过 Pi Agent、Lunaroute 和认证 API，输入明确标记 TEST。
- [原生 WebView](evaluation/pi-native.json)实际显示“Pi 后端已启用。”，后端完成记录输入 63 / 输出 48 tokens；能力接口确认 engine: pi。

这些是执行与接口证据，不是小说质量提升证据。旧 Mastra 实验结果保留原始名称，不能改名成 Pi 结果；原始验收记录见 harness-verification.json。文学质量待办见 evaluation/README.md。

## TEST 凭据与 HTTP 生命周期

钥匙串读、写、删除均使用当前 bundle identifier。正式版为 com.thewater.desktop；最终 TEST 为 com.thewater.finalacceptance20261008，不回退或复制正式凭据。TEST debug 为 ad-hoc 签名，重编译后访问上一构建的 TEST 凭据可能再次触发 macOS 授权；每次重建前应退出 TEST 账号。此次 Pi 验收后已退出 TEST 登录，未操作正式凭据。

REST 与模型传输在响应头到达后停止向已释放的请求 RID 转发取消；REST 仍可取消正在读取的正文。已通过对应 TEST 生命周期回归，并在本次 Pi 原生请求后未观察到延迟资源编号错误。生产签名与外部部署验收仍未完成。
