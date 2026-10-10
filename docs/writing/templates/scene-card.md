# 场景卡模版

大纲的最细一层，介于 `ChapterPlan` 与正文之间。一章通常 2-4 张场景卡。对应 `Beat` 扩展或新增 `scenes`。

```yaml
id: sc_xxx
chapterNo: 12
order: 1
sceneType: fight | dialogue | quiet | travel | reveal | opening | climax   # 用于挑 StyleProfile 示例段
pov: char_xxx
where: set_xxx
when: 三更 / 前一场景后一个时辰
who: [char_xxx, char_yyy]
wants: 视角人物在此场景想要什么
obstacle: 谁/什么阻止
turn: 场景结束时局面如何改变（含理解、关系、生活体验与情绪积累，不强制反转）
readerInterest: 读者此刻关心什么
choice: 人物主动选择了什么（也可以是有依据的不行动）
choiceReason: 当前信息、同时真实的动机、自我保护与可行道路成本怎样导致选择
consequence: 谁承担选择的实际后果、关系怎样回应、行动之后有哪些情感余波
beforeState: 场景前的处境、关系、知识或理解
afterState: 本场实际呈现的变化
presentation: dramatize | summarize  # 重要选择与互动展开；过渡概述
reveals: 读者在此场景新知道的信息
setsUp: 埋下的伏笔（登记进伏笔债务表）
paysOff: 回收的伏笔（引用 id）
emotionCurve: 进场情绪 → 出场情绪
hook: 场景末句方向（章尾场景需对应 ChapterPlan.endHook）
wordBudget: 900
mustInclude: []       # 硬性要出现的动作/台词/物件
mustAvoid: []         # 本场景不能发生的事
```

**章尾收束方向（按场景需要选择，可为平静余味）**：悬念 / 反转 / 新人物登场 / 倒计时 / 承诺 / 情绪断点 / 信息差暴露 / 决定 / 威胁升级 / 意外收获 / 误会 / 环境突变 / 独句短评。

人物矛盾按[角色卡](character-card.md)落入本场景：注意到了什么、说了什么、实际做了什么、怎样解释自己的行为。台词同时处理事情和关系要求，心理描写带来发现、改判、逃避方案或承担后果，并影响下一步行动。不要反复重述同一种不安。选择已作出而感情尚未跟上也可以形成余波；对方拥有自己的边界与反应。只有本场所需且已有资料支持的层次进入正文，不要求每场凑齐所有检查项。

情节按[因果、人物与余味指南](plot-design.md)复核：前一场的哪些条件或后果促成本场？本场谁作出怎样的决定，哪些变化进入下一场？外部变化也可以独立发生，不强迫每个困难来自主角。若使用反转，它重新解释什么、改变什么行动？阶段完成之后允许恢复与平静相处，不强制每场受罚、反转或回收生活细节。
