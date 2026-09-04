/**
 * Article-type frameworks (docs/writing/README.md §3, templates/*.md). A doc type picks the
 * structural framework the planner uses, the writing rules injected into every prose prompt and
 * the QC emphasis. Fiction types keep the storyline pipeline; non-fiction types map "章" to sections
 * and "情节点" to argument nodes.
 */
export type DocType = 'long-webnovel' | 'short-story' | 'screenplay' | 'fanfic' | 'tech-blog' | 'wechat-post' | 'essay' | 'news' | 'popsci' | 'academic';

export interface DocTypeGuide {
  id: DocType;
  label: string;
  fiction: boolean;
  /** One-line framework name shown in the UI. */
  framework: string;
  /** Skeleton the outline prompt must follow. */
  outlineRules: string[];
  /** Rules injected into the prose system prompt. */
  writingRules: string[];
  /** Type-specific QC reminders for the review prompt. */
  qc: string[];
  /** Template file for humans. */
  template: string;
}

export const DOC_TYPES: Record<DocType, DocTypeGuide> = {
  'long-webnovel': {
    id: 'long-webnovel', label: '长篇小说', fiction: true, framework: '雪花法 + 分卷大纲 + 章尾钩子',
    outlineRules: ['先给一句话与一段话简介（背景 + 三次危机 + 结局）', '每个故事弧写清爽点阶梯与情绪走向', '黄金三章：第 1 章 300 字内出主角与冲突，第 3 章前给第一个爽点', '每章末尾给一个钩子类型：悬念/反转/新人物/倒计时/承诺/情绪断点'],
    writingRules: ['每章覆盖计划中的全部情节点并以钩子收束', '伏笔要么推进要么回收，不要凭空消失'],
    qc: ['爽点是否兑现', '钩子类型是否连续重复', '战力/数值是否与设定一致'],
    template: 'docs/writing/templates/long-webnovel.md',
  },
  'short-story': {
    id: 'short-story', label: '短篇小说', fiction: true, framework: 'Save the Cat 八拍',
    outlineRules: ['故事核一句话：谁 + 想要 + 但是 + 于是 + 最后', '按开场画面 → 触发 → 决定 → 中点反转 → 逼近 → 暗夜 → 结尾画面组织', '结尾画面必须与开场画面对照', '出场人物不超过 5 人'],
    writingRules: ['结尾画面呼应开场，但不解释这个呼应', '反转至少提前埋两处伏笔'],
    qc: ['开场/结尾是否呼应', '反转伏笔是否 ≥2', '结尾是否升华总结'],
    template: 'docs/writing/templates/short-story.md',
  },
  screenplay: {
    id: 'screenplay', label: '剧本', fiction: true, framework: '三幕 + 场景清单',
    outlineRules: ['先给 log line', '按三幕标出情节点 1/2、中点、B 故事', '每个情节点对应一个场景：INT/EXT、地点、时间、人物、目的、转变'],
    writingRules: ['没有叙述者，只写可拍摄的动作与对白', '场景标题格式：内/外景 · 地点 · 时间', '动作描述用现在时短句', '每场必须改变局面'],
    qc: ['场景是否无转变', '对白是否直接说主题', '括号提示是否过多'],
    template: 'docs/writing/templates/screenplay.md',
  },
  fanfic: {
    id: 'fanfic', label: '同人 / 二创', fiction: true, framework: '原著文风档案 + 角色卡校对 + 分歧点声明',
    outlineRules: ['明确从原著哪一点分岔、必须保持什么、允许改什么', '续写沿原著故事弧续排；平行世界只替换被改动的设定', '人物弧线从原著性格重推，不得换皮'],
    writingRules: ['读者是原著读者，腔调、句式、称呼的任何变化都会被察觉', '角色红线不可触碰', '称呼表逐字遵守'],
    qc: ['风格总分是否达标', 'OOC 率与红线命中', '称呼是否出错', '与原著已确立事实是否矛盾'],
    template: 'docs/writing/templates/fanfic.md',
  },
  'tech-blog': {
    id: 'tech-blog', label: '技术博客', fiction: false, framework: 'Diátaxis 定位 + 倒金字塔',
    outlineRules: ['先定文档类型：教程/操作指南/参考/解释，一篇只做一种', '开头给 TL;DR 三句', '按前置条件 → 步骤 → 陷阱 → 延伸组织', '每一步：目的 → 命令 → 预期输出 → 常见错误'],
    writingRules: ['第二人称、祈使句、现在时', '一段一件事', '代码块完整可运行并标语言', '术语首次出现给全称', '不写「我们将在本文中」式导语'],
    qc: ['代码块是否标语言', '步骤是否缺预期输出', '断言是否无来源'],
    template: 'docs/writing/templates/tech-blog.md',
  },
  'wechat-post': {
    id: 'wechat-post', label: '公众号推文', fiction: false, framework: 'SCQA 开头 + PREP 论证 + 结尾 CTA',
    outlineRules: ['开头 300 字内完成情景 → 冲突 → 疑问 → 回答', '三个分论点，每个按观点 → 理由 → 案例 → 重申组织', '每个案例要有人名/时间/数字', '结尾给一个具体动作'],
    writingRules: ['段落不超过 4 行', '禁止每段小标题与等长段落', '金句不超过两处', '不用「在这个…的时代」'],
    qc: ['三段内是否出现冲突', '案例是否有具体细节', '结尾是否只有升华没有动作'],
    template: 'docs/writing/templates/wechat-post.md',
  },
  essay: {
    id: 'essay', label: '评论 / 杂文', fiction: false, framework: 'PREP + MECE',
    outlineRules: ['论点一句话，并写出最强的反方观点', '论据分组互斥且穷尽（不超过三组）', '反方在第二或第三部分正面处理', '结尾呼应开头但立场推进一步'],
    writingRules: ['允许长句与语气起伏', '引用需可核', '禁止「综上所述」「毋庸置疑」'],
    qc: ['反方是否缺席', '论据是否重叠', '结论是否只是重复论点'],
    template: 'docs/writing/templates/essay.md',
  },
  news: {
    id: 'news', label: '新闻稿', fiction: false, framework: '倒金字塔',
    outlineRules: ['导语 60 字内含 5W1H', '事实按重要性递减排列', '引语注明人与职务', '背景放最后'],
    writingRules: ['第三人称、过去时', '不用形容词评价', '数字用阿拉伯数字', '引语原样不改写'],
    qc: ['导语是否超 60 字', '是否缺任一 W', '数字是否无来源'],
    template: 'docs/writing/templates/news.md',
  },
  popsci: {
    id: 'popsci', label: '科普文', fiction: false, framework: 'SCQA + 类比 + 边界条件',
    outlineRules: ['从一个读者会问的问题出发，给一句话答案和读者的错误直觉', '解释链每步一个类比或例子', '列常见误区与边界条件'],
    writingRules: ['先给现象再给术语', '术语首次出现给一句人话定义', '类比后说明类比的边界', '不用「科学家发现」这类无主语引用'],
    qc: ['断言是否无来源', '类比是否未标边界', '术语是否未定义'],
    template: 'docs/writing/templates/popsci.md',
  },
  academic: {
    id: 'academic', label: '学术摘要 / 综述', fiction: false, framework: 'IMRaD',
    outlineRules: ['按背景 / 方法 / 结果 / 结论各 1–2 句组织', '综述按主题分组，写共识、分歧、缺口与方向'],
    writingRules: ['不写文中没有的数字', '结论不超出结果', '避免 novel / 首次 / 革命性等夸大'],
    qc: ['结论是否超出结果', '数字是否无出处', '是否缺局限段'],
    template: 'docs/writing/templates/academic.md',
  },
};

export const DEFAULT_DOC_TYPE: DocType = 'long-webnovel';
export const DOC_TYPE_IDS = Object.keys(DOC_TYPES) as DocType[];

export function docTypeGuide(id: string | null | undefined): DocTypeGuide {
  return DOC_TYPES[(id ?? DEFAULT_DOC_TYPE) as DocType] ?? DOC_TYPES[DEFAULT_DOC_TYPE];
}
