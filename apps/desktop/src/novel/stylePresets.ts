/**
 * Built-in style presets (docs/writing/README.md §7 第一期). Each is a full StyleProfile with
 * voice text + human-readable constraints + negatives; no metrics (targets stay null until extracted).
 */
import { emptyStyleProfile, type StyleProfile } from '@the-water/shared';

interface PresetSeed {
  id: string;
  name: string;
  genres: string[];
  voice: Partial<Record<'narrator' | 'rhythm' | 'imagery' | 'dialogue' | 'humor' | 'emotion' | 'genreConventions', string>>;
  constraints: string[];
  avoidWords?: string[];
  avoidPatterns?: string[];
  targets?: Partial<Pick<StyleProfile['targets'], 'sentenceMean' | 'burstiness' | 'dialogueRatio' | 'exclamationPerK'>>;
}

const SEEDS: PresetSeed[] = [
  {
    id: 'cold-restrained', name: '冷峭克制', genres: ['悬疑', '武侠', '现实'],
    voice: { narrator: '第三人称贴身视角，叙述者少评价，情绪藏在动作里。', rhythm: '动作段 5–12 字短句连击，交代段可用长句；段落在一个动作完成处断开。', imagery: '偏冷的意象：雨、铁、灯火、影子；感官侧重听觉与触觉。', dialogue: '对白短，用「道」多于「说」，少语气词，人物常答非所问。', humor: '冷幽默，来自人物一本正经地说反话，叙述者从不开玩笑。', emotion: '不直接写情绪形容词，用动作与物件表现。' },
    constraints: ['动作段用 5–12 字短句，交代段才用长句', '对白极短，不加语气词，人物可以答非所问', '禁止直接写「他感到（情绪）」，情绪只通过动作表现', '感叹号每千字不超过 2 个', '章末用一句不超过 12 字的短评独立成段'],
    avoidWords: ['瞬间', '秒杀', '情绪价值', '内心戏'], avoidPatterns: ['眼底闪过一丝', '嘴角勾起', '心中涌起一股'],
    targets: { sentenceMean: [10, 20], burstiness: [0.45, 0.8], exclamationPerK: [0, 2] },
  },
  {
    id: 'warm-lyrical', name: '细腻抒情', genres: ['言情', '现实', '青春'],
    voice: { narrator: '贴近人物内心的第三人称有限视角，允许适度的内心独白。', rhythm: '中长句为主，穿插短句作为情绪落点；段落偏长。', imagery: '日常物件与光线、季节、气味；感官侧重视觉与嗅觉。', dialogue: '对白自然口语，允许未说完的半句和停顿。', humor: '温和的自嘲。', emotion: '情感外露但不煽情，靠细节堆叠而非形容词。' },
    constraints: ['以中长句为主，情绪落点用短句收', '每个场景至少一个具体的日常物件承载情绪', '对白可以有未说完的半句', '不用「泪水夺眶而出」一类现成表达', '避免连续三段以上的内心独白'],
    avoidWords: ['泪水夺眶而出', '心如刀绞', '撕心裂肺'], avoidPatterns: ['仿佛…一般', '一丝…'],
    targets: { sentenceMean: [16, 30], burstiness: [0.4, 0.75], dialogueRatio: [0.25, 0.5] },
  },
  {
    id: 'fast-webnovel', name: '爽快网文', genres: ['玄幻', '都市', '仙侠', '奇幻'],
    voice: { narrator: '第三人称有限，节奏快，信息直给。', rhythm: '短句和单句成段多，关键句独立成段；每 300 字左右一个小钩子。', imagery: '直观、夸张的力量与气势意象。', dialogue: '对白占比高，交锋感强，允许适度的爽点台词。', humor: '轻快吐槽。', emotion: '情绪直接，爽点处允许外放。', genreConventions: '升级、打脸、反转要在章内兑现；章末必留钩子。' },
    constraints: ['短句为主，关键句单独成段', '每章至少一个明确的爽点或反转', '章末必须留钩子', '战力/等级/货币数值必须与设定一致', '不要连续三段以上没有对白或动作'],
    avoidWords: ['赋能', '底层逻辑', '闭环'], avoidPatterns: ['不是…而是…'],
    targets: { sentenceMean: [8, 18], burstiness: [0.45, 0.9], dialogueRatio: [0.35, 0.6] },
  },
  {
    id: 'classical-wuxia', name: '古典白话', genres: ['武侠', '历史', '仙侠'],
    voice: { narrator: '略带说书人口吻的第三人称，偶有全知的一句点评。', rhythm: '四六句式与短句交替，讲究顿挫。', imagery: '山水、江湖、酒、剑、月。', dialogue: '半文半白，称呼按辈分（前辈/兄台/在下）。', humor: '文雅的反讽。', emotion: '含蓄，点到即止。', genreConventions: '打斗只写关键三招；江湖规矩要有体现。' },
    constraints: ['用半文半白的语感，避免现代口语与网络词', '称呼按江湖辈分，不用「你好」「谢谢」这类现代客套', '打斗只写关键几招，不流水账', '允许说书人式的一句点评，但每章不超过两处'],
    avoidWords: ['OK', '搞定', '颜值', '尴尬', '没问题', '拜拜'], avoidPatterns: ['眼底闪过一丝'],
    targets: { sentenceMean: [10, 22], burstiness: [0.45, 0.8], exclamationPerK: [0, 3] },
  },
  {
    id: 'hardboiled-scifi', name: '硬冷科幻', genres: ['科幻', '悬疑'],
    voice: { narrator: '克制的第三人称或冷静的第一人称，术语准确。', rhythm: '中等句长，逻辑推进，段落紧凑。', imagery: '金属、光、数据、真空与尺度对比。', dialogue: '对白精确、信息密度高，少寒暄。', humor: '干冷的黑色幽默。', emotion: '情绪被理性压住，偶尔一次失控。', genreConventions: '设定自洽，技术细节点到为止，不做科普长段。' },
    constraints: ['术语前后一致，新术语首次出现给一句人话解释', '不写超过 150 字的纯设定说明段', '对白少寒暄，直接进入信息交换', '用尺度对比制造压迫感'],
    avoidWords: ['颠覆', '革命性', '降维打击'],
    targets: { sentenceMean: [14, 26], burstiness: [0.4, 0.75] },
  },
  {
    id: 'light-humor', name: '轻松幽默', genres: ['都市', '青春', '奇幻'],
    voice: { narrator: '带调侃的第一人称或亲近的第三人称。', rhythm: '短句多，段落短，包袱句独立成段。', imagery: '生活化、反差感的比喻。', dialogue: '对白活泼，互怼，节奏快。', humor: '反差与自嘲，不靠谐音梗。', emotion: '笑中带一点真心，关键处收住不煽情。' },
    constraints: ['包袱句单独成段', '幽默来自人物反差与自嘲，不用谐音梗与网络流行语', '每章至少一次让人物真诚一下', '不要解释笑点'],
    avoidWords: ['绝绝子', 'yyds', '栓Q', '破防'],
    targets: { sentenceMean: [8, 18], burstiness: [0.45, 0.9], dialogueRatio: [0.35, 0.65] },
  },
];

export function stylePresets(): StyleProfile[] {
  return SEEDS.map((s) => {
    const base = emptyStyleProfile({ id: `preset_${s.id}`, name: s.name, source: { kind: 'preset', presetId: s.id, chaptersSampled: [], extractedAt: null } });
    const voice = { ...base.voice };
    for (const k of Object.keys(s.voice) as Array<keyof typeof s.voice>) voice[k] = { text: s.voice[k] ?? '', evidence: [] };
    return {
      ...base,
      voice,
      negatives: { ...base.negatives, avoidWords: s.avoidWords ?? [], avoidPatterns: s.avoidPatterns ?? [] },
      injection: { ...base.injection, humanReadableConstraints: s.constraints },
      targets: { ...base.targets, ...(s.targets ?? {}), hard: [] },
    };
  });
}

export function presetsForGenre(genre: string): StyleProfile[] {
  const all = stylePresets();
  if (!genre) return all;
  const hit = SEEDS.filter((s) => s.genres.includes(genre)).map((s) => `preset_${s.id}`);
  return [...all.filter((p) => hit.includes(p.id)), ...all.filter((p) => !hit.includes(p.id))];
}

/** Turn a free-text style description (the legacy `requirements.style`) into a manual profile. */
export function profileFromFreeText(text: string): StyleProfile | null {
  const t = text.trim();
  if (!t) return null;
  return emptyStyleProfile({ id: 'manual', name: t.slice(0, 20), source: { kind: 'manual', presetId: null, chaptersSampled: [], extractedAt: null }, injection: { summaryBudget: 300, exemplarCount: 3, humanReadableConstraints: [t] } });
}
