/**
 * 拆书：从原著章节归纳 voice / exemplars / negatives，以及人物言行规格与世界规矩（docs/writing/README.md §5.1）。
 * 分批调用（每批 ≤ maxBatchChars），结果用 mergeStyleExtracts 合并。
 */
import { z } from 'zod';
import { SceneType, VOICE_DIMENSIONS, VOICE_DIMENSION_LABEL, type StyleProfile } from '@the-water/shared';
import type { PromptSpec } from '@/llm/types';
import { JSON_ONLY_RULE, joinSections, section, sys, user } from './base';

const short = (max: number) => z.string().max(max).default('');
const list = (max: number, item: number) => z.array(z.string().max(item)).max(max).default([]);

export const StyleExtractResultSchema = z.object({
  voice: z.object({
    narrator: short(600), rhythm: short(600), imagery: short(600), dialogue: short(600), humor: short(600), emotion: short(600), genreConventions: short(600),
  }).default({ narrator: '', rhythm: '', imagery: '', dialogue: '', humor: '', emotion: '', genreConventions: '' }),
  evidence: z.record(z.string(), list(3, 300)).default({}),
  signatureMoves: z.array(z.object({ move: z.string().max(200), example: short(300), perChapter: z.number().catch(1) })).max(6).default([]),
  exemplars: z.array(z.object({ sceneType: SceneType.catch('other'), text: z.string().max(1200), illustrates: list(3, 40) })).max(6).default([]),
  humanReadableConstraints: list(8, 200),
  avoidWords: list(30, 40),
  avoidPatterns: list(20, 80),
  characters: z.array(z.object({
    name: z.string().max(50),
    speechSamples: list(8, 300),
    verbalTics: list(8, 60),
    addressBook: z.record(z.string().max(40), z.string().max(40)).default({}),
    redlines: list(8, 200),
  })).max(20).default([]),
  lore: z.array(z.object({
    name: z.string().max(80),
    kind: z.enum(['rule', 'item', 'faction', 'location', 'world', 'other']).catch('rule'),
    triggerKeys: list(8, 40),
    content: z.string().max(600),
  })).max(20).default([]),
});
export type StyleExtractResult = z.infer<typeof StyleExtractResultSchema>;

export interface StyleExtractInput {
  title: string;
  /** Chapter excerpts for this batch, already labelled. */
  excerpts: Array<{ chapterNo: number; text: string }>;
  knownCharacterNames: string[];
  /** Local metrics summary lines to orient the model (optional). */
  metricsHint?: string;
}

export const STYLE_EXTRACT_JSON_SHAPE = `{
  "voice": { ${VOICE_DIMENSIONS.map((d) => `"${d}": "${VOICE_DIMENSION_LABEL[d]}：一两句概括"`).join(', ')} },
  "evidence": { "rhythm": ["能证明该特点的原文短句"], "dialogue": ["…"] },
  "signatureMoves": [{ "move": "作者反复使用的招牌写法", "example": "原文例句", "perChapter": 1 }],
  "exemplars": [{ "sceneType": "${SceneType.options.join('|')}", "text": "150–400 字原文摘录（逐字）", "illustrates": ["rhythm", "dialogue"] }],
  "humanReadableConstraints": ["写成给作者看的硬约束，3–8 条，如：动作段用 5–10 字短句"],
  "avoidWords": ["原著绝不会用的词（时代错位词、网络词）"],
  "avoidPatterns": ["原著绝不会用的句式"],
  "characters": [{ "name": "正式姓名", "speechSamples": ["原话（逐字）"], "verbalTics": ["口头禅"], "addressBook": { "自称": "在下", "称呼师父": "师父" }, "redlines": ["这个人绝不会做的事"] }],
  "lore": [{ "name": "规矩/术语名", "kind": "rule|item|faction|location|world|other", "triggerKeys": ["触发词"], "content": "一两句说明" }]
}`;

export function styleExtractPrompt(input: StyleExtractInput): PromptSpec<StyleExtractResult> {
  const system = [
    '你是一位文体分析编辑，任务是从小说原文中提炼可复用的文风档案，供续写与二创时保持原著味道。只根据给出的原文归纳，不要脑补；所有引文必须逐字来自原文。',
    JSON_ONLY_RULE,
  ].join('\n');
  const rules = [
    '1. voice 七个维度每项一两句，写具体可执行的观察（如"动作段用 5–10 字短句"），不要写"文笔优美"之类的评价。',
    '2. exemplars 逐字摘录 3–6 段最能代表风格的原文，每段 150–400 字，标注场景类型与它体现的维度。',
    '3. humanReadableConstraints 是给写手的硬约束，3–8 条，可直接照做。',
    '4. characters 只写已知人物列表中的人；speechSamples 逐字摘录原话，覆盖不同情绪；redlines 写"绝不会做的事"。',
    '5. lore 只收江湖规矩、术语、称谓制度、货币时间制度这类容易被写错的条目。',
    '6. 找不到的字段留空字符串或空数组，不要编造。',
  ].join('\n');
  const excerpts = input.excerpts.map((e) => `〔第${e.chapterNo}章〕\n${e.text}`).join('\n\n');
  const text = joinSections([
    section('作品', input.title),
    section('已知人物', input.knownCharacterNames.join('、')),
    input.metricsHint ? section('本地统计参考', input.metricsHint) : '',
    section('原文节选', excerpts),
    section('任务', `请提炼这部作品的文风档案，严格按下面的 JSON 结构输出。\n${rules}`),
    section('JSON 结构', STYLE_EXTRACT_JSON_SHAPE),
  ]);
  return { messages: [sys(system), user(text)], maxTokens: 6000, temperature: 0.3, schema: StyleExtractResultSchema, label: '提取文风' };
}

/** Merge batch results: concatenate texts (dedup), union lists, cap sizes. */
export function mergeStyleExtracts(results: StyleExtractResult[]): StyleExtractResult {
  const merged: StyleExtractResult = StyleExtractResultSchema.parse({});
  const uniq = (xs: string[], max: number) => Array.from(new Set(xs.map((x) => x.trim()).filter(Boolean))).slice(0, max);
  for (const d of VOICE_DIMENSIONS) {
    const texts = uniq(results.map((r) => r.voice[d]), 3);
    merged.voice[d] = texts.slice(0, 2).join(' ').slice(0, 600);
  }
  const ev: Record<string, string[]> = {};
  for (const r of results) for (const [k, v] of Object.entries(r.evidence)) ev[k] = uniq([...(ev[k] ?? []), ...v], 3);
  merged.evidence = ev;
  const moves = new Map<string, StyleExtractResult['signatureMoves'][number]>();
  for (const r of results) for (const m of r.signatureMoves) if (!moves.has(m.move)) moves.set(m.move, m);
  merged.signatureMoves = [...moves.values()].slice(0, 6);
  const ex = new Map<string, StyleExtractResult['exemplars'][number]>();
  for (const r of results) for (const e of r.exemplars) { const key = e.text.slice(0, 40); if (!ex.has(key) && e.text.trim().length >= 60) ex.set(key, e); }
  merged.exemplars = [...ex.values()].slice(0, 8);
  merged.humanReadableConstraints = uniq(results.flatMap((r) => r.humanReadableConstraints), 8);
  merged.avoidWords = uniq(results.flatMap((r) => r.avoidWords), 30);
  merged.avoidPatterns = uniq(results.flatMap((r) => r.avoidPatterns), 20);
  const chars = new Map<string, StyleExtractResult['characters'][number]>();
  for (const r of results) for (const c of r.characters) {
    const cur = chars.get(c.name);
    if (!cur) { chars.set(c.name, { ...c }); continue; }
    cur.speechSamples = uniq([...cur.speechSamples, ...c.speechSamples], 8);
    cur.verbalTics = uniq([...cur.verbalTics, ...c.verbalTics], 8);
    cur.addressBook = { ...cur.addressBook, ...c.addressBook };
    cur.redlines = uniq([...cur.redlines, ...c.redlines], 8);
  }
  merged.characters = [...chars.values()].slice(0, 20);
  const lore = new Map<string, StyleExtractResult['lore'][number]>();
  for (const r of results) for (const l of r.lore) if (!lore.has(l.name)) lore.set(l.name, l);
  merged.lore = [...lore.values()].slice(0, 20);
  return merged;
}

/** Apply a merged extract onto a profile (keeps metrics/targets/injection budgets). */
export function applyExtractToProfile(profile: StyleProfile, r: StyleExtractResult, chaptersSampled: number[]): StyleProfile {
  const voice = { ...profile.voice };
  for (const d of VOICE_DIMENSIONS) voice[d] = { text: r.voice[d] || profile.voice[d].text, evidence: r.evidence[d] ?? profile.voice[d].evidence };
  voice.signatureMoves = r.signatureMoves.map((m) => ({ move: m.move, example: m.example, frequencyPerChapter: [Math.max(0, m.perChapter - 1), Math.max(1, m.perChapter + 1)] as [number, number] }));
  return {
    ...profile,
    source: { ...profile.source, kind: 'extracted', chaptersSampled, extractedAt: new Date().toISOString() },
    voice,
    exemplars: r.exemplars.map((e, i) => ({ id: `ex${i + 1}`, sceneType: e.sceneType, text: e.text, illustrates: e.illustrates })),
    negatives: {
      ...profile.negatives,
      avoidWords: Array.from(new Set([...profile.negatives.avoidWords, ...r.avoidWords])).slice(0, 100),
      avoidPatterns: Array.from(new Set([...profile.negatives.avoidPatterns, ...r.avoidPatterns])).slice(0, 50),
    },
    injection: { ...profile.injection, humanReadableConstraints: r.humanReadableConstraints.length ? r.humanReadableConstraints : profile.injection.humanReadableConstraints },
  };
}
