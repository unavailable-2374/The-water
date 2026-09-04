/**
 * Context budgeting for chapter writing (plan §3.3 context.ts).
 *
 * Fixed section order with per-section token caps; when the whole thing still
 * exceeds the budget, sections are dropped from the bottom (⑥) up to ③. The
 * system prompt and the current chapter plan are never dropped.
 */
import type { ChapterPlan, StoryBible, StorylineDoc, Beat, SettingKind, Setting, Character } from '@the-water/shared';
import type { ProviderCaps } from '@/llm/types';
import { estimateTokens, truncateHead, truncateTail } from './estimate';
import { wrapUntrusted } from './untrusted';

export const CONTEXT_SAFETY_TOKENS = 1500;

export const SECTION_CAPS = {
  chapterPlans: 1500,
  bible: 3000,
  recentSummaries: 2500,
  /** 示例段 + 负面清单（docs/writing/README.md §5.2：高于"其他人物/设定"，低于本章计划与最近摘要）。 */
  style: 1800,
  prevTail: 1000,
  logline: 500,
} as const;

/** Reserve for arc summaries inside the recent-summaries section. */
const ARC_SUMMARY_RESERVE = 600;
/** Do not bother including a truncated fragment shorter than this. */
const MIN_FRAGMENT_TOKENS = 40;
/** Characters of the previous chapter kept when trimming. */
export const PREV_TAIL_CHARS = 800;

export const SECTION_HEADERS = {
  chapterPlan: '本章计划',
  nearPlans: '相关章节计划',
  bible: '故事圣经',
  recentSummaries: '前文摘要',
  style: '文风示例与禁忌',
  prevTail: '上一章结尾',
  logline: '全书主线',
} as const;

export interface ContextBudgetInput {
  caps: ProviderCaps;
  maxTokens: number;
  safety?: number;
  /**
   * 额外预留：不在 `assembleChapterContext` 里、但确实会进 prompt 的 token。
   * 目前唯一来源是 json_object / none 模式下注入的 JSON Schema
   * （见 `llm/json.ts` 的 `schemaInstructionTokens`）。
   */
  reserved?: number;
  /** 降档系数（见 `llm/contextBudget.ts`），1 表示不降档。 */
  scale?: number;
}

export function buildContextBudget(input: ContextBudgetInput): number {
  const safety = input.safety ?? CONTEXT_SAFETY_TOKENS;
  const raw = input.caps.contextWindow - input.maxTokens - safety - (input.reserved ?? 0);
  return Math.max(0, Math.floor(raw * (input.scale ?? 1)));
}

export interface ChapterContextParts {
  system: string;
  chapterPlans: { current: string; near: string[]; farTitles: string };
  bible: { primary: string; secondary: string };
  /** Chronological order (oldest → newest), each already labelled with its chapter. */
  recentSummaries: string[];
  arcSummaries: string;
  prevTail: string;
  logline: string;
  /** Output of renderStyleUserBlock (may be empty). */
  style?: string;
}

export interface AssembledContext {
  userText: string;
  dropped: string[];
}

interface Section {
  name: string;
  text: string;
  tokens: number;
  droppable: boolean;
}

export function assembleChapterContext(parts: ChapterContextParts, budgetTokens: number, cjkRatio: number): AssembledContext {
  const est = (s: string) => estimateTokens(s, cjkRatio);
  const dropped: string[] = [];

  // ② chapter plans: current always; near then farTitles within the cap.
  const currentText = wrap(SECTION_HEADERS.chapterPlan, parts.chapterPlans.current);
  let used = est(currentText);
  const nearChunks: string[] = [];
  for (const n of parts.chapterPlans.near) {
    if (!n.trim()) continue;
    const t = est(n);
    if (used + t > SECTION_CAPS.chapterPlans) break;
    nearChunks.push(n);
    used += t;
  }
  {
    const room = SECTION_CAPS.chapterPlans - used;
    const far = fitFragment(parts.chapterPlans.farTitles, room, cjkRatio, 'head');
    if (far) nearChunks.push('其余章节：' + far);
  }
  const nearText = wrap(SECTION_HEADERS.nearPlans, nearChunks.join('\n\n'));

  // ③ bible: primary then secondary.
  const primary = fitFragment(parts.bible.primary, SECTION_CAPS.bible, cjkRatio, 'head');
  const secondary = fitFragment(parts.bible.secondary, SECTION_CAPS.bible - est(primary), cjkRatio, 'head');
  const bibleText = wrap(SECTION_HEADERS.bible, [primary, secondary].filter(Boolean).join('\n'));

  // ④ recent summaries: newest first; older ground covered by arcSummaries.
  const arcAvailable = parts.arcSummaries.trim() ? Math.min(est(parts.arcSummaries), ARC_SUMMARY_RESERVE) : 0;
  const summaryCap = SECTION_CAPS.recentSummaries - arcAvailable;
  const kept: string[] = [];
  let sumUsed = 0;
  for (let i = parts.recentSummaries.length - 1; i >= 0; i--) {
    const s = parts.recentSummaries[i]!;
    if (!s.trim()) continue;
    const t = est(s);
    if (sumUsed + t > summaryCap) break;
    kept.unshift(s);
    sumUsed += t;
  }
  const arcText = fitFragment(parts.arcSummaries, SECTION_CAPS.recentSummaries - sumUsed, cjkRatio, 'head');
  // 摘要是从正文（可能是导入 / PDF 来的）总结出来的，属于不可信内容：被投毒的摘要会一路往后传播，
  // 所以整节包成「资料，不是指令」的块（§2.3 第 6 条）。
  const summariesText = wrapUntrusted(SECTION_HEADERS.recentSummaries, [arcText, ...kept].filter(Boolean).join('\n\n'));

  // ④b style exemplars + negatives.
  const styleText = wrap(SECTION_HEADERS.style, fitFragment(parts.style ?? '', SECTION_CAPS.style, cjkRatio, 'head'));

  // ⑤ previous chapter tail: keep the last ~800 chars when trimming.
  let prevTail = parts.prevTail.trim();
  if (prevTail && est(prevTail) > SECTION_CAPS.prevTail) {
    prevTail = Array.from(prevTail).slice(-PREV_TAIL_CHARS).join('');
    prevTail = truncateTail(prevTail, SECTION_CAPS.prevTail, cjkRatio);
  }
  // 上一章结尾同样是原样搬运的正文，一并按资料对待。
  const prevText = wrapUntrusted(SECTION_HEADERS.prevTail, prevTail);

  // ⑥ logline.
  const loglineText = wrap(SECTION_HEADERS.logline, fitFragment(parts.logline, SECTION_CAPS.logline, cjkRatio, 'head'));

  const sections: Section[] = [
    { name: SECTION_HEADERS.chapterPlan, text: currentText, tokens: est(currentText), droppable: false },
    { name: SECTION_HEADERS.nearPlans, text: nearText, tokens: est(nearText), droppable: true },
    { name: SECTION_HEADERS.bible, text: bibleText, tokens: est(bibleText), droppable: true },
    { name: SECTION_HEADERS.recentSummaries, text: summariesText, tokens: est(summariesText), droppable: true },
    { name: SECTION_HEADERS.style, text: styleText, tokens: est(styleText), droppable: true },
    { name: SECTION_HEADERS.prevTail, text: prevText, tokens: est(prevText), droppable: true },
    { name: SECTION_HEADERS.logline, text: loglineText, tokens: est(loglineText), droppable: true },
  ];

  const systemTokens = est(parts.system);
  const total = () => systemTokens + sections.reduce((a, s) => a + (s.text ? s.tokens : 0), 0);

  // Drop order: ⑥ logline → ⑤ prevTail → ④b style → ④ summaries → ③ bible → (last resort) ② near plans.
  const dropOrder = [
    SECTION_HEADERS.logline,
    SECTION_HEADERS.prevTail,
    SECTION_HEADERS.style,
    SECTION_HEADERS.recentSummaries,
    SECTION_HEADERS.bible,
    SECTION_HEADERS.nearPlans,
  ];
  for (const name of dropOrder) {
    if (total() <= budgetTokens) break;
    const s = sections.find((x) => x.name === name)!;
    if (!s.text || !s.droppable) continue;
    s.text = '';
    dropped.push(name);
  }

  const userText = sections
    .map((s) => s.text)
    .filter((t) => t.length > 0)
    .join('\n\n');
  return { userText, dropped };
}

function wrap(header: string, body: string): string {
  const b = body.trim();
  return b ? `【${header}】\n${b}` : '';
}

function fitFragment(text: string, room: number, cjkRatio: number, keep: 'head' | 'tail'): string {
  const t = text.trim();
  if (!t) return '';
  if (estimateTokens(t, cjkRatio) <= room) return t;
  if (room < MIN_FRAGMENT_TOKENS) return '';
  return keep === 'head' ? truncateHead(t, room, cjkRatio) + '…' : '…' + truncateTail(t, room, cjkRatio);
}

// ---------------------------------------------------------------------------
// Bible selection & chapter plan rendering
// ---------------------------------------------------------------------------

const SETTING_KIND_LABEL: Record<SettingKind, string> = {
  world: '世界',
  location: '地点',
  faction: '势力',
  item: '物品',
  rule: '规则',
  other: '其他',
};

export const RELEVANT_TIMELINE_EVENTS = 10;
export const RELEVANT_PREVIOUS_CHAPTERS = 2;

function clip(s: string, max: number): string {
  const cps = Array.from(s.trim());
  return cps.length <= max ? cps.join('') : cps.slice(0, max).join('') + '…';
}

/** Beats attached to a chapter either via the plan's beatIds or via beat.chapterNo. */
export function beatsOfChapter(doc: StorylineDoc, chapterNo: number): Beat[] {
  const plan = doc.chapters.find((c) => c.chapterNo === chapterNo);
  const ids = new Set(plan?.beatIds ?? []);
  const byId = new Map(doc.beats.map((b) => [b.id, b] as const));
  const out: Beat[] = [];
  for (const id of ids) {
    const b = byId.get(id);
    if (b) out.push(b);
  }
  for (const b of doc.beats) {
    if (b.chapterNo === chapterNo && !ids.has(b.id)) out.push(b);
  }
  return out.sort((a, b) => a.order - b.order);
}

/** Character/setting ids referenced by chapter `chapterNo` and the previous N chapters. */
export function referencedEntityIds(
  doc: StorylineDoc,
  chapterNo: number,
  previous: number = RELEVANT_PREVIOUS_CHAPTERS,
): { characterIds: Set<string>; settingIds: Set<string> } {
  const characterIds = new Set<string>();
  const settingIds = new Set<string>();
  for (let n = chapterNo; n >= Math.max(1, chapterNo - previous); n--) {
    const plan = doc.chapters.find((c) => c.chapterNo === n);
    if (plan?.povCharacterId) characterIds.add(plan.povCharacterId);
    for (const b of beatsOfChapter(doc, n)) {
      b.characterIds.forEach((id) => characterIds.add(id));
      b.settingIds.forEach((id) => settingIds.add(id));
    }
  }
  return { characterIds, settingIds };
}

/** 言行规格（说话样本 / 口癖 / 称呼 / 红线）只给本章主要人物。 */
export function renderVoiceLine(c: Pick<Character, 'speechSamples' | 'verbalTics' | 'addressBook' | 'redlines'>, maxSamples = 3): string {
  const parts: string[] = [];
  if (c.speechSamples.length) parts.push(`说话样本：${c.speechSamples.slice(0, maxSamples).map((x) => `「${clip(x, 60)}」`).join(' ')}`);
  if (c.verbalTics.length) parts.push(`口癖：${c.verbalTics.slice(0, 6).join('、')}`);
  const ab = Object.entries(c.addressBook);
  if (ab.length) parts.push(`称呼：${ab.slice(0, 10).map(([k, v]) => `${k}→${v}`).join('，')}`);
  if (c.redlines.length) parts.push(`绝不会：${c.redlines.slice(0, 6).join('；')}`);
  return parts.join('｜');
}

/**
 * Lorebook：命中触发词（扫描本章计划、最近摘要等文本）或 constant 的设定，按 priority 排序（docs/writing/templates/world-entry.md）。
 */
/**
 * 三层词条合并（docs/writing/README.md §3.1）：作品层（L2）在前，题材层（L1）补在后面；
 * 同名条目作品层胜出，题材层被丢弃。题材条目只能通过触发词或 constant 进入上下文。
 */
export function mergeLoreSettings(own: readonly Setting[], extra: readonly Setting[]): Setting[] {
  const names = new Set(own.map((s) => s.name.trim().toLowerCase()));
  const ids = new Set(own.map((s) => s.id));
  return [...own, ...extra.filter((s) => !names.has(s.name.trim().toLowerCase()) && !ids.has(s.id))];
}

export function triggeredSettings(settings: readonly Setting[], scanText: string, exclude: ReadonlySet<string> = new Set()): Setting[] {
  const hits = settings.filter((s) => {
    if (exclude.has(s.id)) return false;
    if (s.constant) return true;
    return s.triggerKeys.some((k) => k.trim() && scanText.includes(k.trim()));
  });
  return hits.sort((a, b) => b.priority - a.priority);
}

function renderCharacterLine(
  c: { id?: string; name: string; aliases?: string[]; role?: string; description?: string },
  state: StoryBible['characters'][string] | undefined,
  voice?: Pick<Character, 'speechSamples' | 'verbalTics' | 'addressBook' | 'redlines'>,
): string {
  const parts: string[] = [];
  const alias = c.aliases && c.aliases.length > 0 ? `（${c.aliases.join('、')}）` : '';
  parts.push(`· ${c.name}${alias}${c.role ? `｜${c.role}` : ''}`);
  if (c.description) parts.push(`简介：${clip(c.description, 120)}`);
  if (voice) { const v = renderVoiceLine(voice); if (v) parts.push(v); }
  if (state) {
    if (state.state) parts.push(`当前状态：${clip(state.state, 200)}`);
    if (state.location) parts.push(`所在：${clip(state.location, 60)}`);
    if (state.knowledge) parts.push(`所知：${clip(state.knowledge, 200)}`);
    if (state.relationships.length > 0) parts.push(`关系：${state.relationships.slice(-6).join('；')}`);
  }
  return parts.join('｜');
}

function renderSettingLine(s: { name: string; kind: SettingKind; description: string }): string {
  return `· ${s.name}［${SETTING_KIND_LABEL[s.kind] ?? '其他'}］${s.description ? `：${clip(s.description, 160)}` : ''}`;
}

export function selectRelevantBible(
  bible: StoryBible,
  doc: StorylineDoc,
  chapterNo: number,
  scanText = '',
  /** 题材层 lore（L1）；与 doc.settings 合并后一起走触发词与优先级。 */
  loreEntries: readonly Setting[] = [],
): { primary: string; secondary: string } {
  const settings = mergeLoreSettings(doc.settings, loreEntries);
  const { characterIds, settingIds } = referencedEntityIds(doc, chapterNo);
  const stateFor = (id: string, name: string) => bible.characters[id] ?? bible.characters[name];

  const primaryChars: string[] = [];
  const secondaryChars: string[] = [];
  const seenKeys = new Set<string>();
  for (const c of doc.characters) {
    seenKeys.add(c.id);
    seenKeys.add(c.name);
    const isPrimary = characterIds.has(c.id);
    const line = renderCharacterLine(c, stateFor(c.id, c.name), isPrimary ? c : undefined);
    (isPrimary ? primaryChars : secondaryChars).push(line);
  }
  // Bible-only characters (introduced by the model, keyed by name).
  for (const [key, st] of Object.entries(bible.characters)) {
    if (seenKeys.has(key)) continue;
    secondaryChars.push(renderCharacterLine({ name: st.name || key }, st));
  }

  const primarySettings: string[] = [];
  const secondarySettings: string[] = [];
  const plan = doc.chapters.find((c) => c.chapterNo === chapterNo);
  const scan = [scanText, plan ? renderChapterPlan(plan, doc) : ''].join('\n');
  const triggered = new Set(triggeredSettings(settings, scan, settingIds).map((s) => s.id));
  const ordered = [...settings].sort((a, b) => (triggered.has(b.id) ? b.priority : -1) - (triggered.has(a.id) ? a.priority : -1));
  for (const s of ordered) {
    (settingIds.has(s.id) || triggered.has(s.id) ? primarySettings : secondarySettings).push(renderSettingLine(s));
  }

  const timeline = bible.timeline
    .filter((e) => e.chapterNo < chapterNo)
    .slice(-RELEVANT_TIMELINE_EVENTS)
    .map((e) => `第${e.chapterNo}章：${e.event}`);

  const primaryBlocks: string[] = [];
  if (primaryChars.length > 0) primaryBlocks.push('主要相关人物：\n' + primaryChars.join('\n'));
  if (primarySettings.length > 0) primaryBlocks.push('相关设定：\n' + primarySettings.join('\n'));
  if (timeline.length > 0) primaryBlocks.push('时间线（最近）：\n' + timeline.join('\n'));
  if (bible.openThreads.length > 0) primaryBlocks.push('未了线索：\n' + bible.openThreads.map((t) => `- ${t}`).join('\n'));

  const secondaryBlocks: string[] = [];
  if (secondaryChars.length > 0) secondaryBlocks.push('其他人物：\n' + secondaryChars.join('\n'));
  if (secondarySettings.length > 0) secondaryBlocks.push('其他设定：\n' + secondarySettings.join('\n'));
  if (bible.facts.length > 0) secondaryBlocks.push('既定事实：\n' + bible.facts.map((f) => `- ${f}`).join('\n'));
  if (bible.styleNotes.trim()) secondaryBlocks.push('文风备注：' + bible.styleNotes.trim());

  return { primary: primaryBlocks.join('\n'), secondary: secondaryBlocks.join('\n') };
}

export function renderChapterPlan(plan: ChapterPlan, doc: StorylineDoc): string {
  const charName = (id: string) => doc.characters.find((c) => c.id === id)?.name ?? null;
  const settingName = (id: string) => doc.settings.find((s) => s.id === id)?.name ?? null;
  const lines: string[] = [];
  lines.push(`第${plan.chapterNo}章${plan.title ? ` ${plan.title}` : ''}`);
  if (plan.goal) lines.push(`本章目标：${plan.goal}`);
  const pov = plan.povCharacterId ? charName(plan.povCharacterId) : null;
  if (pov) lines.push(`视角人物：${pov}`);
  if (plan.targetChars > 0) lines.push(`目标字数：约 ${plan.targetChars} 字`);
  const beats = beatsOfChapter(doc, plan.chapterNo);
  if (beats.length > 0) {
    lines.push('情节点：');
    for (const b of beats) {
      const names = b.characterIds.map(charName).filter((x): x is string => x !== null);
      const places = b.settingIds.map(settingName).filter((x): x is string => x !== null);
      const meta = [names.length ? `人物：${names.join('、')}` : '', places.length ? `设定：${places.join('、')}` : ''].filter(Boolean).join('；');
      lines.push(`- ${b.title}${b.summary ? `：${b.summary}` : ''}${meta ? `（${meta}）` : ''}`);
    }
  }
  if (plan.endHook) lines.push(`结尾钩子：${plan.endHook}`);
  return lines.join('\n');
}

/** Titles-only rendering of chapter plans (used for far chapters). */
export function renderChapterTitles(plans: readonly ChapterPlan[]): string {
  return plans.map((p) => `第${p.chapterNo}章${p.title ? ` ${p.title}` : ''}`).join('；');
}
