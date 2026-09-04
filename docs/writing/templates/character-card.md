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
  motivation: 为什么想要（内在动机，最好来自伤口）
  conflict: 什么阻止他（外在阻力 + 内在缺陷）
personality: 三个核心特质 + 一个矛盾点（如"重情但绝不认错"）
backstory: ≤300 字，只写影响当下行为的部分
arc: 起点状态 → 转折 → 终点状态（可为空，功能性角色不需要）
relationships:
  - { targetId: char_yyy, kind: 师徒, note: 表面恭敬，暗中较劲 }
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
  - 不解释自己的动机
  - 不在人前哭
  - 不主动提师父的名字
# --- 动态状态（由圣经维护，不手填） ---
# state / location / knowledge 见 StoryBible.characters
# --- 二创专用 ---
canonAnchors:             # 原著里确立的、不可改动的事实
  - 第 12 章断了左手小指
allowedDeviation: 本二创允许的偏离（如"可以让他学会道歉"）
creatorNotes: 不进入 prompt 的备注
```

**注入规则**：本章 `beat.characterIds` 命中的角色注入完整言行规格；其余角色只注入 name/role/一句话描述。说话样本按本章情绪场景挑 3 句。
