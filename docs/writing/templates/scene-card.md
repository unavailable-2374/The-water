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
turn: 场景结束时局面如何改变（必须有变化，否则删场景）
reveals: 读者在此场景新知道的信息
setsUp: 埋下的伏笔（登记进伏笔债务表）
paysOff: 回收的伏笔（引用 id）
emotionCurve: 进场情绪 → 出场情绪
hook: 场景末句方向（章尾场景需对应 ChapterPlan.endHook）
wordBudget: 900
mustInclude: []       # 硬性要出现的动作/台词/物件
mustAvoid: []         # 本场景不能发生的事
```

**章尾钩子类型（选一）**：悬念 / 反转 / 新人物登场 / 倒计时 / 承诺 / 情绪断点 / 信息差暴露 / 决定 / 威胁升级 / 意外收获 / 误会 / 环境突变 / 独句短评。
