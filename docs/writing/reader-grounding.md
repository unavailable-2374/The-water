# 从作者意图到正文：实施与验证

本轮落实 2026-10-10 评审的第一批和第二批建议。以当前工作区源码为准，真实调用记录包含 HEAD、工作区 diff hash，以及新增源码 hash。未把历史 A/B 样稿当作本轮结果。

## 作者可使用的流程

| 建议 | 实现与入口 | 行为收益与代价 |
| --- | --- | --- |
| 只读正文的首次阅读 | 章节审稿、故事工作区“解读正文”；`novel/firstReading.ts`、`llm/prompts/firstReading.ts` | 第一遍只接收截至当前章的完整正文，记录目标、重要性、做法、期待、困惑与应保留的写法。第二遍才接收确认资料并比较意图。增加调用及长篇输入；前文缺失或窗口不足时明确失败，不用摘要冒充完整阅读。AI 推断有误判风险，不称为真实读者反馈。 |
| 文体与结构分开 | 创建向导的结构方法；`novel/docTypes.ts`、短篇/剧本模板 | 结构可以自选或留空；取消固定八拍、反转、暗夜、人数及升华要求。长篇允许生活与关系期待，不强制远期伏笔。作者仍需判断具体作品适合的方法。 |
| 滚动窗口人物动机 | `jobs/steps/sceneSteps.ts` 的 `planningReferences.characterIntents` | 提供全部已确认动机卡，覆盖后续才登场的人物；代价是输入增加，窗口不足仍报错。 |
| 核心关系阶段摘要 | `CanonEvent.relationshipState`、`summarizeStep.ts`、`common.ts` | 带原文依据保留改变、未改变、双方理解与下次互动边界；只在需要时维护，不强制每段关系填写。摘要仍是需要核对的归纳。 |
| 事实与人物理解分开 | `CanonEvent.epistemic/perspectiveId`、正文记忆投影 | 信念与证词保留归属，不进入世界事实；主观判断不能推进或回收实际伏笔。旧记录的未标注语义保持不变，不擅自重判历史。 |
| 跨章节结构修订 | 故事候选区“结构修订方案”；`novel/structuralRevision.ts` | 引用实际正文，给出不同方案、影响章节、保留项与主题轨迹。作者选择先产生计划候选，必要时独立大纲复审，采纳后再授权章节编辑。候选、正式正文与事实重建沿用现有边界。步骤增加，但避免一句心理解释掩盖前文根因。 |
| 同一事实的不同讲法 | 抽卡的叙述/关系/表达探索；`novel/storyExploration.ts` | 固定事件，比较视角、知情顺序、时间、距离、回应、边界、对白和节奏；独立比较实际样稿的保留与损失。有场景关联且审查支持的样稿可进入现有分支审阅，不能直接写入事实。模型比较不是文学效果证明。 |
| 大纲连接试写 | 计划审阅中的“正文验证”选项 | 没有建章节也可试写一到三个不确定场面，显示样稿与未验证内容。每份完整结果独立保存，后续调用失败不丢失已有样稿；失败不算整批完成。 |
| 候选逐卡可选 | `novel/storyOptions.ts`、`StoryOptionsPanel.tsx` | 有关键缺口的卡仍不能选；其他合格卡不会被整批拖住。卡间相似度保留提示，组合仍逐卡核对。 |
| 场景风格与对白 | `common.sceneTypeOf`、`styleReview.ts`、`characterDesign.ts` | 当前场景优先于整章位置选择范例；原创检查本作叙述声音，二创检查参照声音。对白追踪争取、拒绝、回应与决定权，允许闲聊与沉默。场景分类仍是规则辅助，无法替代作者判断。 |
| 固定版本人工评阅 | 故事候选区“人工评阅”；`novel/literaryEvaluation.ts` | 分离首次阅读、一致性核对、修订价值比较；版本与 hash 固定，比较包随机隐藏先后，人工意见只由作者提交。已回收一位读者的本轮反馈，首次阅读与两份讲法均有重要问题，文学效果未通过验收；不能声称质量普遍提升。 |

## 失效与并发保护

生成和保存之间核对正文、计划、动机卡等依赖，并在事务内比较工作稿指针与卡片修订。没有章节时也检查作品依赖。结构方案选择后保存正文基线与预期计划；采纳后如果正文或计划又变动，授权修订会拒绝旧方案。确认步骤不直接覆盖正文，跨章节编辑仍产生候选并进入审稿、事实重建及作者采纳流程。

## 真实阅读的观察边界

最初三次请求使用进程继承的凭证，均返回 `LLMError: HTTP 401: Invalid or revoked API key`，记录保留。安全比对发现 `~/.zshenv` 与 `apps/server/.env` 中同名变量的值不同；明确加载后者后，两阶段真实调用通过结构与逐字证据校验，见 [原始成功记录](evaluation/reader-grounding-real-20261010-server-env.json)。没有修改全局环境或保存密钥。

这次真实响应也有编辑层面的局限：第一遍把“未发现妨碍理解的困惑”列成 `obstructing`，第二遍将已传达的行动目标与没有充分传达的情感动机合并标成 `intentional_open`。这些不违反原文锚点契约，但影响报告价值。随后提示明确：没有实际困惑返回空数组、原因不能只重复分类、每个作者意图分别判断、有意留白必须有确认资料支持。新调用独立保留，不能覆盖原结果后宣称首次没有问题。

## 可复现验证

常规检查：`bun run typecheck`、`bun run test`、`bun run --cwd apps/desktop build`。

真实验收显式选择凭证来源；不指定 `REAL_EVAL_ENV_FILE` 时才使用进程的 `LUNAROUTE_API_KEY`。文件通过 dotenv 解析，不执行其中的 shell 表达式，不自动尝试多个凭证。输出路径必须尚不存在：

```sh
RUN_REAL_FIRST_READING=1 \
REAL_EVAL_ENV_FILE=/absolute/path/to/credential.env \
REAL_FIRST_READING_RECORD=/absolute/path/to/new-reading.json \
bun run --cwd apps/desktop test test/evaluation/realFirstReading.test.ts

RUN_REAL_STORY_DEVELOPMENT=1 \
REAL_EVAL_ENV_FILE=/absolute/path/to/credential.env \
REAL_STORY_DEVELOPMENT_RECORD=/absolute/path/to/new-development.json \
bun run --cwd apps/desktop test test/evaluation/realStoryDevelopment.test.ts
```

测试输入的小说是明确标为 TEST 的虚构夹具。真实模型响应、程序契约断言和人工文学判断分别记录；离线模拟响应仅用于确定性回归，不混入真实结果。原生界面的后续实机验收见 [验收记录](evaluation/reader-acceptance-20261010.md)；系统中文输入法未逐项复验，构建通过不冒充这项观察。

## 本轮验证结果

- 常规测试：桌面 1,099 项通过、12 项网络用例默认跳过；服务端 260 项通过、2 项网络用例默认跳过；共享包 38 项通过。类型检查、桌面生产构建与 `git diff --check` 通过。跳过项不算真实验证成功。
- [首次阅读复测](evaluation/reader-grounding-real-20261010-final.json)：两阶段真实调用与原文锚点校验通过。首次阅读输入 612 / 输出 7,222 tokens；意图对照输入 13,600 / 输出 14,056 tokens。输出包含供应商报告的推理用量，实际金额未知。对照分开报告了已呈现的自愿证词、有限谈话、人物谎言、明确留白，以及尚未可读出的依恋动机；不据此推断总体准确率。
- [第二批功能技术验收](evaluation/story-development-real-20261010.json)：4 次请求均 HTTP 200，实际生成三条结构修订路径、计划候选、三份叙述样稿及一份大纲试写。正文指针未变化、没有提交事实；结构与证据契约通过。三份叙述样稿被独立审查判为两项 conflict、一项 uncertain，因此不能称为可采纳样稿生成成功。
- [叙述探索补充失败记录](evaluation/story-narration-real-20261010.json)：移除旧结局干扰后，审查连续三次使用从 1 开始的编号，违反从 0 开始的数组索引，导致引文与样稿对应失败。模型响应完整保留，未改号冒充成功。修复输入契约：每份样稿显式提供 index，审查与比较引用同一编号，schema 按实际数量限制范围，继续严格核对逐字引文。

- [编号契约修复后的叙述复测](evaluation/story-narration-real-20261010-indexed.json)：2 次请求均 HTTP 200。三份实际样稿中两项 supported、一项 uncertain；将 supported 样稿保存为独立分支，原正文与正式指针未改变。生成输入 2,511 / 输出 4,751 tokens，独立审查输入 3,411 / 输出 7,276 tokens。未把 uncertain 卡改判通过，也未自动采纳分支。这个结果只证明该夹具的生成、审查、分支与隔离行为，不证明真实读者偏好。

这些是明确 TEST 夹具上的真实模型与程序行为证据。原生 TEST 界面已实机复验，见 [验收记录](evaluation/reader-acceptance-20261010.md)。人工匿名文学评阅已回收，原话见 [人工反馈](evaluation/reader-human-feedback-20261010.json)：X 更愿意读，但两篇的机制与意象分量均有问题。不能用程序或界面通过项替代文学验收。

人工反馈后的机制审查与关键推断证据修订、全部真实失败记录和最终检查，见 [人工反馈后复测](evaluation/reader-human-followup-20261010.md)。识别已知缺口不等于创作质量改善；新样稿没有合格候选，本轮文学效果仍未通过验收。
