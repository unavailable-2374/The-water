# 文本质检规则清单（机器可执行）

每条：`id` · 类别 · 检测方式 · 阈值 · 处置。阈值是默认值，StyleProfile 的 `negatives` 与 `injection.hardness` 可覆盖。

| id | 类别 | 检测 | 默认阈值 | 处置 |
|---|---|---|---|---|
| uniform-paragraphs | 结构 | 段落字数 sd/mean | < 0.25 且段数 ≥ 6 | 警告 |
| low-burstiness | 结构 | 句长 sd/mean | < 0.3 | 警告；二创模式下若 StyleProfile 目标 > 0.4 则打回 |
| heading-every-para | 结构 | 段首加粗/短标题占比 | ≥ 50% | 警告（非虚构可豁免） |
| emoji-bullets | 结构 | emoji 计数 | ≥ 2 | 警告 |
| ai-word-hard | AI 味 | `lexicon/ai-tells.*.json` words 命中 | 每千字 > 1 | 打回定点修订 |
| ai-word-soft | AI 味 | wordsSoft 命中 | 每千字 > limitPerK | 警告 |
| ai-pattern | AI 味 | patterns 正则 | 任一命中 | 警告，列出位置 |
| hollow-ending | AI 味 | LLM 判断 | — | 警告 |
| word-repeat | 语言 | 同段同词（≥2 字）重复 | ≥ 3 | 警告 |
| de-chain | 语言 | 的字连用 | ≥ 3 | 警告 |
| cliche | 语言 | 陈词滥调词表（题材可扩展） | 命中 | 警告 |
| passive-ratio | 语言（英文） | 被动句占比 | > 25% | 警告 |
| length-range | 篇幅 | 章节字数 | 低于 minAcceptable | 打回（现有 lengthAdjust） |
| name-consistency | 一致性 | 正文人名/称呼 vs 角色卡 aliases/addressBook | 未登记称呼 | 警告 |
| thread-debt | 一致性 | 伏笔登记 − 回收 | 陈旧 > N 章 | 提醒（不阻断） |
| timeline-order | 一致性 | bible.timeline 排序 | 逆序 | 打回 |
| style-drift | 一致性 | metrics vs StyleProfile 容差带 | 硬项超出 | 打回；软项记分 |
| ooc-rate | 一致性 | LLM 逐句判定 OOC | > 5% 或任一红线命中 | 打回定点修订 |
| continuity | 一致性 | summarize 的 continuityWarnings | 非空 | 提醒并展示 |
| copywriting | 校对 | 中文文案排版指北：中英空格、全角标点、数字单位 | 命中 | 自动修正 |
