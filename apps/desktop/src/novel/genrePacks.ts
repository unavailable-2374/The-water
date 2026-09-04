/**
 * 题材包（L1）：介于通用层（L0：docs/writing/lexicon 的 AI 味词表 + docTypes 的文章类型框架）
 * 与作品层（L2：storyline / bible / StyleProfile）之间的一层，见 docs/writing/README.md §3.1。
 *
 * 一本书可以同时选多个包（科幻 + 悬疑），合并规则是确定性的：
 *   - 禁用词 / 禁用句式 / 桥段 / 大纲提示 / 写作规则 / 质检项：并集去重，按选择顺序
 *   - 数值靶区间：取交集；交集为空时后选的包胜出，并记入 `conflicts` 供 UI 提示
 *   - lore 条目：按 id 去重（先出现的胜出）；作品层同名条目覆盖题材层（见 context.mergeLoreSettings）
 *
 * 题材包只提供缺省，作品层永远优先；`requirements.disabledLore` 可以逐条关掉包里的条目。
 */
import type { Setting, SettingKind, StyleProfile, StyleTargets } from '@the-water/shared';
import type { NovelRequirements } from './types';

export type GenreTargetKey = 'sentenceMean' | 'burstiness' | 'paragraphMean' | 'dialogueRatio' | 'exclamationPerK' | 'ellipsisPerK';
export type GenreTargets = Partial<Record<GenreTargetKey, [number, number]>>;

/** 题材层 lore 条目，结构与 StorylineDoc 的 Setting 一致，可直接进 lorebook 注入。 */
export interface GenreLoreEntry {
  /** 稳定 id：`${packId}:${slug}`；作品可用 requirements.disabledLore 关掉。 */
  id: string;
  name: string;
  kind: SettingKind;
  description: string;
  triggerKeys: string[];
  /** 缺省 40–70；低于作品层默认的 50 时，作品条目在预算里优先。 */
  priority: number;
  constant: boolean;
}

export interface GenrePack {
  id: string;
  label: string;
  /** 旧 requirements.genre 的取值，用于自动迁移与 UI 推荐。 */
  aliases: string[];
  summary: string;
  entries: GenreLoreEntry[];
  /** 硬禁用词（lint 记 block）。 */
  forbiddenWords: string[];
  /** 软限制词，沿用 L0 的每千字上限。 */
  softWords: string[];
  /** 禁用句式，`…` 为通配（与 StyleNegatives.avoidPatterns 同格式）。 */
  forbiddenPatterns: string[];
  tropes: { use: string[]; avoid: string[] };
  outlineHints: string[];
  writingRules: string[];
  qc: string[];
  targets: GenreTargets;
  /** 推荐的文风预设 id（stylePresets）。 */
  presetIds: string[];
}

const ENTRY_PRIORITY = { core: 70, high: 60, mid: 50, low: 45 } as const;

export const GENRE_PACKS: GenrePack[] = [
  {
    id: 'xianxia',
    label: '仙侠 / 玄幻',
    aliases: ['玄幻', '仙侠', '奇幻'],
    summary: '境界体系是第一约束：修为、丹药、法宝都不能随剧情需要变化。',
    entries: [
      {
        id: 'xianxia:realms', name: '境界体系', kind: 'rule', priority: ENTRY_PRIORITY.core, constant: true,
        triggerKeys: ['境界', '修为', '突破', '筑基', '金丹', '元婴'],
        description: '自低到高：炼气→筑基→金丹→元婴→化神→合体→大乘→渡劫。跨一个大境界即碾压；越级取胜必须付出代价（伤势、折寿、道心受损或消耗底牌）。不得临时新增境界。',
      },
      {
        id: 'xianxia:qi', name: '灵气与丹药', kind: 'rule', priority: ENTRY_PRIORITY.high, constant: false,
        triggerKeys: ['灵气', '丹药', '灵石', '法宝', '灵脉'],
        description: '灵气浓度：洞天福地 > 宗门驻地 > 凡俗之地。丹药分品阶，越级服用必有反噬。法宝认主后不可随意易手。',
      },
      {
        id: 'xianxia:sect', name: '宗门与辈分', kind: 'faction', priority: ENTRY_PRIORITY.mid, constant: false,
        triggerKeys: ['宗门', '掌门', '长老', '师尊', '弟子'],
        description: '宗门序列：掌门／长老／首座／亲传／内门／外门／杂役。对上自称弟子，同辈称师兄师姐；跨宗门称道友。',
      },
    ],
    forbiddenWords: ['手机', '电话', '互联网', '数据库', '概率', '公里', '千米', '分钟', '咖啡', '沙发', 'OK', '拜拜'],
    softWords: ['瞬间', '顿时', '猛地'],
    forbiddenPatterns: ['系统提示…', '数据显示…'],
    tropes: {
      use: ['开篇同时给出一个明确的修炼目标和一个具体的压迫源', '每卷至少一次越级战，并写清代价', '功法、法宝的获得要有取舍，不能白给'],
      avoid: ['废柴觉醒后立刻碾压全场且毫无代价', '长老一见天赋就当场收徒', '来历不明的强者随口指点解决困境'],
    },
    outlineHints: ['先定死境界体系与灵气规则，之后全书不得改动', '每卷主角修为最多推进一个大境界', '每个爽点之前先给等量的压迫'],
    writingRules: ['修为、境界、法宝品阶必须与设定一致；拿不准时不要写具体数字', '打斗写关键三招与胜负的理由，不罗列招式', '不用现代词汇与现代计量单位（用时辰、里、丈）'],
    qc: ['境界/战力是否与设定表冲突', '越级战是否付出了代价', '是否出现现代词汇或计量单位'],
    targets: { sentenceMean: [10, 20], burstiness: [0.45, 0.9], dialogueRatio: [0.3, 0.6] },
    presetIds: ['preset_fast-webnovel', 'preset_classical-wuxia'],
  },
  {
    id: 'urban',
    label: '都市 / 现实',
    aliases: ['都市', '现实'],
    summary: '一切按现实世界的钱、时间、法律与人情运转，冲突必须落在具体的东西上。',
    entries: [
      {
        id: 'urban:reality', name: '现实约束', kind: 'rule', priority: ENTRY_PRIORITY.high, constant: true,
        triggerKeys: [],
        description: '货币、物价、通勤时间、通讯方式、法律后果都按现实世界写。人物的违法行为必须带来相应的风险与代价。',
      },
      {
        id: 'urban:workplace', name: '职场与人情', kind: 'rule', priority: ENTRY_PRIORITY.low, constant: false,
        triggerKeys: ['公司', '老板', '同事', '项目', '合同', 'offer'],
        description: '职场冲突走明暗两条线：明面上是制度与流程，暗线是利益与面子。决定由具体的人在具体的位置上做出。',
      },
    ],
    forbiddenWords: ['修为', '灵气', '法宝', '境界', '系统面板', '金手指'],
    softWords: ['逆袭', '打脸', '震惊'],
    forbiddenPatterns: [],
    tropes: {
      use: ['冲突落在具体的钱、位置、关系上，不写抽象的正邪', '每个转折都要有可查证的现实依据：合同、聊天记录、监控、账单'],
      avoid: ['靠突然出现的贵人相助解决核心困境', '反派仅因为「嫉妒」就无限作恶'],
    },
    outlineHints: ['主角的困境要能用一句话说清代价（丢工作、还不上钱、失去监护权）', '每个故事弧对应一次现实处境的实质变化'],
    writingRules: ['金额、时间、地点写具体，不写「一大笔钱」', '职业细节要经得起同行看', '不要出现超自然设定'],
    qc: ['是否混入与题材不符的超自然设定', '金额/时间/地点是否前后矛盾', '职业细节是否失真'],
    targets: { sentenceMean: [12, 24], dialogueRatio: [0.3, 0.55] },
    presetIds: ['preset_light-humor', 'preset_warm-lyrical'],
  },
  {
    id: 'scifi',
    label: '科幻',
    aliases: ['科幻'],
    summary: '一个核心新设定，其余按现实物理；技术必须有代价与上限。',
    entries: [
      {
        id: 'scifi:ceiling', name: '技术上限', kind: 'rule', priority: ENTRY_PRIORITY.core, constant: true,
        triggerKeys: [],
        description: '先定这个世界能做什么、不能做什么：能源、算力、材料、寿命、通讯。全书不得越界，新技术必须由已有规则推导出来。',
      },
      {
        id: 'scifi:scale', name: '尺度与通讯', kind: 'rule', priority: ENTRY_PRIORITY.high, constant: false,
        triggerKeys: ['星系', '光年', '跃迁', '飞船', '通讯', '延迟'],
        description: '星际距离带来通讯延迟与信息不对称，这本身就是冲突来源。若存在超光速，必须交代其代价与限制条件。',
      },
    ],
    forbiddenWords: ['黑科技', '革命性', '万能芯片'],
    softWords: ['未来感', '科技感'],
    forbiddenPatterns: ['科学家发现…'],
    tropes: {
      use: ['只引入一个核心新设定，把它的社会后果写透', '故障与误用比敌人更有说服力', '技术带来的新伦理问题要落到具体的人身上'],
      avoid: ['用新造名词解释一切', '最后一刻发明新技术解围'],
    },
    outlineHints: ['第一章之前先写清技术上限，作为全书的硬约束', '每个转折都要能由已交代的规则推出'],
    writingRules: ['术语前后一致，首次出现给一句人话解释', '不写超过 150 字的纯设定说明段', '技术能力不能随剧情需要变强'],
    qc: ['技术能力是否前后不一致', '是否靠临时新技术解围', '术语是否首次出现未解释'],
    targets: { sentenceMean: [14, 26], burstiness: [0.4, 0.8] },
    presetIds: ['preset_hardboiled-scifi', 'preset_cold-restrained'],
  },
  {
    id: 'mystery',
    label: '悬疑 / 推理',
    aliases: ['悬疑'],
    summary: '公平原则：读者看到的线索必须和侦探一样多。',
    entries: [
      {
        id: 'mystery:fair-play', name: '公平原则', kind: 'rule', priority: ENTRY_PRIORITY.core, constant: true,
        triggerKeys: [],
        description: '凶手须在前三分之一出场；破案所依据的线索必须已经呈现给读者。不得靠未交代的密道、双胞胎、临时冒出的证据结案。',
      },
      {
        id: 'mystery:clues', name: '线索账', kind: 'rule', priority: ENTRY_PRIORITY.high, constant: false,
        triggerKeys: ['线索', '证据', '不在场', '凶器', '动机'],
        description: '每条线索登记：出现章节、表面含义、真实含义、回收章节。红鲱鱼必须有一个合理的日常解释，不能只是误导。',
      },
    ],
    forbiddenWords: [],
    softWords: ['诡异', '毛骨悚然', '不寒而栗'],
    forbiddenPatterns: ['如果当时…知道…', '殊不知…'],
    tropes: {
      use: ['每章至少推进或推翻一条线索', '嫌疑人各有独立动机与各自的谎言', '揭示真相前留一个让读者自行推理的窗口'],
      avoid: ['凶手在最后一章才出现', '靠意外自白结案', '侦探对读者隐藏已掌握的线索'],
    },
    outlineHints: ['先写好真相与完整时间线，再倒推每章暴露多少', '每个嫌疑人都要有一件说不出口的事（未必与案件有关）'],
    writingRules: ['人物可以撒谎，叙述者不可以', '每次揭示都要指回前文出现过的细节', '不写「如果当时他知道…」式的预告'],
    qc: ['凶手是否提前出场', '线索是否有出无回', '是否出现叙述性欺骗'],
    targets: { sentenceMean: [12, 24], burstiness: [0.45, 0.85] },
    presetIds: ['preset_cold-restrained', 'preset_hardboiled-scifi'],
  },
  {
    id: 'romance',
    label: '言情 / 青春',
    aliases: ['言情', '青春'],
    summary: '关系推进按阶段走，每一次靠近与退开都要有可指认的理由。',
    entries: [
      {
        id: 'romance:stages', name: '关系阶段', kind: 'rule', priority: ENTRY_PRIORITY.high, constant: true,
        triggerKeys: [],
        description: '相遇→试探→靠近→误会或外力→选择→和解。每个阶段由具体事件推动，不靠时间跳跃带过。',
      },
      {
        id: 'romance:motive', name: '动机链', kind: 'rule', priority: ENTRY_PRIORITY.mid, constant: false,
        triggerKeys: ['喜欢', '在意', '表白', '分手', '误会'],
        description: '写清双方各自的顾虑：一次靠近或退开，必须能追溯到此前发生过的一件具体的事。',
      },
    ],
    forbiddenWords: ['心如刀绞', '撕心裂肺', '泪水夺眶而出', '命中注定'],
    softWords: ['宠溺', '霸道', '深情'],
    forbiddenPatterns: ['眼底闪过一丝…', '霸道地…'],
    tropes: {
      use: ['误会要在两章内出现澄清的机会；人物选择不澄清必须给理由', '用共同经历而不是外貌推进感情'],
      avoid: ['靠一个不解释的误会拖满全书', '把强制与不平等的关系写成浪漫'],
    },
    outlineHints: ['先给两人各自独立的目标，感情线不能是唯一的动机', '每个故事弧结束时关系必须发生不可逆的变化'],
    writingRules: ['情绪靠细节与动作，不用现成成语', '对白允许未说完的半句', '不要连续三段以上的内心独白'],
    qc: ['关系推进是否跳阶段', '误会是否被无理由拖延', '情绪是否只靠成语堆砌'],
    targets: { sentenceMean: [14, 28], dialogueRatio: [0.3, 0.55] },
    presetIds: ['preset_warm-lyrical', 'preset_light-humor'],
  },
  {
    id: 'wuxia',
    label: '历史 / 武侠',
    aliases: ['武侠', '历史'],
    summary: '称谓、度量、江湖规矩三样都不能出戏，规矩本身就是冲突来源。',
    entries: [
      {
        id: 'wuxia:jianghu', name: '江湖称谓与辈分', kind: 'rule', priority: ENTRY_PRIORITY.core, constant: true,
        triggerKeys: [],
        description: '称呼按辈分：前辈／晚辈／兄台／在下／姑娘／大侠；同门称师兄师姐；对官府称大人。不用现代客套语。',
      },
      {
        id: 'wuxia:martial', name: '武功体系', kind: 'rule', priority: ENTRY_PRIORITY.high, constant: false,
        triggerKeys: ['内力', '招式', '武功', '剑法', '真气', '穴道'],
        description: '内力、招式、兵器有明确高下，不可无来由暴涨。疗伤与运功都要花时间，且有代价。',
      },
      {
        id: 'wuxia:era', name: '时代常识', kind: 'rule', priority: ENTRY_PRIORITY.mid, constant: false,
        triggerKeys: ['朝廷', '官府', '银两', '驿站', '科举', '宵禁'],
        description: '货币、度量、官职、交通、宵禁按所设朝代写；拿不准的朝代细节宁可不写具体。',
      },
    ],
    forbiddenWords: ['OK', '拜拜', '搞定', '颜值', '尴尬', '没问题', '手机', '分钟', '公里', '概率', '咖啡'],
    softWords: ['瞬间', '气息'],
    forbiddenPatterns: [],
    tropes: {
      use: ['一场打斗只写关键三招与胜负的理由', '江湖规矩本身就是冲突来源', '恩怨要落到具体的人与事，不写抽象的正邪'],
      avoid: ['秘籍一到手立刻天下无敌', '反派每次都留主角一命'],
    },
    outlineHints: ['先定门派格局与恩怨源头，再排主角的行走路线', '每一卷让主角在江湖规矩上付一次代价'],
    writingRules: ['半文半白，不用现代口语与网络词', '称呼按辈分，不用现代客套', '打斗只写关键几招，不流水账', '度量用里、丈、时辰、两'],
    qc: ['是否出现现代词汇或现代计量', '称呼辈分是否出错', '内力/武功是否无理由暴涨'],
    targets: { sentenceMean: [10, 22], burstiness: [0.45, 0.85] },
    presetIds: ['preset_classical-wuxia', 'preset_cold-restrained'],
  },
];

export const GENRE_PACK_IDS: string[] = GENRE_PACKS.map((p) => p.id);

export function genrePack(id: string): GenrePack | null {
  return GENRE_PACKS.find((p) => p.id === id) ?? null;
}

/** 旧 requirements.genre（单选字符串）→ 题材包 id，用于无需 DB 迁移的向后兼容。 */
export function packIdsForGenre(genre: string): string[] {
  const g = genre.trim();
  if (!g) return [];
  return GENRE_PACKS.filter((p) => p.aliases.includes(g)).map((p) => p.id);
}

// ---------------------------------------------------------------------------
// 合并
// ---------------------------------------------------------------------------

export interface MergedGenre {
  packIds: string[];
  labels: string[];
  entries: GenreLoreEntry[];
  forbiddenWords: string[];
  softWords: string[];
  forbiddenPatterns: string[];
  tropes: { use: string[]; avoid: string[] };
  outlineHints: string[];
  writingRules: string[];
  qc: string[];
  targets: GenreTargets;
  /** 多包冲突说明，UI 提示用。 */
  conflicts: string[];
  presetIds: string[];
}

export const EMPTY_GENRE: MergedGenre = {
  packIds: [], labels: [], entries: [], forbiddenWords: [], softWords: [], forbiddenPatterns: [],
  tropes: { use: [], avoid: [] }, outlineHints: [], writingRules: [], qc: [], targets: {}, conflicts: [], presetIds: [],
};

export function isEmptyGenre(m: MergedGenre): boolean {
  return m.packIds.length === 0;
}

const TARGET_KEYS: GenreTargetKey[] = ['sentenceMean', 'burstiness', 'paragraphMean', 'dialogueRatio', 'exclamationPerK', 'ellipsisPerK'];
const TARGET_LABEL: Record<GenreTargetKey, string> = {
  sentenceMean: '句长', burstiness: '句长起伏', paragraphMean: '段长', dialogueRatio: '对白占比', exclamationPerK: '感叹号', ellipsisPerK: '省略号',
};

function uniq(xs: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    const t = x.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/** 数值靶区间取交集；交集为空时后选的包胜出，并记入 conflicts。 */
export function intersectGenreTargets(packs: ReadonlyArray<Pick<GenrePack, 'label' | 'targets'>>): { targets: GenreTargets; conflicts: string[] } {
  const targets: GenreTargets = {};
  const conflicts: string[] = [];
  for (const key of TARGET_KEYS) {
    let cur: [number, number] | null = null;
    for (const p of packs) {
      const next = p.targets[key];
      if (!next) continue;
      if (!cur) { cur = [next[0], next[1]]; continue; }
      const lo = Math.max(cur[0], next[0]);
      const hi = Math.min(cur[1], next[1]);
      if (lo <= hi) cur = [lo, hi];
      else {
        cur = [next[0], next[1]];
        conflicts.push(`${TARGET_LABEL[key]}区间在所选题材间无交集，采用「${p.label}」的 ${next[0]}–${next[1]}`);
      }
    }
    if (cur) targets[key] = cur;
  }
  return { targets, conflicts };
}

/**
 * 合并多个题材包。禁用词/句式/桥段/规则取并集；数值靶区间取交集，交集为空时后选的包胜出并记入 conflicts。
 * `disabled` 里的 lore 条目 id 会被剔除。
 */
export function mergeGenrePacks(ids: readonly string[], disabled: readonly string[] = []): MergedGenre {
  const packs = uniq(ids).map(genrePack).filter((p): p is GenrePack => p !== null);
  if (packs.length === 0) return EMPTY_GENRE;
  const off = new Set(disabled.map((d) => d.trim()).filter(Boolean));

  const entries: GenreLoreEntry[] = [];
  const seenEntry = new Set<string>();
  for (const p of packs) {
    for (const e of p.entries) {
      if (off.has(e.id) || seenEntry.has(e.id)) continue;
      seenEntry.add(e.id);
      entries.push(e);
    }
  }

  const { targets, conflicts } = intersectGenreTargets(packs);

  return {
    packIds: packs.map((p) => p.id),
    labels: packs.map((p) => p.label),
    entries,
    forbiddenWords: uniq(packs.flatMap((p) => p.forbiddenWords)),
    softWords: uniq(packs.flatMap((p) => p.softWords)),
    forbiddenPatterns: uniq(packs.flatMap((p) => p.forbiddenPatterns)),
    tropes: { use: uniq(packs.flatMap((p) => p.tropes.use)), avoid: uniq(packs.flatMap((p) => p.tropes.avoid)) },
    outlineHints: uniq(packs.flatMap((p) => p.outlineHints)),
    writingRules: uniq(packs.flatMap((p) => p.writingRules)),
    qc: uniq(packs.flatMap((p) => p.qc)),
    targets,
    conflicts,
    presetIds: uniq(packs.flatMap((p) => p.presetIds)),
  };
}

/** 显式选择优先；没选过则从旧的 genre 字段推断（无需 DB 迁移）。 */
export function resolveGenrePackIds(req: Pick<NovelRequirements, 'genre' | 'genrePackIds'>): string[] {
  const explicit = (req.genrePackIds ?? []).filter((id) => genrePack(id) !== null);
  return explicit.length > 0 ? explicit : packIdsForGenre(req.genre ?? '');
}

const cache = new Map<string, MergedGenre>();

/** 每章都要用，按 (packIds, disabledLore) 缓存；纯函数，无副作用。 */
export function mergedGenreOf(req: Pick<NovelRequirements, 'genre' | 'genrePackIds' | 'disabledLore'>): MergedGenre {
  const ids = resolveGenrePackIds(req);
  if (ids.length === 0) return EMPTY_GENRE;
  const disabled = req.disabledLore ?? [];
  const key = `${ids.join(',')}|${[...disabled].sort().join(',')}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const merged = mergeGenrePacks(ids, disabled);
  cache.set(key, merged);
  return merged;
}

// ---------------------------------------------------------------------------
// 供下游使用的投影
// ---------------------------------------------------------------------------

/** 题材 lore → Setting，直接复用作品层的 lorebook 注入（触发词 + 优先级 + 预算）。 */
export function genreLoreSettings(m: MergedGenre): Setting[] {
  return m.entries.map((e) => ({
    id: e.id, name: e.name, kind: e.kind, description: e.description,
    triggerKeys: [...e.triggerKeys], priority: e.priority, constant: e.constant,
  }));
}

/** 题材靶值 → StyleTargets。题材层一律为软项（hard: []），不触发自动重写。 */
export function genreTargets(m: MergedGenre): StyleTargets {
  return {
    sentenceMean: m.targets.sentenceMean ?? null,
    burstiness: m.targets.burstiness ?? null,
    paragraphMean: m.targets.paragraphMean ?? null,
    dialogueRatio: m.targets.dialogueRatio ?? null,
    exclamationPerK: m.targets.exclamationPerK ?? null,
    ellipsisPerK: m.targets.ellipsisPerK ?? null,
    hard: [],
  };
}

/**
 * 把题材层填进作品的 StyleProfile：只补作品没写的部分（靶区间为 null 的项、空的题材惯例），
 * 作品层已有的值一律不动。profile 为 null 时返回 null——题材包不会凭空造出一个文风档案。
 */
export function applyGenreToProfile(profile: StyleProfile | null, m: MergedGenre): StyleProfile | null {
  if (!profile) return null;
  if (isEmptyGenre(m)) return profile;
  const targets: StyleTargets = { ...profile.targets };
  for (const key of TARGET_KEYS) {
    if (targets[key] === null || targets[key] === undefined) targets[key] = m.targets[key] ?? null;
  }
  const voice = { ...profile.voice };
  if (!voice.genreConventions.text.trim() && m.writingRules.length > 0) {
    voice.genreConventions = { text: m.writingRules.join('；'), evidence: [] };
  }
  return { ...profile, targets, voice };
}

/** 题材包推荐的文风预设排在前面。 */
export function orderPresetsByGenre<T extends { id: string }>(presets: readonly T[], m: MergedGenre): T[] {
  if (isEmptyGenre(m)) return [...presets];
  const rank = new Map(m.presetIds.map((id, i) => [id, i] as const));
  return [...presets].sort((a, b) => (rank.get(a.id) ?? 99) - (rank.get(b.id) ?? 99));
}
