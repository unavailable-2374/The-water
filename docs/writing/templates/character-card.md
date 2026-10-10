# 角色卡模版

兼容 SillyTavern Character Card V2 的核心字段（description / personality / scenario / mes_example），并补充网文与二创场景缺失的**说话样本、口癖、称呼表、红线**。对应代码：`Character` schema 扩展字段 `speechSamples / verbalTics / addressBook / redlines`。

```yaml
id: char_xxx
name: 姓名
aliases: [别名, 绰号, 代号]
role: 主角 | 反派 | 配角 | 功能性角色
# --- 静态设定 ---
basics: { 年龄: , 性别: , 身份/职业: , 阵营/势力: , 外貌三要素: [] }
gmc:                      # Goal-Motivation-Conflict（雪花法第 3 步）
  goal: 想要什么（外在目标）
  motivation: 为什么重要、同时有哪些真实动机（不默认来自创伤）
  conflict: 什么阻止他（外在阻力 + 内在缺陷）
fear: 最害怕失去什么
belief: 相信什么，遇到困难惯常怎样解决
principleException: 什么价值冲突会使他违背平时原则
independentAction: 主角离开后，他接下来会做什么
personality: 先注意什么、怎样解释与处理事情、愿付出什么及让谁承担代价
backstory: ≤300 字，只写影响当下行为的部分
arc: 起点状态 → 条件不同的有代价选择及余波 → 终点状态（可改变、恶化、坚持或仅部分改变）
relationships:
  - { targetId: char_yyy, kind: 师徒, note: 在此人面前想证明什么、怎样表达需要、谁承担代价 }
# --- 言行规格（二创保味道的关键） ---
speechSamples:            # ≥5 句原话，覆盖：平静 / 愤怒 / 玩笑 / 撒谎 / 对亲近之人
  - "你来了。"
  - "我不杀人。"
verbalTics: [口头禅, 惯用句式, 惯用停顿方式]
addressBook:              # 他怎么称呼别人 / 别人怎么称呼他
  self: 我 | 在下 | 老子
  toMaster: 师父
  toStranger: 兄台
  calledBy: { char_yyy: 小子, default: 沈先生 }
speechStyle: 书面/口语程度、句长、是否用敬语、是否说反话、沉默的频率
behaviorTells: [紧张时擦刀, 说谎时看左上方]     # 可写入动作的"性格外显"
redlines:                 # 绝不会做的事，OOC 检测直接引用
  - 作者确认的行为底线（区分通常习惯与绝不允许违反的红线）
# --- 动态状态（由圣经维护，不手填） ---
# state / location / knowledge 见 StoryBible.characters
# --- 二创专用 ---
canonAnchors:             # 原著里确立的、不可改动的事实
  - 第 12 章断了左手小指
allowedDeviation: 本二创允许的偏离（如"可以让他学会道歉"）
creatorNotes: 不进入 prompt 的备注
```

**注入规则**：本章 `beat.characterIds` 命中的角色注入完整言行规格；其余角色只注入 name/role/一句话描述。说话样本按本章情绪场景挑 3 句。

人物目标卡现可保存 fear、belief、habitualStrategy、independentAgenda；principleException 可写入 contradiction。角色外观与言行规格仍保存于角色卡，规划动机不当作正文已发生的事实。

## 风格、复杂动机与自我保护

风格写成注意力、解释、表达和行动的习惯。同样沉默，可以在思考，也可以在惩罚；相同表象需要不同的关系与选择依据。复杂性可以来自两样都有价值的东西不能兼得、同一种品质的收益与代价、同一行为的多重动机，以及自我评价与行为之间的距离。关心与控制、嫉妒与祝福可以同时真实，不要求所有人物具备全部模式。

用现有字段完成七问，无需新增数据字段：

| 构思问题 | 保存位置 |
|---|---|
| 现在最想得到什么？ | goal |
| 为什么重要，还有什么真实动机？ | motivation |
| 同时想保住什么？ | contradiction |
| 最难承认什么，得到愿望需要什么代价？ | contradiction、fear、belief |
| 什么触发了哪种自我保护？ | habitualStrategy |
| 这种办法过去带来什么，现在失去什么？ | habitualStrategy |
| 下一次在什么条件下作出有代价的选择？ | growth、arc，与场景 choiceReason/choice/consequence 对应 |

角色 description 可保留日常快乐、擅长的小事、注意力与表达习惯；relationships.note 记录不同关系中的需要、保护与代价。不把所有人写成嘴硬、沉默、偷偷关心；坦率、快乐、果断也能承载矛盾。可以用被帮助、被拒绝、看到重要的人成功三个短场景检验差异，它们是可选构思练习，不是必须新增的剧情。

每次反复应有不同触发、关系或成本。外部资源与照护责任真实限制选择，不能全归为心理障碍；创伤可以解释行为，受伤者仍可拒绝、离开。人物不必被治愈，普通乐趣也不必都有象征意义。既有人物缺少信息时标待定，不为复杂性补造过去。

执行源为 `apps/desktop/src/novel/characterDesign.ts`：规划、正文与审查分别使用同源指导。文学层次建议须有具体依据；这些写法本身不是 OOC 或阻断标准。
