# 调研笔记：GitHub 写作相关仓库（2026-09-01）

按四个方向整理，每条只留"是什么 + 拿走什么"。主文档 [README.md](README.md) 只引用其中的结论。

## A. AI 长篇/故事生成

| 仓库 | Star（约） | 流程 | 一致性 | 文风 | 拿走什么 / 坑 |
|---|---|---|---|---|---|
| [YILING0013/AI_NovelGenerator](https://github.com/YILING0013/AI_NovelGenerator) | 6k | 设定→目录→章节→定稿 | global_summary / character_state / plot_arcs 三文件 + 向量库 + consistency_checker | 温度 + 本章指导文本 | 独立一致性模块；坑：文风只有一句话 |
| [MaoXiaoYuZ/Long-Novel-GPT](https://github.com/MaoXiaoYuZ/Long-Novel-GPT) | 1.2k | 导入→拆书出纲要→提意见→检索→改写→回写纲要 | 纲要与正文双向同步 | 预置"模仿某作者"prompt 模板库 | "拆书"作为独立入口 |
| [Re3](https://github.com/yangkevin2/emnlp22-re3-story-generation) | 257 | Plan→Draft→Rewrite→Edit | relevance/coherence reranker + entailment 矛盾检测 | 无 | 生成与校验分离 |
| [DOC](https://github.com/yangkevin2/doc-story-generation) | 160 | 三层详细大纲→按条展开 | reranker + FUDGE 控制器 | 无 | 大纲颗粒度是一致性杠杆 |
| [google-deepmind/dramatron](https://github.com/google-deepmind/dramatron) | 1.1k | log line→角色→情节→地点→对白 | 层级硬条件 | 无 | 层级 prompt chaining；人机协作定位 |
| [vkbo/novelWriter](https://github.com/vkbo/novelWriter) | 3.1k | 非 AI 编辑器 | 元数据注释/交叉引用 | 无 | 层级文档结构；社区反 AI 情绪提醒 |
| [olivierkes/manuskript](https://github.com/olivierkes/manuskript) | — | 非 AI | 角色卡 + 索引卡 + 章节/场景树 | 无 | 索引卡式情节板交互 |
| [Character Card V2](https://github.com/malfoyslastname/character-card-spec-v2) / [World Info](https://docs.sillytavern.app/usage/core-concepts/worldinfo/) | — | — | lorebook：keys/secondary_keys/content/insertion_order/constant/position/scan_depth/token_budget/recursive | mes_example 承载说话风格 | 唯一正式规范；坑：无口癖/红线字段 |
| [RhythmicWave/NovelForge](https://github.com/RhythmicWave/NovelForge) | 1.2k | 7 步，卡片式 | JSON Schema 校验 + `@卡片` DSL + 知识图谱 | `@KB{}` 注入文风知识库 | Schema-first + DSL |
| [lingfengQAQ/webnovel-writer](https://github.com/lingfengQAQ/webnovel-writer) | 6.9k | 提交链：审查通过才 CHAPTER_COMMIT | 主链 + 派生只读视图；伏笔当债务 | 审查维度含"人物偏离" | 事件溯源架构；坑：对非工程用户不友好 |
| [Deng-m1/MaliangAINovalWriter](https://github.com/Deng-m1/MaliangAINovalWriter) | 862 | 作品→卷→章→场景 | 设定关系网络 | 拆书提取"叙事方式/文风/用词习惯"入知识库 | 少数显式做风格提取 |
| [datacrystals/AIStoryWriter](https://github.com/datacrystals/AIStoryWriter) | 258 | 大纲→章纲→正文→修订 | 弱 | 分阶段换模型 | 阶段模型可配 |
| [wordflowlab/novel-writer](https://github.com/wordflowlab/novel-writer) | 937 | constitution→specify→clarify→plan→tasks→write→analyze | plot-check/timeline/relations/world-check | personal-voice.md + 风格插件 + authenticity-audit | 检查命令化、可插拔 |
| [modoojunko/awesome-novel-skill](https://github.com/modoojunko/awesome-novel-skill) | — | 9 角色协作 | 每章归档角色状态；钩子健康度；节奏检查 | anti-ai 四层 + style-distiller | 动态记忆晋升为规则 |
| [ChanMeng666/fanfic-lab](https://github.com/ChanMeng666/fanfic-lab) | — | 意图→架构→写作→OOC 审查→摘要→交付 | pgvector 知识包 | — | OOC 审查为独立阶段 |
| [nbssdlkm/FicForge](https://github.com/nbssdlkm/FicForge) | — | 结构化上下文工程 | 100+ 章角色一致性 | — | 本地优先同人系统 |

## B. 写作方法论与模版

- 雪花法：[zzpolariszz/obsidian-snowflake-method](https://github.com/zzpolariszz/obsidian-snowflake-method)、[hestudy/snowflake-fiction](https://github.com/hestudy/snowflake-fiction)（命令化：outline-concept / character-design / outline-builder / scene-plan / chapter-write）
- Save the Cat 15 拍：[gist dideler/6043168](https://gist.github.com/dideler/6043168)
- 中文网文：[worldwonderer/oh-story-claudecode](https://github.com/worldwonderer/oh-story-claudecode)（目录骨架：设定/大纲/正文/追踪；章尾钩子 13 式、章首钩子 7 式；拆文报告字段）、[Tomsawyerhu/Chinese-WebNovel-Skill](https://github.com/Tomsawyerhu/Chinese-WebNovel-Skill)（10 模块，好坏范例）
- 世界观：[witchka/Obsidian-Worldbuilding-Templates](https://github.com/witchka/Obsidian-Worldbuilding-Templates)、[Syrkres/World-Building](https://github.com/Syrkres/World-Building)、[mak-kirkland/chronicler](https://github.com/mak-kirkland/chronicler)
- 长篇编辑：[kevboh/longform](https://github.com/kevboh/longform)
- 非虚构：[BolajiAyodeji/awesome-technical-writing](https://github.com/BolajiAyodeji/awesome-technical-writing)、[google/styleguide](https://github.com/google/styleguide)、[evildmp/diataxis-documentation-framework](https://github.com/evildmp/diataxis-documentation-framework)、[sparanoid/chinese-copywriting-guidelines](https://github.com/sparanoid/chinese-copywriting-guidelines)
- 结构框架（无高星仓库，理论稳定）：SCQA、PREP、金字塔原理/MECE、倒金字塔、IMRaD

## C. 文风量化与二创

- 文体计量：[psal/jstylo](https://github.com/psal/jstylo)（Writeprints 五类特征）、[computationalstylistics/stylo](https://github.com/computationalstylistics/stylo)（n-gram + Burrows' Delta）、[fastdatascience/faststylometry](https://github.com/fastdatascience/faststylometry)
- 风格卡实现：[ngpepin/stylometric-transfer](https://github.com/ngpepin/stylometric-transfer)（metadata→measurements→targets→lexicon→templates→controls→validators→prompt）
- 风格模仿研究：[AvantiB/Emulating-Author-Style](https://github.com/AvantiB/Emulating-Author-Style)、[stylellm/stylellm_models](https://github.com/stylellm/stylellm_models)（微调路线）、arXiv [2509.14543](https://arxiv.org/abs/2509.14543)（LLM 学不到隐式节奏）、[2510.13302](https://arxiv.org/abs/2510.13302)、[2310.08123](https://arxiv.org/abs/2310.08123)
- 评测：[LLNL/LUAR](https://github.com/LLNL/LUAR)（作者嵌入）、StyleDistance [2410.12757](https://arxiv.org/abs/2410.12757)、[nlpsoc/Style-Embeddings](https://github.com/nlpsoc/Style-Embeddings)、OOC 原子级判定 [2506.19352](https://arxiv.org/abs/2506.19352)、同人角色再诠释 [2409.11170](https://arxiv.org/abs/2409.11170)

## D. Prompt 工程与质检

- 结构化提示词：[langgptai/LangGPT](https://github.com/langgptai/LangGPT)（Role/Profile/Goal/Skills/Rules/Workflow/Initialization）
- 长文 Agent：[stanford-oval/storm](https://github.com/stanford-oval/storm)（多视角提问→大纲→成文→polish）、[danielmiessler/fabric](https://github.com/danielmiessler/Fabric)（improve_writing / analyze_prose_pinker）、[claude-draft-reviewer](https://github.com/aplaceforallmystuff/claude-draft-reviewer)（Analysis→Fix→Report）
- Linter：[vale](https://github.com/vale-cli/vale)、[write-good](https://github.com/btford/write-good)、[proselint](https://github.com/amperser/proselint)、[textlint-rule-preset-ai-writing](https://github.com/textlint-ja/textlint-rule-preset-ai-writing)
- 去 AI 味：[haidrrrry/humanize-ai-writing](https://github.com/haidrrrry/humanize-ai-writing)、[Aboudjem/humanizer-skill](https://github.com/Aboudjem/humanizer-skill)（Burstiness + Perplexity 打分）、[ren644/de-ai-flavor-skill](https://github.com/ren644/de-ai-flavor-skill)（中文词表）、[OUBIGFA/De-AI-Prompt-Enhancer](https://github.com/OUBIGFA/De-AI-Prompt-Enhancer-Writer-Booster-SKILL)
