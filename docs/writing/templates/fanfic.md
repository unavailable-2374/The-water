# 同人 / 二创 / 续写

## 适用
基于已有作品（公共区 fork、导入的原著文本、用户自己的前作）创作：续写、番外、平行世界（AU）、视角转换、CP 向。核心难点只有一个：**读者一眼能认出"这就是那本书的味道"**，同时又确实是新故事。

## 流程（在通用九阶段上多一个"提取"前置阶段，见 README §5）
| 阶段 | 做法 | 产物 |
|---|---|---|
| 0 提取 | fork 导入后自动跑：本地统计 metrics；LLM 分批归纳 voice/exemplars/negatives；角色说话样本与红线；规矩/术语 lorebook 化；时间线锚点 | 拆书报告 → StyleProfile + 角色卡补全 + lorebook |
| 1 立意 | **分歧点声明**：从原著哪一点分岔（章/事件）、改动什么、必须保持什么、二创类型（续写/番外/AU/视角）、目标读者（原著粉 or 路人） | `derivative` 声明 |
| 2 素材 | 用户修订拆书报告：勾选"这些是味道的关键"、删掉误判 | 定稿 StyleProfile |
| 3 结构 | 续写：沿原著 arcs 续排；AU：只替换 settings 中被改动的条目，其余 mustKeep；番外：单章场景卡 | storyline |
| 4 草稿 | 注入原著 StyleProfile 摘要 + 同场景示例段 + 角色说话样本 + 命中 lorebook + 二创声明 | 章节 |
| 5 自审 | **风格漂移**（metrics 比对）+ **OOC 逐句判定** + 世界规矩矛盾 + AI 味 | 分数 + 定位 |
| 7 修订 | 只重写超容差段落与 OOC 句 | — |
| 9 提交 | commit 附带风格分与 OOC 率，发布时随 bundle 上传"改编声明" | — |

## 骨架字段
```yaml
derivative:
  sourceNovel: { id, title, author, versionId }        # 现有 NovelOrigin
  kind: sequel | sidestory | au | pov-switch | crossover
  divergencePoint: 原著第 N 章 / 事件 X 之后
  mustKeep: [叙述腔调, 主角性格, 世界规矩 A, 事件 B 已发生]
  allowedChanges: [配角 C 的结局, 新增地点 D]
  audience: 原著读者 | 路人
  styleProfileId: sp_xxx                                # 从原著提取
  styleFidelity: 0.85                                   # 期望相似度，决定容差带宽度（AU 可放宽到 0.7）
```

## Prompt 要点
- system 开头明示："这是《X》的{kind}，读者是原著读者，他们会立刻察觉腔调、句式、称呼的任何变化。"
- 风格摘要 ≤300 字，写成人话约束（见 style-profile.example.json 的 `humanReadableConstraints`），**不要**塞数字表。
- 示例段按本章 sceneType 挑 3 段，放在 user 段落最前面，并标注"以下是原著段落，模仿其节奏与腔调，不要照抄内容"。
- 角色说话样本按情绪场景挑 3 句 + 红线列表；称呼表全量注入（称呼错一个字读者就出戏）。
- 负面清单：原著从不用的词 + `antiExemplars`（"这样写就不像了"）。
- 温度略低于原创（0.75）。

## 审校 prompt（styleReview）
输入：新章节 + StyleProfile 的 voice + 角色卡红线 + 命中 lorebook。要求输出 JSON：
```json
{
  "styleScore": 0-100,
  "dimensionScores": { "narrator": , "rhythm": , "imagery": , "dialogue": , "humor": , "emotion": },
  "driftFindings": [{ "quote": "原句", "dimension": "rhythm", "why": "长句连用五句，原著在动作段只用短句", "suggest": "拆成三个短句" }],
  "ooc": [{ "character": "沈某", "quote": "原句", "verdict": "OOC", "redline": "不解释自己的动机" }],
  "canonConflicts": ["与第 12 章'左手小指已断'矛盾"],
  "verdict": "pass | revise"
}
```
机器 metrics 比对结果与该 JSON 合并成最终报告；任一硬项超出或 `ooc` 非空即 revise。

## 专属质检
风格总分 ≥ styleFidelity×100；OOC 率 ≤ 5% 且红线 0 命中；称呼表 0 错；mustKeep 条目 0 矛盾；招牌动作频率在区间内（防戏仿）；许可证合规（cc-by-sa 继承、ARR 不可二创，现有规则）。

## 常见失败与对策
见 README §5.6。额外一条：**AU 不是换皮**，改设定后角色的反应逻辑要照原著性格重推，红线仍然有效。
