# 统一创作助手

本实现把全局聊天和创作页助手接到同一个桌面端执行器，保留手动编辑。模型只返回经 Zod 校验的回答、澄清或操作；作品写入、任务完成、提交及撤销由本地业务服务和 SQLite 记录决定。账号、应用设置及公共区仍使用原入口。

## 使用与行为

在“创作助手”描述构思或明确修改要求；选择已有作品继续其独立会话。创作页的同名按钮打开共享侧栏，窗口宽度不超过 1100px 时使用抽屉。输入区显示作品、章节、选区、所选故事对象和引用文档。单纯讨论不执行写入，修改后结果卡提供对象摘要、正文前后对照、位置和撤销。

“写完整部作品”会保存目标、约束、来源消息和作品绑定，连续规划、写作、独立审查、事实提取和提交。只自动采纳本任务生成的候选。锁定、失效证据、预算、模型失败、范围冲突或无法解决的审查问题会阻断并显示真实状态。可以直接发送“暂停”“继续”“停止”，也可用结果卡控制；关闭侧栏或切页不停止任务。应用重启后保留暂停状态，必须显式恢复。

同一作品的新消息会先暂停正在执行的旧轮次，以串行处理修改与澄清；旧目标和已完成内容保留，可恢复原任务。切换作品只是切换会话，不会把原任务移到新作品。

任务执行前会同步已注册编辑器，操作提交检查作品修订号和业务依赖。撤销按逆序恢复对象，并使关联审查、事实和记忆失效，后续复审/记忆修复继续走既有门禁。整书修订号提供保守的并发保护：即使无关的同书编辑，也可能要求重新检查后再执行或撤销，避免覆盖作者新内容。

## 能力清单

参数与判别联合来自 `packages/shared/src/assistant.ts`，说明来自 `src/assistant/catalog.ts`；下表覆盖注册表全部 44 项操作。业务模块路径均相对 `apps/desktop/src`。注册表覆盖不等同于每项能力均完成真实模型验收；验证范围见下节。

| 创作页面能力 | 助手操作 | 共用业务入口 / 状态依据 |
|---|---|---|
| 浏览作品、章节、版本、资料、事实、任务及候选 | `inspect` | 各仓库只读查询，返回真实 ID / 版本 / hash |
| 新建作品、编辑创作要求 | `create_work`, `edit_work` | `db/repos/novelsRepo.ts` |
| 导入原稿 | `import_manuscript` | `novel/importText.ts`；原生选文件、原子导入 |
| TXT / Markdown / EPUB / DOCX 导出 | `export_work` | `novel/export.ts`；原生保存位置、正式稿门禁 |
| 人物、世界设定、主线、大纲情节点及删除 | `character`, `setting`, `arc`, `beat`, `remove_entity` | `db/repos/storylineRepo.ts`；锁定与引用校验 |
| 文风、二创要求、作者附加要求 | `style`, `derivative`, `author_note` | `storylineRepo.ts`, `llm/prompts/authorNote.ts` |
| 构思、分卷、场景、人物意图、伏笔卡和章节计划 | `card`, `chapter_plan` | `writingRepo.ts`, `chaptersRepo.ts` |
| 章节排序、拆分、合并与取消合并 | `reorder_chapters`, `split_chapter`, `merge_chapters`, `cancel_merge` | `chapterStructureRepo.ts`；合并正式稿仍需审查提交 |
| 卡片排序、场景拆分与合并 | `reorder_cards`, `split_scene`, `merge_scenes` | `writingRepo.ts` |
| 双时间线、因果、成长、秘密知情、锚点、偏好及锁定 | `graph` | `storyGraphRepo.ts`；完整图版本与依赖校验 |
| 选区修改、插入、续写、扩写、精简及版本恢复 | `edit_text`, `restore_version` | `chaptersRepo.ts`；精确 UTF-16 范围及基础版本/hash |
| 大纲/章节规划、写作、跨章改写、审查、事实提取及提交 | `plan`, `write`, `rewrite`, `review`, `finish_work` | `jobs/planner.ts`, `jobs/steps/*`；复用质量门禁 |
| 提取文风 | `extract_style` | 既有 `extract_style` 任务 |
| 采纳/丢弃规划、正文及待采纳改写 | `candidate`, `rewrite_candidate` | 原候选服务；自动采纳检查任务归属 |
| 失效记忆修复 | `repair_memory` | `db/repos/jobMemoryRepair.ts` |
| 阅读正文、场景及阅读诊断候选、声音建议 | `read_prose`, `reading_candidate`, `suggest_voice` | `novel/storyIntelligence.ts` |
| 剧情试验创建、编辑、试写、合并 | `branch_create`, `branch_edit`, `branch_sample`, `branch_merge` | `novel/storyBranches.ts` |
| 恢复故事工作台历史改动 | `restore_story_change` | `storyGraphRepo.ts` 原依赖检查 |
| 暂停、恢复、停止任务或助手轮次 | `task` | 任务系统和助手持久化状态 |
| 撤销单项操作或整轮 | `undo` | `assistant/repository.ts` 行变更账本与逆序依赖校验 |

引用资料由输入区选择已有文档页面，保留文档标题、文件 hash 与正文。未来规划、工作稿、正式事实和外部资料分开提供；引用内容不授予执行权限。必需内容超出模型窗口会明确阻断，不截去作者约束。

## 持久化与恢复契约

- 第 12 版迁移注册于 Rust、备份版本与测试数据库。旧会话与消息保留只读查看，不自动登记为助手会话、不重放历史指令。
- `assistant_sessions` 绑定作品会话；`assistant_runs` 保存来源消息、上下文、目标、约束与后台任务；`assistant_operations` 保存参数、意图、完成标记、基础/结果修订号与实际结果；`assistant_row_changes` 保存逐行撤销依据。
- SQLite 审计触发器只在同一原子事务中的助手写入标记下记账。业务写入、结果与账本共同提交或回滚；不可变正文版本作为差异与撤销引用保留。
- 请求 ID 和操作序号幂等。页面切换不改变正在执行的作品归属。中断的外部导出不能由数据库证明文件是否写完，会要求检查目标后重新明确请求，不自动重复外部副作用。
- 后台操作的 `complete_after` 标记持久化；最终操作完成后直接结束本轮，不再让模型重复已完成的任务。本轮承诺正式提交的章节在最终完成前再次检查，后续规划使证据失效时，先复审、提取与提交。
- 模型调用继续使用既有服务端/自配置供应商、模型用途、用量和预算机制；规划调用计费，失败且无法确定 token 数的用量仍标未知。没有新增远程作品写入接口。
- 模型证据引用由本地原文定位；可选位置只有逐字匹配才被接受。错误位置仅在引文唯一时重定位，缺失/歧义引用拒绝。存储和提交仍要求非空真实证据范围。

## 验证记录

最终检查记录见 [assistant-verification-20261010.json](evaluation/assistant-verification-20261010.json)：全工作区 **1,284 项通过、9 项跳过、0 项失败**（shared 38、server 260、desktop 986）；其中助手专项 25 项通过。全工作区类型检查、Rust `cargo check`、8 项 Rust 测试和未签名 macOS 桌面构建通过。默认跳过的真实/外部依赖测试不能计为通过；本次另行启用的真实助手闭环结果单独记录。

自动化夹具明确标为 **TEST / SIMULATED**，验证编排和门禁，不代表文学质量。助手专项覆盖：纯讨论、历史不重放、完整写作链、同名澄清、幂等、事务回滚、锁定、跨作品隔离、选区边界、版本冲突、逆序撤销、撤销冲突、历史候选自动采纳拒绝、持久化停止、重启暂停、未知用量、重复决策修复、后台完成标记和最终提交证据。

真实模型使用隔离 TEST 小说和已有 DeepSeek 配置。失败证据完整保留，没有用模拟结果替代：

| 记录 | 实际观察 |
|---|---|
| `evaluation/assistant-real-20261009.json`, `assistant-real-20261009-retry.json` | Lunaroute 凭据返回 HTTP 401，未生成成功结果 |
| `evaluation/assistant-real-deepseek-20261009.json` | 真实规划/正文已生成，审查 JSON 校验阻断 |
| `evaluation/assistant-real-deepseek-schema-20261009.json` | 初次创作审查/提取/提交通过，后续人物修改遇到重复决策保护 |
| `evaluation/assistant-real-deepseek-final-20261009.json` | 揭示后台完成标记丢失和完成判定缺口：复审提交后额外规划使证据失效；测试失败 |
| `evaluation/assistant-real-completion-gate-20261009.json` | 事实提取的模型位置为零范围，提交被阻断；据此修正模型输入与本地证据定位的边界 |
| `evaluation/assistant-real-evidence-20261010.json` | **通过**：两个对话轮次，首次创建/规划/写作/审查/事实提取/提交，随后改人物及相关正文并再次提交，最后真实导出渲染。31 次请求记录、25 条聚合用量、2 次审查、2 次章节提交；最终 `final / valid` 且工作版本等于已提交版本，导出文本 827 字符 |
| `evaluation/assistant-native-initial-20261009.json` | 早期原生验收含明确标注的 SIMULATED 编辑器夹具，揭示正文刷新问题 |
| `evaluation/assistant-native-qa-20261009.json` | 真实对话新建、生成、审查、提取、提交、原生 TXT 导出；暂停后重启不自启；恢复后跨页继续；中英文；选区只改两个字并即时刷新；撤销后原文恢复、记忆失效 |
| `evaluation/assistant-native-narrow-20261010.json` | 最后构建在 1000×760 窗口中显示 448px 贴右全高抽屉，共享会话、单一标题、可见输入和结果、Esc 关闭；真实纯讨论后作品修订号仍为 1、没有新增写入操作；保存对应源码 SHA-256 |

原生 QA 记录注明对应构建边界，不能代替后续修改的回归。测试小说内容、模型输出和引用可用于复核功能，但这些短样本不证明长篇稳定性、事实判断准确率或文学质量。

本次行为收益是统一入口、可追踪写入、可撤销和严格提交证据；代价是保守冲突检查可能拒绝无关的同书并发编辑，规划变化引起的重新审查会增加模型调用。外部文件写入无法与 SQLite 形成单一事务，中断时明确保留不确定性。真实验收还暴露了模型重复决策、缺字段、错误位置等失败，保留失败记录和有限修复次数，不承诺模型总能独立完成。

可复现命令（真实测试会调用配置的模型，输出文件必须不存在）：

```sh
bun run typecheck
bun run test
cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
RUN_REAL_ASSISTANT=1 REAL_ASSISTANT_RECORD=/absolute/path/new-evidence.json bun run --cwd apps/desktop test test/evaluation/realAssistant.test.ts
bun run --cwd apps/desktop tauri build --debug --bundles app --no-sign --config '{"productName":"The Water Assistant TEST","identifier":"com.thewater.assistant-test","bundle":{"createUpdaterArtifacts":false}}'
```

未签名调试 `.app` 用于本地隔离验收；不涉及生产安装、外部部署或发布。

验收结束后已清理本轮三个隔离 TEST 应用、各自数据库/日志目录和临时导出文件；成功与失败的原始证据、构建/回归日志和源码校验值保留在 `evaluation/assistant-*.json`。已有未提交改动保留，未提交 Git commit。
