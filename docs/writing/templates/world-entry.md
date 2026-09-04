# 世界观条目模版（lorebook 结构）

对应 `Setting` 扩展：`triggerKeys / secondaryKeys / priority / constant / budget`。注入时按触发词命中（本章计划、最近摘要、正在写的前半章文本都参与扫描），命中条目按 priority 排序，在 token 预算内注入；`constant: true` 的条目每章必注。

```yaml
id: set_xxx
name: 条目名（如：递刀礼）
kind: world | location | faction | item | rule | term | other
triggerKeys: [递刀, 拜帖, 接刀]         # 任一命中即触发
secondaryKeys: []                       # 若非空，需 triggerKeys 与 secondaryKeys 各命中一个
priority: 50                            # 0-100，高者先注入
constant: false                         # true = 常驻，不看触发
budgetChars: 200                        # 注入正文上限
recursive: true                         # 条目内容可触发其他条目（限一层）
content: |
  江湖中递刀给对方即表示托付性命；接刀者若拒绝，须刀尖朝己退还。
  违者视为挑衅。
canonSource: 原著第 3 章                 # 二创场景：出处
mustKeep: true                          # 二创场景：不可改动
notes: 不进入 prompt 的备注
```

**分类建议**：规矩（rule）与术语（term）优先 lorebook 化，因为它们最容易被模型"按常识"写错；地点与势力可保留在现有 `Setting.description` 里。
