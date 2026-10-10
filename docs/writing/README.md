# 写作标准化框架（The-Water Writing Framework）

本轮首次阅读、结构修订、叙述探索及人工评阅的实现与验收见 [从作者意图到正文](reader-grounding.md)。

> 目标：把"写什么、怎么写、写成什么味道"三件事全部结构化，让 The-Water 的每一次生成、改写、二创都跑在同一套可审计的流程上，而不是靠一句自由文本的"风格"字段。
>
> 本目录是**规范与模版**，不是代码。落地到代码的映射见 [§7 落地到 The-Water](#7-落地到-the-water)。

题材差异与混合题材按[题材准备与试写](templates/genre-preparation.md)执行：悬疑按作品承诺区分公平程度，都市允许已确认异能，幻想不预设统一境界，新增日常／治愈。题材指导不等于本书事实，全部所选题材规则进入规划与正文。

情节设计按[因果、人物与余味指南](templates/plot-design.md)执行：区分题材体验与主题问题，将节点连接为条件、行动、结果与持续后果；反转同时解释过去并影响未来，结尾兑现已建立的重要承诺。`plotDesign.ts` 为规划、正文和审稿提供同源指导，不用悲剧、反转数量、晦涩或故意落空衡量文学完成度。

人物设计按[角色卡的风格、复杂动机与自我保护指南](templates/character-card.md#风格复杂动机与自我保护)落实到现有字段，并通过[场景选择与后果](templates/scene-card.md)进入正文。`characterDesign.ts` 统一提供规划、写作与审稿指导，覆盖大纲、各范围故事候选、滚动场景、正文/改写/篇幅调整、创作助手及工作台诊断。人物可有多重真实动机和关系差异，不默认添加创伤，不强制治愈；审稿按原文和已确认资料判断，文学层次建议本身不构成阻断。自动化测试只能证明指导接入及既有门禁契约，不能证明生成的文学质量提高。

长篇生成现按[阅读体验与因果兑现指南](templates/long-webnovel.md)执行：创作说明可编辑体验、独特方式、限制、首篇选择与后果；大纲、章节表、场景规划和正文共用指南，新大纲必须给出故事发动机制、结束条件及主要人物的恐惧、信念、应对习惯和独立目标。场景明确读者关切、人物选择、理由、后果与前后变化。小说短稿不再自动补描写凑字数；审稿将事实冲突、需要修订的故事推进和个人文风偏好分开处理。旧的固定黄金三章、统一爽点/悬念节奏不再作为长篇通用硬性要求。契约测试不代表文学质量或追读率提升。

当前长篇工作台的版本、门禁、记忆、共享与迁移契约见 [workbench.md](workbench.md)；真实生成及验收证据见 [evaluation/README.md](evaluation/README.md)。与旧行为描述冲突时，以工作台契约及实现为准。

作者掌舵的地图、双时间线、正文关联、范围委托、剧情试验与续作流程见 [故事工作台](story-workspace.md)，其中记录了迁移、共享边界和本次功能验收证据。

对话式新建、规划、写作、修改、审查、导出和可撤销执行见 [统一创作助手](unified-assistant.md)，包含 44 项操作清单、迁移与恢复契约，以及 TEST / SIMULATED 和真实模型验收的边界。

四种范围的候选生成、比较、保留重抽、作者选择与原子采纳见 [故事线抽卡](story-options.md)；流程验证与文学质量边界分别记录。

## 目录

1. [调研结论：GitHub 写作仓库吸收了什么](#1-调研结论)
2. [通用写作流程（九阶段）](#2-通用写作流程)
3. [文章类型 × 框架 × 模版](#3-文章类型--框架--模版)
3.1 [三层词条：通用 / 题材包 / 作品](#31-三层词条通用--题材包--作品)
4. [文风规格 StyleProfile：把"文风"变成可测、可注入、可校验的对象](#4-文风规格-styleprofile)
5. [二创协议：如何保持原著的味道](#5-二创协议)
6. [质检规则与 AI 味禁用清单](#6-质检规则与-ai-味禁用清单)
7. [落地到 The-Water](#7-落地到-the-water)

模版文件：`templates/`（每种文章类型一份、角色卡、世界观条目、StyleProfile 示例）；词表：`lexicon/`（AI 味禁用词、句式，JSON 可直接被代码读取）。

---

## 1. 调研结论

调研覆盖四个方向、约 45 个仓库/论文（2026-09-01）。下面只保留"对 The-Water 有直接用处"的结论，完整仓库清单见 [research-notes.md](research-notes.md)。

### 1.1 长篇 AI 小说生成器：架构已经收敛

| 仓库 | 吸收点 |
|---|---|
| [lingfengQAQ/webnovel-writer](https://github.com/lingfengQAQ/webnovel-writer) | **提交链**：每章通过阻断式审查（爽点/一致性/节奏/人物偏离）后才 `CHAPTER_COMMIT`，只有已提交的事实才能进入状态；摘要、索引、向量库都是主链的派生只读视图。伏笔当"债务"追踪：登记→推进→回收。 |
| [RhythmicWave/NovelForge](https://github.com/RhythmicWave/NovelForge) | **Schema-first 卡片**：每种卡片（梗概/世界观/角色/场景/组织/分卷/章节/金手指/审核）有 JSON Schema，AI 输出必须校验通过；`@卡片名`、`@type:角色卡` 等 DSL 精确指定注入哪些上下文。 |
| [SillyTavern Character Card V2 + World Info](https://github.com/malfoyslastname/character-card-spec-v2) | **唯一有正式互操作规范的记忆机制**：lorebook 条目 = 触发词 + 内容 + 优先级 + token 预算 + 常驻标记 + 递归触发。比向量检索更可控、可解释、用户可编辑。 |
| [Re3](https://github.com/yangkevin2/emnlp22-re3-story-generation) / [DOC](https://github.com/yangkevin2/doc-story-generation) | **生成与校验分离**：独立 reranker/entailment checker 检测人物设定与情节矛盾，比让主模型"自己保证一致"有效；**大纲颗粒度是一致性的最大杠杆**（三层大纲比一层大纲偏离小得多）。 |
| [MaoXiaoYuZ/Long-Novel-GPT](https://github.com/MaoXiaoYuZ/Long-Novel-GPT) / [MaliangAINovalWriter](https://github.com/Deng-m1/MaliangAINovalWriter) | **拆书**作为独立入口：从已有文本反推纲要、叙事方式、文风特点、用词习惯，存入知识库供续写复用。这正是二创 fork 的第一步。 |
| [wordflowlab/novel-writer](https://github.com/wordflowlab/novel-writer) | 文风与一致性检查都做成**可插拔命令/插件**（`/plot-check`、`/timeline`、`/authenticity-audit`、风格模仿插件），不硬编码在生成主链上。 |
| [google-deepmind/dramatron](https://github.com/google-deepmind/dramatron) | log line → 角色 → 情节 → 地点 → 对白的严格层级 prompt chaining；诚实的"人机协作"定位与免责声明。 |

**行业空白（也是 The-Water 的差异化机会）**：
1. 文风几乎全靠"prompt 里写一句话"或"模仿某作家"，没有一个项目给出可拆解、可复用、可对比的结构化文风描述。
2. 二创/续写场景没人做"风格漂移检测"：生成后不对比原著风格档案，漂了也不知道。
3. 负面清单（禁止套路、禁用口头禅、AI 味黑名单）几乎无人系统化。
4. 一致性状态多为后台文本文件，用户不可见不可编辑。The-Water 的故事线编辑器已经是一等公民 UI，这一点要守住。

### 1.2 写作方法论：成熟框架直接拿来用

- **雪花法 10 步**（一句话→一段话→人物 GMC→一页→人物小传→四页→人物档案→场景清单→场景扩写→初稿），已有命令化实现 [hestudy/snowflake-fiction](https://github.com/hestudy/snowflake-fiction)。
- **Save the Cat 15 拍**、**三幕结构**、**英雄之旅 12 阶段**：单卷/短篇节奏骨架。
- **中文网文专用**：[oh-story-claudecode](https://github.com/worldwonderer/oh-story-claudecode)（扫榜→拆文→写作→去 AI 味，章尾钩子 13 式/章首钩子 7 式，拆文报告字段）、[Chinese-WebNovel-Skill](https://github.com/Tomsawyerhu/Chinese-WebNovel-Skill)（10 模块：题材定位/开头/卷纲/因果链/人物一致性/过渡/对白/章尾/去 AI 味/完稿六类一致性复查，每模块附好坏范例）。
- **非虚构**：Diátaxis 四象限（教程/操作/参考/解释）、SCQA、PREP、金字塔原理、倒金字塔、IMRaD；校对标准用 [中文文案排版指北](https://github.com/sparanoid/chinese-copywriting-guidelines)。

### 1.3 文风量化：有现成的特征体系和评测手段

- 文体计量学（[JStylo/Writeprints](https://github.com/psal/jstylo)、[stylo](https://github.com/computationalstylistics/stylo)、Burrows' Delta）给出了可自动测量的维度：句长/段长分布、标点密度、虚词频率、词汇丰富度 TTR、词性比例、n-gram 签名。
- [ngpepin/stylometric-transfer](https://github.com/ngpepin/stylometric-transfer) 是最接近"结构化风格卡"的实现：measurements → targets（带容差带）→ lexicon（硬/软禁用词）→ templates（句首模式）→ validators（权重与阈值）→ 编译成 prompt。§4 的 StyleProfile 直接借鉴这一分层。
- 论文 [arXiv 2509.14543](https://arxiv.org/abs/2509.14543)：LLM 能学到表层词汇和基本句法，**学不到隐式的节奏与组织习惯**。所以风格卡里"节奏类量化特征 + 大量真实例句"的权重必须高于"形容词式描述"。
- 评测：作者嵌入（[LUAR](https://github.com/LLNL/LUAR)、StyleDistance）算相似度；OOC 检测用**逐句原子级**判定（[arXiv 2506.19352](https://arxiv.org/abs/2506.19352)）比整段打分更能定位；LLM 评审用六维 rubric（词汇复杂度/句子结构/节奏/修辞/篇章组织/腔调）。

### 1.4 写作 Agent 与质检：去 AI 味已有成熟词表和规则

- [awesome-novel-skill](https://github.com/modoojunko/awesome-novel-skill) 的去 AI 味分四层：提示词层注入规则→生成层自查→编辑层 Gate 量化评分→学习层把高频反馈晋升为永久规则。
- Prose linter（[vale](https://github.com/vale-cli/vale)、[write-good](https://github.com/btford/write-good)、[proselint](https://github.com/amperser/proselint)、[textlint ai-writing](https://github.com/textlint-ja/textlint-rule-preset-ai-writing)）的规则类型可直接迁移：存在性/替换/次数上限/重复/一致性/可读性/度量。
- 中文 AI 味词表与句式（[de-ai-flavor-skill](https://github.com/ren644/de-ai-flavor-skill)、[De-AI-Prompt-Enhancer](https://github.com/OUBIGFA/De-AI-Prompt-Enhancer-Writer-Booster-SKILL)）、英文词表（[humanize-ai-writing](https://github.com/haidrrrry/humanize-ai-writing)、[humanizer-skill](https://github.com/Aboudjem/humanizer-skill) 的 Burstiness/Perplexity 打分）已整理进 `lexicon/`。

---

## 2. 通用写作流程

所有文章类型共用同一条九阶段流水线，每阶段有明确的**输入、产物、prompt 模式、门禁**。类型差异只体现在第 3 阶段用哪个结构框架、第 5/8 阶段跑哪组检查。

| # | 阶段 | 产物（可存库、可编辑） | Prompt 模式（Role / Goal / Constraints / Output） | 门禁 |
|---|---|---|---|---|
| 1 | 立意 | `Brief`：一句话主张、受众、目的、角度、禁忌 | 选题策划；禁止空泛立意；输出 JSON | 人工确认 |
| 2 | 素材 | 虚构：角色卡、世界观条目、StyleProfile；非虚构：事实/引用库 `[{claim, source, confidence}]` | 研究员（STORM 式多视角追问）；禁止编造 | 事实标来源 |
| 3 | 结构 | 分层大纲：卷/章/场景卡 或 论证树，每节标注冲突/悬念/信息差、字数预算 | 大纲师；覆盖 Brief 无遗漏；输出 Schema 校验 | Schema 通过 + 人工可编辑 |
| 4 | 草稿 | 逐章/逐节正文 | 写手；注入 StyleProfile 摘要 + 示例段 + 负面清单；只输出正文 | 字数区间 |
| 5 | 自审 | `IssueList`：`[{type, location, severity, suggestion}]` + 风格偏差 + AI 味分 | 审校；只诊断不改写 | 严重问题为 0 才能进 6 |
| 6 | 他审 | 同上，独立模型/人格 | 独立评审；避免自我确认 | 可选 |
| 7 | 修订 | diff + 变更清单 | 编辑；逐条修复；不引入新事实；**只重写超出容差的段落** | 复审通过 |
| 8 | 校对 | lint 报告 | 机器规则（§6） | 零硬错误 |
| 9 | 提交 | `Commit`：正文 hash + 摘要 + 圣经增量 + 风格测量值 | 责任编辑（现有 summarizeAndBible） | 只有已提交的事实进入圣经 |

原则：
- **叙事自由与事实约束分离**：文笔放开写，但发生过的事必须在第 9 阶段登记过审才算数（webnovel-writer 的提交链）。
- **大纲越细，漂移越小**：长篇至少三层（卷纲→章纲→场景卡），场景卡精确到"谁、在哪、要什么、受阻于什么、结果、结尾钩子"。
- **生成与校验分离**：审校 prompt 与写作 prompt 不共享 temperature，不让写手自评。
- **定点修订**：修订只针对 IssueList 定位到的段落，避免整章重来带来新的漂移。

---

## 3. 文章类型 × 框架 × 模版

| 类型 | 结构框架 | 骨架关键字段 | 模版文件 |
|---|---|---|---|
| 长篇小说 | 阅读体验 + 因果推进 + 分层兑现；结构方法可选 | 体验、目标、独特方式与限制、重要选择及后果、阶段期待、结束条件 | [long-webnovel.md](templates/long-webnovel.md) |
| 短篇小说 | 阅读体验 + 自选结构（逐步发现 / 决定与后果 / 环形 / 片段 / 多视角 / 三幕或八拍） | 阅读体验、人物处境、视角、所选结构、关键变化、结束条件 | [short-story.md](templates/short-story.md) |
| 剧本 | 自选结构 + 场景清单 | 观看体验、所选结构、结束条件、场景表（INT/EXT、时间、人物、目的与积累） | [screenplay.md](templates/screenplay.md) |
| 同人 / 二创 | **原著 StyleProfile + 角色卡校对 + 原作时间线锚点** + 雪花法局部 | 原著提取报告、分歧点（canon divergence）、角色红线、CP/关系动机链、允许改动范围 | [fanfic.md](templates/fanfic.md) |
| 技术博客 | Diátaxis 定位 + 倒金字塔开头 | 文档类型、TL;DR、前置条件、代码示例、结论前置 | [tech-blog.md](templates/tech-blog.md) |
| 公众号推文 | SCQA 开头 + PREP 论证 + 金字塔 | 钩子标题、情景-冲突-疑问-回答、分论点+案例、CTA | [wechat-post.md](templates/wechat-post.md) |
| 评论杂文 | PREP + MECE | 观点先行、论据分组、反方预处理、结论呼应 | [essay.md](templates/essay.md) |
| 新闻稿 | 倒金字塔 | 导语 5W1H、次要事实、背景、引语 | [news.md](templates/news.md) |
| 科普文 | SCQA + 类比 | 现象引入、疑问驱动、解释、生活化类比、常见误区 | [popsci.md](templates/popsci.md) |
| 学术摘要/综述 | IMRaD | 背景/方法/结果/结论各 1-2 句；综述加现状分组、缺口、方向 | [academic.md](templates/academic.md) |

配套通用模版：[character-card.md](templates/character-card.md)（角色卡，兼容 Character Card V2 字段并补充口癖/红线）、[world-entry.md](templates/world-entry.md)（世界观条目，lorebook 结构）、[scene-card.md](templates/scene-card.md)（场景卡）、[style-profile.example.json](templates/style-profile.example.json)。

每份类型模版统一含五节：适用场景 → 流程（映射到 §2 九阶段）→ 骨架字段 → 各阶段 prompt 要点 → 该类型专属质检项。

---

### 3.1 三层词条：通用 / 题材包 / 作品

**为什么不给每类小说各造一个 agent。** 九阶段流水线对武侠、科幻、言情是同一条链，差异只落在少数几个 slot：大纲骨架、写作规则、质检项、风格靶值、禁用词。把这些做成数据，一个题材包就是一份配置；做成独立 agent 则要复制上下文组装、字数预算、半章续写、圣经合并等全部逻辑，改一个 bug 修 N 遍，而且「科幻悬疑」「武侠言情」这类组合无法叠加，只能再造混合 agent。

结论是两句话：**agent 按职能切，词条按题材切。** 职能通道（写手 / 风格审校 / 设定校对 / 责编）各有独立 prompt 与温度，一条通道服务全部题材；题材差异只是喂进去的数据不同。

词条分三层，共享是默认，独占是例外：

| 层 | 内容 | 落点 |
|---|---|---|
| L0 通用 | AI 味词表、中文排版、钩子类型、场景卡 schema、文章类型框架 | `docs/writing/lexicon/*.json` → `packages/shared/src/lexicon.ts`；`novel/docTypes.ts` |
| L1 题材包 | 条件性创作指导（境界体系 / 技术上限 / 江湖称谓…），并非本书事实；可配置禁词与句式接口、桥段的用与忌、大纲提示、写作规则、题材质检项、风格靶区间、推荐预设 | `apps/desktop/src/novel/genrePacks.ts`；`NovelRequirements.genrePackIds`（可多选） |
| L2 作品 | storyline / bible / StyleProfile / 自定义 lorebook 条目 | 数据库，永远优先 |

**合并规则是确定性的**，否则用户会遇到「我明明禁了这个词它还在写」：

- **触发**：L1 条目复用作品层的 lorebook 结构（`triggerKeys` + `priority` + `constant`），合并后一起走命中 → 排序 → token 预算截断（`context.ts` 的 `mergeLoreSettings` / `triggeredSettings`）。题材条目优先级缺省 40–70，作品条目缺省 50。
- **覆盖**：L2 同名条目覆盖 L1，L1 那条直接丢弃；`requirements.disabledLore` 可以按 id 关掉任意题材条目（不适用的准备条目可关闭，禁词以作品要求为准）。
- **多包冲突**（科幻 + 悬疑）：禁用词、句式、桥段、质检项**取并集**；数值靶区间**取交集**，交集为空时后选的包胜出并在向导里提示。
- **风格靶值**：题材层只填作品没写的项（`applyGenreToProfile`），且一律是软项（`hard: []`），不会触发自动重写。

三层分别在哪里生效：

| 用途 | L0 | L1 | L2 |
|---|---|---|---|
| 正文 system prompt | 文章类型写法 | `genreBlock`：写作规则 + 禁忌词 | StyleProfile 摘要 + 二创声明 |
| 大纲 prompt | 结构框架 | `genreOutlineBlock`：大纲提示 + 条件性题材准备问题（仅实际采用的具体规则写入 settings） + 桥段用/忌 | 故事前提 |
| 上下文注入 | — | 题材 lore 条目（触发词 / 常驻） | 人物、设定、时间线、示例段 |
| 本地 lint | AI 味词表 | 显式禁用词接口（当前通用包不设硬禁词） | 作品负面清单 |
| 审校 | 类型质检项 | 题材质检项 | 人物红线、既定事实 |

**独立的设定校对通道**（`llm/prompts/consistencyReview.ts`）只查事实层：数值与等级、事件先后、称呼与辈分、设定规则；不评文风、不判 OOC（那是 `styleReview` 的事）。它不需要 StyleProfile，也不区分题材——只喂本书已确认规则；题材重点进入叙事审稿，不能单独作为事实冲突依据。没有可对照的材料（事实 < 3 条、无规则、无时间线、无称呼表）时不发起调用。

内置七个题材包：仙侠 / 玄幻、都市 / 现实、科幻、悬疑 / 推理、言情 / 青春、历史 / 武侠、日常 / 治愈。旧的 `requirements.genre` 单选字段保留，未显式选包时按别名自动映射，因此不需要数据库迁移。

---

## 4. 文风规格 StyleProfile

"文风"被拆成四层，每层都能独立提取、独立注入、独立校验。完整 JSON 示例见 [style-profile.example.json](templates/style-profile.example.json)。

### 4.1 量化层 `metrics`（机器自动测量，中文按字计）

每项都用 **目标区间 + 容差带** 表示，而不是单点均值；校验时判断"是否落在容差内"。

| 字段 | 定义 | 示例值 |
|---|---|---|
| `sentenceLength` | 句长（字）均值/标准差/分位数 P10-P90 | mean 18, sd 9, p10 6, p90 34 |
| `sentenceBurstiness` | 句长标准差 ÷ 均值；人类文本通常 > 0.45，AI 均一文本 < 0.3 | 0.5 |
| `paragraphLength` | 段落字数分布；`singleSentenceParaRatio` 单句成段比例 | mean 95, single 0.22 |
| `dialogueRatio` | 引号内字数 ÷ 总字数 | 0.35 |
| `punctuation` | 每千字：句号/逗号/感叹号/问号/省略号/破折号/顿号 | ！3, …… 6, —— 2 |
| `functionWords` | 高频虚词/语气词每千字：的 了 着 过 吗 呢 啊 吧 却 便 竟 | 的 42, 了 18, 便 4 |
| `lexicalRichness` | MATTR（窗口 500 字）、平均词长 | 0.71 |
| `posRatio` | 形容词/动词/副词占比，反映描写密度 vs 动作密度 | adj 0.08, verb 0.22 |
| `ngramSignature` | 高频且区分度高的 2-4 字词组（TF-IDF 对比通用语料） | ["却也", "只当", "一时"] |
| `rhetoricRate` | 每千字设问/排比/反复/比喻次数 | 比喻 2.5 |

### 4.2 定性层 `voice`（LLM 归纳 + 人工修订，每项附 1-3 句原文例证）

| 字段 | 含义 |
|---|---|
| `narrator` | 叙述腔调：距离（贴身/俯视）、温度（冷峻/温热/戏谑）、可靠性 |
| `rhythm` | 节奏习惯：短句何时用、长句何时用、段落如何断、留白与空行 |
| `imagery` | 意象系统：偏好的比喻域（水/光/刀/市井……）、感官侧重（视/听/触） |
| `dialogue` | 对白规矩：书面/口语程度、称呼习惯、是否用"道/说"、潜台词密度 |
| `humor` | 幽默机制：冷幽默/反讽/文字游戏/无厘头，触发场景 |
| `emotion` | 情感基线与爆发方式：克制外放程度、煽情手法、留白 |
| `genreConventions` | 题材惯例：信息释放节奏、打斗/推理/日常段落的写法定式 |
| `signatureMoves` | 作者招牌动作：如章末一句短评、章首环境定调、反复出现的句式 |

### 4.3 示例层 `exemplars`

3-8 段原文（每段 150-400 字），按场景类型标签（战斗/日常/独白/对话/景物/高潮），每段标注它体现的 1-2 个 `voice` 要点。注入时按本章场景类型挑 2-3 段作 few-shot。**例句权重高于描述**（arXiv 2509.14543 的结论：节奏只能从例子里学）。

### 4.4 负面层 `negatives`

| 字段 | 内容 |
|---|---|
| `avoidWords` | 硬禁用词：时代错位词、网络流行语、作者从不用的词 |
| `avoidWordsSoft` | 软避免：每千字上限 |
| `avoidPatterns` | 禁止句式（含 AI 味句式，见 `lexicon/`） |
| `antiExemplars` | 反例：一段"跑偏了"的生成 + 批注"偏在哪" |
| `oocRedlines` | 角色层红线（引用角色卡） |

### 4.5 注入策略 `injection`

- `summaryBudget`：注入 system 的风格摘要字数上限（默认 300 字）。
- `exemplarCount`：每次生成注入的示例段数（默认 2-3）。
- `hardness`：各 metrics 项是硬约束（超出即打回）还是软约束（记分）。
- 注入位置：风格摘要进 system；示例段与负面清单进 user 的独立段落；量化目标只挑 3-5 项最有区分度的写成人话（"多用 6-12 字短句，段落常在一句话后断开，不用感叹号"），不要把整张表塞给模型。

---

## 5. 二创协议

"保持原著味道" = 五个维度同时成立：**叙述腔调、句式节奏、意象与用词、角色言行、世界规矩**。任何一维漂移读者都能闻出来。协议分五步闭环，每步产物入库、可回看。

### 5.1 提取（fork 导入后自动跑，产出"拆书报告"）

输入：原著全文（bundle 里的章节）。产物：
1. `StyleProfile`：metrics 用本地统计直接算（无需模型）；voice/exemplars/negatives 由 LLM 分批读章节归纳，再合并去重；人工在 UI 上修订。
2. `角色卡` 校对/补全：从原著抽每个主要角色的**说话样本**（≥5 句原话）、口癖、称呼表、绝不会做的事（红线）。
3. `世界观条目`：规矩、地名、术语、称谓、货币/时间制度，做成触发式 lorebook。
4. `时间线锚点`：原著已确立的事件顺序与状态（现有 bible.timeline 即可）。
5. `分歧点声明`（用户填写）：二创从原著哪一点开始分岔、改动了什么、哪些必须保持不变。

### 5.2 注入（每章生成时）

- system：原著 StyleProfile 摘要（≤300 字）+ 二创声明（"这是《X》的同人/续写，保持原著叙述腔调与角色性格；允许改动：…；不得改动：…"）。
- user：本章相关角色卡的说话样本 + 触发命中的世界观条目 + 2-3 段同场景类型的原著示例段 + 负面清单 + 本章计划。
- 上下文预算：示例段优先级高于"其他人物/其他设定"，低于本章计划与最近摘要（对应 context.ts 的丢弃顺序）。

### 5.3 生成

分段生成（现有的前半/后半机制已经在做），每段前**重新注入风格摘要**，防止长程漂移。

### 5.4 检查（生成后、提交前，三条独立通道）

| 通道 | 方法 | 输出 |
|---|---|---|
| 风格漂移（机器） | 对新章节算 metrics，与 StyleProfile 目标区间比对；可选嵌入相似度（本地小模型或远端 API） | 每项偏差 + 总分 0-100，低于阈值打回 |
| 角色 OOC（LLM 审校） | 逐句原子级判定：对每句对白/关键行为标 `in-character / neutral / OOC`，引用角色卡红线说明原因 | OOC 率 + 定位清单 |
| 世界规矩（LLM 设定校对） | 独立的一条通道（`consistencyReview`），对照题材层与作品层的设定规则、既定事实、时间线、称呼表找矛盾；不评文风、不判 OOC | 数值/时间线/称呼/规则四类冲突清单，见 §3.1 |
| AI 味（机器 + LLM） | §6 规则 | 命中清单 |

### 5.5 修订

只把超出容差的段落和 OOC 句子喂回模型做定点修改，附"偏在哪 + 目标是什么"，循环 ≤2 轮后交人工。修订后重跑 5.4，通过才 commit。

### 5.6 失败模式与对策

| 失败模式 | 表现 | 对策 |
|---|---|---|
| 风格漂移 | 越写越像模型默认腔 | 分段重注入摘要；逐段 metrics 监控 |
| 角色 OOC | 压力场景下人设崩 | 红线清单 + 逐句判定 + 说话样本 few-shot |
| 过度模仿变戏仿 | 招牌句式每段都出现 | `avoidWordsSoft` 设每千字上限；容差带而非精确复刻；`signatureMoves` 标注"频率" |
| 只学词汇不学节奏 | 用词像，读起来不像 | 提高 sentenceLength/burstiness/paragraphLength 的权重；示例段多于描述 |
| 世界观注入过量/漏触发 | 上下文被塞满或缺关键设定 | lorebook 触发词 + 优先级 + 预算；本章计划的人物/设定 ID 强制命中 |

---

## 6. 质检规则与 AI 味禁用清单

规则分四类，每条注明检测方式。词表在 `lexicon/`，可被代码直接加载。

**结构类（统计/正则）**：段落字数标准差过低（过度工整）；连续 ≥3 个等长并列句；句长 burstiness < 0.3；标题/加粗 + emoji 组合；每段开头都是小标题。

**语言类（词表/正则）**：同段同词重复 ≥3 次；陈词滥调命中；模糊词与弱化副词密度；被动句占比；"的"字连用 ≥3。

**AI 味类（词表 + LLM）**：`lexicon/ai-tells.zh.json` / `ai-tells.en.json` 命中；"不是…而是…"、"值得注意的是"、"让我们…"、结尾升华总结、每段等长等句式与结构；LLM 判断"结尾是否只有抒情没有新信息"。

**一致性类（结构化比对 + LLM）**：人物姓名/称呼/关系与角色卡 diff；伏笔登记与回收差集；术语一致；时间线排序；风格 metrics 与 StyleProfile 偏差。

---

## 7. 落地到 The-Water

三期方案已全部实施（2026-09-02）。下面按期列出落点，方便对照代码。

### 第一期：结构化文风（已实现）

| 方案条目 | 代码落点 |
|---|---|
| `StyleProfileSchema` 四层 + injection；`DerivativeDeclSchema`；`targetsFromMetrics` | `packages/shared/src/style.ts`，随 `StorylineDoc.styleProfile / derivative` 进入快照、bundle 与发布协议 |
| 文风预设（6 个，按题材排序）+ 自由文本兜底 | `apps/desktop/src/novel/stylePresets.ts`；向导第一步选预设 |
| `styleExtract` prompt（分批 + 合并 + 应用到档案） | `apps/desktop/src/llm/prompts/styleExtract.ts` |
| 本地 metrics（句长/起伏/段长/对白占比/标点/虚词/n-gram）与容差比对 | `apps/desktop/src/novel/styleMetrics.ts` |
| 注入：system 只放 ≤300 字人话摘要；示例段 + 负面清单是独立预算段，丢弃顺序在摘要之前、圣经之后 | `apps/desktop/src/llm/prompts/style.ts`、`base.ts` 的 `systemBase(req, extras)`、`context.ts` 的 `style` 段 |
| 数据库 | 迁移 `0002_writing_framework.sql`：`novels.style_profile / derivative`，人物 `voice`、设定 `lore` 列，`chapter_reviews`、`style_feedback` 表，job/step 种类扩展 |

### 第二期：二创闭环（已实现）

| 方案条目 | 代码落点 |
|---|---|
| fork 导入后自动排"拆书"任务；原著若自带档案则直接复用 | `sync/fork.ts` 的 `queueStyleExtraction`；导入 txt 也会排 |
| 拆书任务：本地统计 → LLM 分批归纳 → 写档案、补人物言行规格（只填空字段）、新增规矩类 lorebook 条目 | `jobs/steps/extractStyleStep.ts` |
| 二创声明（分歧点 / 必须保持 / 允许改动 / 读者 / 相似度） | 故事线编辑器「二创声明」表单；fork 时给默认值 |
| `style_check` 步骤：metrics 比对 + lint + LLM 六维评分与逐句 OOC；不达标定点修订一次；结果存 `chapter_reviews`，章节页显示 | `jobs/steps/styleCheckStep.ts`、`llm/prompts/styleReview.ts`、`db/repos/reviewsRepo.ts`；`planner.ts` 在 adjust_length 与 summarize 之间插入（有档案或二创声明时） |
| 人物 `speechSamples / verbalTics / addressBook / redlines`；设定 `triggerKeys / priority / constant` 触发注入 | `shared/storyline.ts`、`context.ts` 的 `renderVoiceLine` / `triggeredSettings` |

### 第三期：文章类型与质检（已实现）

| 方案条目 | 代码落点 |
|---|---|
| 十种文章类型：结构框架进大纲 prompt，写法规则进 system，专属质检项进审校 prompt | `apps/desktop/src/novel/docTypes.ts`；`NovelRequirements.docType` |
| 词表接入本地 lint，编辑器实时显示 AI 味分与提示 | `packages/shared/src/lexicon.ts`（由 `docs/writing/lexicon/*.json` 生成，测试保证同步）、`apps/desktop/src/novel/lint.ts` |
| 学习层：用户从 AI 稿里删掉的短语累计到 `style_feedback`，出现 2 次即晋升进档案软禁用词 | `apps/desktop/src/novel/learning.ts`、`db/repos/feedbackRepo.ts`，章节编辑器保存时触发 |

说明：第三期第 1 条的"非虚构走同一条流水线"以 docType 方式实现——章仍是章、情节点仍是情节点，但大纲/写法/质检按类型换框架；没有另建一套论证树编辑器。

### 第四期：题材包与设定校对（已实现）

| 方案条目 | 代码落点 |
|---|---|
| 七个题材包（L1）：lore 条目、禁用词/句式、桥段、大纲提示、写作规则、质检项、风格靶区间；多选合并规则见 §3.1 | `apps/desktop/src/novel/genrePacks.ts`；`NovelRequirements.genrePackIds / disabledLore`（JSON 列，无需迁移） |
| 三层词条合并：作品层同名覆盖题材层，题材条目只经触发词/常驻进上下文 | `llm/prompts/context.ts` 的 `mergeLoreSettings`，`selectRelevantBible` 第五参 |
| 题材层进 prompt：正文 system 的 `genreBlock`、大纲的 `genreOutlineBlock` | `llm/prompts/base.ts`、`llm/prompts/outline.ts` |
| 题材禁用词进本地 lint（block 级），与作品负面清单去重 | `novel/lint.ts` 的 `genre-avoid-word` / `genre-avoid-pattern` 规则 |
| 设定校对通道：数值 / 时间线 / 称呼 / 规则，低温 JSON，不改写；结论排在定点修订指令最前 | `llm/prompts/consistencyReview.ts`，`jobs/steps/styleCheckStep.ts`，报告存 `ChapterReviewJson.consistency` |
| 选了题材包即启用 style_check（L1 自带可检查材料） | `novel/service.ts` 的 `wantsStyleCheck` |

### 不做的事

- 不做作者级微调模型（StyleLLM 路线）：桌面多供应商架构下不可控，prompt + 检查闭环足够。
- 不用纯向量检索替代 lorebook：可解释性与可编辑性优先。
- 不把整张 metrics 表塞进 prompt：模型读不懂数字表，只注入 3-5 条翻译成人话的约束。
- 不为每个题材建独立 agent：题材是数据，职能才是通道（理由见 §3.1）。

开发者后端模型服务已接入 Pi，默认无需个人供应商密钥；配置、验收及尚未迁移的章节编排边界见 [server-harness.md](server-harness.md)。本机开发服务已启动，未部署外部生产服务。
