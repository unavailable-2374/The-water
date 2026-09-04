# The Water 视觉规范

定位：**阅读、写作与 AI 融为一体**。参考微信读书 / Apple Books / 豆瓣阅读 / Ulysses：像一本摊开的书和一张书桌，不是后台管理系统。

## 关键词
纸感 · 温暖 · 留白 · 衬线标题 · 低对比边框 · 圆润 · 安静的 AI

## 颜色（Tailwind 类名，已在 `src/index.css` 的 `@theme` 中定义）
| 用途 | 类名 | 说明 |
|---|---|---|
| 页面底色 | `bg-paper-50` | 米白纸色，永远不用纯白/纯灰 |
| 卡片 / 面板 | `bg-paper-100`、`bg-paper-0`（最亮） | 卡片略比底色亮，用 `shadow-soft` 而不是硬边框 |
| 分隔线 | `border-paper-300` | 极淡，宽度 1px；能省则省，用间距分隔 |
| 正文墨色 | `text-ink-900` / 次要 `text-ink-600` / 提示 `text-ink-400` | 深棕黑而非纯黑 |
| 主操作（朱砂） | `bg-cinnabar-600 hover:bg-cinnabar-700 text-paper-0` | 只用于每屏一个最重要按钮 |
| AI 元素（青黛） | `text-tea-700 bg-tea-50 border-tea-200` | AI 对话气泡、AI 按钮、任务进度都用青黛色，让"AI 在旁边"而不抢眼 |
| 高亮（藤黄 / 松绿 / 天青 / 胭脂） | `bg-highlight-yellow` 等 | PDF 高亮与笔记 |
| 状态 | 成功 `tea`，警告 `amber-700/ amber-100`，错误 `cinnabar` | 不用饱和红绿 |

深色模式 = **夜读**：底色暖炭 `dark:bg-paper-950`，文字 `dark:text-paper-100`，卡片 `dark:bg-paper-900`。所有类都已有 dark 变体映射，不要自己写 `dark:bg-neutral-*`。

## 字体
- 标题 / 书名 / 章节名：`font-serif`（Songti SC / Noto Serif CJK SC），字重 500–600，字距略宽 `tracking-wide`。
- 界面文字：`font-sans`（PingFang SC）。
- 小说正文与 PDF 侧栏引文：`.prose-novel`（衬线、1.9 行高、首行缩进）。

## 形状与层次
- 圆角：卡片 `rounded-2xl`，按钮/输入 `rounded-xl`，标签 `rounded-full`。
- 阴影：`shadow-soft`（大而淡），悬停 `shadow-lift`。不要 `border` + `shadow` 同时用。
- 间距：页面内边距 `p-8`，卡片 `p-5`，元素间 `gap-4`。宁松勿紧。
- 图标：lucide，`size={16}` 配文字，`strokeWidth={1.75}`，颜色随文字。

## 组件语言（`src/components/ui.tsx`）
- `Button variant="primary"`（朱砂）/ `"secondary"`（纸色描边）/ `"ghost"` / `"ai"`（青黛，所有触发模型的动作）/ `"danger"`。
- `Card` 用于所有面板；`SectionTitle` 用于衬线小标题；`BookCover` 生成书封（暖色渐变 + 竖排书名）。
- 空状态用一句温和的话 + 一个主按钮，如「书架还空着，导入一本 PDF 开始阅读」。

## 版式原则
1. 每一屏有一个明确主体：书架上是书，阅读页是纸，工坊里是稿纸。
2. 工具栏轻：半透明纸色背景、无重边框、图标按钮，悬停才显底色。
3. 表格/列表尽量变成卡片或带留白的行；状态用小圆点 + 文字而不是彩色方块徽章堆叠。
4. 文案口语化、温和：「让 AI 来写这一章」「看看故事会怎样走」，避免「执行」「任务」「配置」这类词（内部术语保留在设置页即可）。
5. 数字（字数、进度）用衬线或等宽、颜色 `text-ink-500`，不加粗。
