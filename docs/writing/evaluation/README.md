# TEST 设定、真实调用与验收记录

首次阅读与第二批创作功能的本轮实现、凭证诊断及验证边界见 [从作者意图到正文](../reader-grounding.md)；历史记录保持原始版本归属。新增界面与分支门禁的 [原生验收记录](reader-acceptance-20261010.md) 附有待回收的首次阅读与匿名比较材料。

故事线抽卡的独立功能验收见 [2026-10-10 记录](story-options-20261010.md)，其中区分自动流程、原生界面夹具和真实模型文学观察。

## 结论边界

真实模型调用已执行，第一轮人工盲评已回收并揭盲：新版样稿 B 四项评分均高于旧版 A，但背景、动机与共情仍不足，**不能声称质量验收已完成或普遍质量已提升**。TEST 标记用于虚构设定和程序夹具，真实响应、模拟响应、自动断言与人工评分分开记录。所有失败运行保留，未把失败运行算成成功，也未用模型自评分代替人工质量评价。

## 固定条件与记录

- 供应商 Lunaroute，地址 `https://gw.lunaroute.com/v1`，用户指定模型 `deepseek-4.1-flash`。密钥仅在运行环境中使用，不进入仓库、请求日志或原生 TEST 应用。
- 输入为 [TEST-input.json](TEST-input.json)：三章悬疑故事，明确人物红线、跨章知识约束、步行时间与结局条件。每章目标 1,000 字。真实调用预算由用户授权不设上限，单次输出仍限制为配置上限 65,536 token，推理预留 32,000，窗口配置 1,048,576。[供应商能力记录](provider-capabilities.json) 表明模型声明最大输出为 262,144；65,536 是本组对照的实验配置，不是供应商硬上限。
- 写作与审查沿用产品步骤温度；基础叙事审查为 0.1。没有固定随机种子。每次运行都记录实际请求参数、原始响应、源码 HEAD、diff hash、未跟踪源码 hash/副本、数据库、审查与状态。
- 旧版对照来自修改前 HEAD。为让该推理模型有可比的输出机会，旧版增加同样的 32,000 推理输出预算适配，最高 65,536；旧版叙事/提交流程未替换。因此对照是“旧流程 + 相同推理预算适配”，不是逐字未改的旧传输代码。
- 完整原始记录位于本机 `~/.codex/validation/the-water-writing-20261008/outputs/`；模型响应日志不包含 Authorization 请求头。仓库中的 [observed-runs.json](observed-runs.json) 是从实际响应读取的 token 统计，不是成本估计。

## 探索性对照

| 运行 | 实际状态 | 请求数 | 输入 token | 输出 token |
| --- | --- | ---: | ---: | ---: |
| baseline-budgeted | 第三章设定审查 JSON 解析失败；三章正文已产生 | 23 | 56,310 | 201,952 |
| workbench-reference-validation | 三章审查、提取与提交完成 | 30 | 175,532 | 351,740 |

输出 token 包含供应商报告的推理 token。没有 Lunaroute 账单或该模型可靠价格配置，**实际金额未知**；`cost_cny=0` 且 `price_id=null` 不表示免费。请求数和 token 不能单独证明文学质量。

[匿名样稿 A](blind/A.txt)、[匿名样稿 B](blind/B.txt) 是上述两次运行的实际三章正文，未经润色。评阅要求与四维评分锚点见 [盲评说明](blind/README.md)。A/B 采用随机映射并封存 hash，人工评分前不揭盲。评分收到后才揭盲：A 为 baseline-budgeted，B 为 workbench-reference-validation；原始用户反馈保存在 [ratings.json](blind/ratings.json)，封存映射及稿件未修改。

| 样稿 | 情节成立 | 人物可信 | 连续性 | 表达 |
| --- | ---: | ---: | ---: | ---: |
| A | 2 | 2 | 3 | 3 |
| B | 3.5 | 3.5 | 4 | 4 |

用户认为 A 背景与刻画不足、意象堆砌；B 情节与表达更完整，但没有充分交代父亲蒙冤的经历及顾澄坚持洗清指控的原因，仍难共情。未提供单独的总体偏好、评分信心或逐字原文依据，不补造这些字段。

两份样稿是从开发记录中各选一份，其中新版来自多次修复后的完整运行；这存在选择偏倚，不是预注册的随机重复实验。即使人工盲评有偏好，也不足以推断普遍优势或统计显著。

此后代码修复了截断正文门禁、紧凑记忆快照、并发检查等问题，故这组样稿不冒充最终源码的产物。后续开发快照另行运行真实流程回归，具体版本以各目录的源码快照与 hash 为准；不会用新样稿偷偷替换已封存的盲评材料。`workbench-recovery-schema-reserve` 启动后还补齐了旧任务用完轮数时立即持久化计数的边界，以及非法设定校对 `verdict` 不得默认通过的校验。最终源码已通过对应自动测试，但该真实运行不冒充包含这些补丁的运行。

## 真实矛盾审查

使用相同模型对六个明确标记 TEST 的虚构矛盾进行真实审查：提前知情、动机断裂、时间矛盾、错误回收伏笔、越过结局、跨卷遗忘规则。断言要求正确问题类别、block 严重度及可定位的逐字证据。

首次六项都产生阻断，但伏笔错误回收归类为 `canon` 而不是 `thread`，严格分类断言 **5/6**；失败原始结果保留在 [real-narrative.json](real-narrative.json)。修正审查提示中的类别定义与重叠优先级后，同一组冻结输入复跑 **6/6**，记录在 [real-narrative-taxonomy.json](real-narrative-taxonomy.json)。这证明这六个案例的观察结果，不估计总体准确率、误报率或长篇文学质量。

| 运行 | 输入 token | 输出 token | 实际金额 |
| --- | ---: | ---: | --- |
| 首次分类审查 | 4,035 | 7,782 | 未知 |
| 分类规则修正后 | 4,773 | 10,012 | 未知 |

## 失败与修复记录

开发中的真实运行依次暴露 JSON 输出截断、事实原文锚点不匹配、章内事实依赖顺序、局部补丁跨越问题范围、无依据伏笔 ID 等问题。分别通过预算处理、逐字证据校验、章内 DAG、只修订阻断问题和引用/生命周期校验修复。原始失败目录保留，不筛掉后宣称首次成功。

`workbench-final` 复跑在调整第一章字数时收到 `finish_reason=length`，该响应的 34,000 个输出 token 全部用于推理，正文门禁报“正文输出预算耗尽，请增加最大输出预算后重试；未提交截断正文”。随后增加有界预算重试：扩大预算重新请求完整正文，最多两次，不越过配置上限或上下文容量；不会拼接截断响应，并累计全部已报告用量。随后 `workbench-adaptive-budget` 在第二章设定审查再次耗尽 JSON 输出预算（最后一次 42,000 输出 token 全部为推理）。JSON 与正文现共用预算增长规则，按实际完成的校验次数报告错误。

`workbench-recovery-unified-budget` 从保存的失败库复制件恢复，因局部补丁不覆盖问题证据而失败；已有正式章节保持不变。修订提示原先允许分开改相邻对白，与补丁校验不一致，现明确要求合并为覆盖证据的连续补丁，并返回具体范围错误。随后 `workbench-recovery-patch-contract` 完成局部修订，但第二章设定复审连续耗尽 34,500、65,536 输出 token（全部用于推理），仍未完成；已有正式章节再次核验保持不变。

这些运行还暴露了审稿证据应在调用修订前保存的问题，现已修复，并增加“修订请求失败仍显示阻断问题”的回归测试。自动修订轮数与版本原子保存，恢复不会重置两轮上限；初次新增轮数测试因表名错误失败，修正后对应 12 项测试和完整测试通过。发现该错误时主动停止了 `workbench-recovery-provider-cap`，保留中断记录；未完整收到的响应用量记为未知。随后以修正后的源码、262,144 输出上限运行 `workbench-recovery-provider-cap-fixed`，属于单独的补充恢复验证，不属于原固定预算的盲评对照。

`workbench-recovery-provider-cap-fixed` 仍失败：叙事审查第三次返回完整结果，但第二章独立设定校对连续耗尽 34,500、66,500、101,000 输出 token。这里 262,144 是配置上限，101,000 才是最后一次实际申请的预算；已有正式章节保持不变。下一组 `workbench-recovery-schema-reserve` 同时采用供应商声明支持的 `json_schema` 与 196,608 推理预留，保留 262,144 总输出上限；这些条件变化独立记录，不能混入原预算对照，也不能将任何结果归因于其中单一参数。

代码另修正了预算重试不应改变采样温度的行为，截断重试保留原温度，实际 JSON 校验失败的修复仍使用原有修复策略。这是参数一致性修正，不能据此认定先前耗尽的原因。[DeepSeek 官方说明](https://api-docs.deepseek.com/guides/thinking_mode/) 还指出其思考模式不支持温度参数；Lunaroute 的实际行为仍以请求与响应记录为准。

## 原生 Tauri WebView 验收

使用独立 bundle ID 的 TEST 应用与 TEST 数据库，生产作品库未迁移或改写。500 章、百万字、2,500 事实的 TEST 数据库通过实际应用的恢复入口安装。以下为实际 UI 操作观察，非脚本伪造输出：

| 项目 | 结果 |
| --- | --- |
| 500 章工程打开、章节/场景/助手布局 | 已观察 |
| 中文选区粘贴、撤销、自动保存 | 通过 |
| 编辑后工作稿与正式正文指针、内容隔离 | UI + SQLite 读取核验通过 |
| 原生恢复、缺失 WAL/SHM 边界、重启后读取 | 修复现有连接池关闭竞态后通过 |
| 中文输入法组合/候选选词 | 用户实机反馈中文输入正常；不是工具观察到的候选选词 |
| 最终构建中的流式候选、逐项采纳、冲突、专注模式 | 已实际观察流式预览、逐项采纳与撤销；重叠编辑明确冲突并保留候选；专注模式隐藏/恢复导航与助手 |

此前原生工具返回过 `cgWindowNotFound`；用户解锁后窗口可读取，后续验收继续。未保存前退出并重启的实机流程已显示 TEST 恢复日志，采纳恢复后创建新工作稿；正式指针与内容 hash 保持不变。光标续写使用实际编辑器按键定位，候选保存的 from/to 均为 71，采纳后插入第四行末；工具 AX 的 cursor_after 未可靠同步编辑器，未将那次定位当成功。用于后续界面传输测试的 localhost 服务响应明确标识 `TEST SIMULATED`，绝不混入真实质量样稿。

## 自动验证

最终常规验证：桌面 823 项通过、3 项真实网络用例默认跳过；服务端 250 项通过、1 项真实后端网络用例默认跳过；共享包 29 项通过；Rust 5 项通过。类型检查和 macOS Tauri debug bundle 构建通过。源码 hash、日志位置及未完成项目见 [verification.json](verification.json)。新网络测试通过环境变量单独执行，不能把默认跳过算成通过。

## 可复现命令

常规验证：`bun run typecheck`、`bun run test`、`cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --lib`。真实调用用环境变量启用，密钥由本地环境注入：

```sh
RUN_REAL_WRITING=1 WRITING_EVAL_VARIANT=workbench \
WRITING_EVAL_OUTPUT=/absolute/path/to/new-run \
bun run --filter desktop test test/evaluation/realWriting.test.ts

RUN_REAL_NARRATIVE=1 NARRATIVE_EVAL_OUTPUT=/absolute/path/to/new-review \
bun run --filter desktop test test/evaluation/realNarrative.test.ts

RUN_REAL_RESUME=1 WRITING_EVAL_RESUME_DB=/absolute/path/to/failed/database.sqlite \
WRITING_EVAL_OUTPUT=/absolute/path/to/new-recovery WRITING_EVAL_MAX_OUTPUT=262144 \
WRITING_EVAL_REASONING_RESERVE=196608 WRITING_EVAL_JSON_MODE=json_schema \
WRITING_EVAL_DEADLINE_MINUTES=180 \
bun run --filter desktop test test/evaluation/realResume.test.ts
```

三者均要求 `LUNAROUTE_API_KEY`；输出路径必须为新目录，避免覆盖原始证据。恢复用例只修改失败库的复制件，保留修改前后供应商配置。最大输出、推理预留、JSON 模式与运行时限均为可选的补充验证参数，不能与固定预算的盲评对照混算。到达时限时先停止并排空任务，再保存数据库和失败状态，不把超时算作完成。普通测试默认跳过真实网络调用。规模夹具由 `test/writing/scale.test.ts` 创建，均标为 TEST；其结果只证明契约和规模行为。

实现参考：[CodeMirror 系统指南](https://codemirror.net/docs/guide/)（事务与位置映射）、[DeepSeek Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/)（推理模式）。Lunaroute 的实际响应和模型能力以本次请求记录为准，不能用另一供应商的标价推断账单。

## 第二轮修复与真实验证（质量验收尚未完成）

上一组 schema-reserve 仍在供应商最大 262,144-token 请求下只返回推理，JSON 审查未完成。独立受控诊断保留同一输入与 schema：显式 low、温度 0.1 时 65,536 token 全部为推理、finish_reason=length；再仅改温度为 0.6，得到完整审查，输入 2,353、输出 5,730（推理 5,437），finish_reason=stop。这是一次观测，不证明 low 或温度能普遍消除循环。配置新增独立的 reasoning_effort；设定审查温度改为 0.6，并明确不对有歧义的依据反复推测，仍保留逐字证据和门禁。

小说正文统一要求开篇交代处境、任务与代价，重要选择呈现触发、反应与权衡，只使用已确认的背景，不提前揭示秘密。审校对背景与共情不足给出建议，不能凭偏好阻断。优点是正文可理解性进入生成与审校底座；代价是输入更长，修订与人工复核仍可能增加调用，提示改进本身不算质量证据。

任务恢复 `workbench-recovery-effort-sampling` 已完成全部审查响应，但两轮自动修订后仍存在阻断，状态为 awaiting_review；测试要求 completed 因而失败，不能计作全流程成功。已有正式第一章保持不变。剩余问题包括交接本提前出现、时序和补偿安排不成立。代理在独立 TEST 复制库写入明确标识的作者介入候选，新的 `workbench-recovery-author-intervention` 因叙事 JSON 三次耗尽而失败；没有清零修订计数、关闭审查或判定误报。这份代理撰写候选不是供应商模型输出，也不进入盲评。第二轮固定输入对照已结束：matched-baseline 三章完成，matched-workbench 在第二章叙事 JSON 耗尽时失败。[round2-protocol.json](round2-protocol.json) 记录统一模型、输入、单次供应商上限、推理预留与 low；不设总预算上限。首组技术预跑发现旧测试包装器保留 65,536 硬上限，已同时停止两组并保留中断证据，修正后才启动 matched 两组。不会按稿件质量筛选结果。第二轮匿名稿和人工评分尚未产生，不能提前声称改善。

更新后的叙事审校提示与显式 low 在同一六个 TEST 矛盾案例上真实复测 **6/6**，记录见 [real-narrative-grounding.json](real-narrative-grounding.json)，仍不代表文学质量或总体准确率。

审稿位置契约随后改为模型只返回唯一连续引文，程序按 UTF-16 计算并校验位置；新结论的依据和建议各最多 800 字，旧报告仍可读取，不会截断旧证据。对应中文/emoji/缺失/重复引文断言与完整常规测试通过；同一六类真实案例复测 **6/6**，见 [real-narrative-quote-location.json](real-narrative-quote-location.json)。文学对照在这次契约变化前已冻结，保留其源码边界；最终源码另以同一 TEST 介入候选执行 `workbench-recovery-quote-location`，不冒充旧稿由最终源码生成。


恢复运行 `workbench-recovery-quote-location` 已结束于 awaiting_review：第二章通过审校并提交，第三章局部修订的补丁范围没有覆盖问题证据，三次结构校验失败后保留审稿并等待处理。先前正式章节均保持不变。这证明门禁保留生效，不证明全流程成功；尚未产生最终版本公平的完整三章盲评对照。

## Mastra 后端模型服务验收

服务端已接入固定 Lunaroute 模型任务，默认客户端无需供应商密钥。配置与尚未迁移的章节编排边界见 [server-harness.md](../server-harness.md)。新增契约测试明确标记 TEST SIMULATED；真实纯文本与 JSON 接口调用分别见 [harness-real-final.json](harness-real-final.json)、[harness-real-json.json](harness-real-json.json)。原生 TEST WebView 登录、读取模型配置、生成并显示真实答复已观察；此前构建重复读取曾受 `AXError.cannotComplete` / `timeoutReached` 阻塞，未冒充通过。详情、完整测试与源码 hash 见 [harness-verification.json](harness-verification.json)。这些接口记录不属于文学质量盲评。

最终新版原生复验已完成，见 [harness-native-isolation.json](harness-native-isolation.json)：TEST 登录、重启读取独立凭据、真实模型返回“隔离后端连接正常。”（输入 67 / 输出 56 tokens）、等待超时后无资源编号错误、TEST 退出登录均已观察。此前工具阻塞记录保留为历史，不代表当前仍阻塞。此验收不包含生产签名部署或文学质量结论。

## 当前执行引擎：Pi

已按用户要求切换 Pi 1.1.0（agent-core / pi-ai），Mastra 运行时依赖移除。此前 Mastra 样稿与接口记录保持原始归属，不改名为 Pi 数据。当前检查为桌面 823 项、共享包 31 项、服务端 252 项通过；默认跳过真实网络测试，真实 Pi 纯文本、严格 JSON 与原生调用另行执行并通过。配置、源码 hash 与边界见 [pi-verification.json](pi-verification.json) 及 [server-harness.md](../server-harness.md)。这次切换尚未产生新的文学质量盲评结果。

## 本轮人工验收反馈（2026-10-10）

已收到用户对冻结首次阅读和 X/Y 讲法的实际意见，逐字保存于 [reader-human-feedback-20261010.json](reader-human-feedback-20261010.json)。X 更愿意读不等于质量合格：首次阅读缺少动机与前因，X 的结尾意象分量不足，两稿的道具与签字权因果均受到质疑。没有读到合作等于原谅，仅说明本位读者的这一项理解。原始匿名材料与历史模型响应不修改。

因此独立样稿审查新增事实一致性之外的因果机制判断：先只读样稿正文，再独立核对固定事实，并校验其唯一连续原文证据；历史仅核对事实的报告仍可阅读，但不能直接授权新分支，可对原样稿复审。缺少机制与已明确矛盾分开；审美偏好或未改变意义的重复意象只记可能损失，不单独阻断。写作、规划、审稿共用机制约束，首次阅读允许明确回答没有期待，不把未解之谜自动当吸引力；关键新认识单独记录 inferenceChecks，将读者兴趣与推断依据分开，旧报告可读但需重审才能复用。多一次审查与保守门禁会增加作者处理成本，仍可能误判；新增规则不代表新稿已获读者认可。

本轮全部复审、真实生成失败、最终诊断测试与剩余误判见 [人工反馈后复测](reader-human-followup-20261010.md)。文学效果仍未通过验收。
