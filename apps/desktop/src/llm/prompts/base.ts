/**
 * Shared building blocks for all prompt templates (plan §3.3).
 */
import type { DerivativeDecl, StyleProfile } from '@the-water/shared';
import type { NovelRequirements } from '@/novel/types';
import type { ChatMessage } from '@/llm/types';
import { docTypeGuide } from '@/novel/docTypes';
import { isEmptyGenre, mergedGenreOf, type MergedGenre } from '@/novel/genrePacks';
import { renderDerivativeNotice, renderStyleSummary } from './style';
import { renderAuthorNote } from './authorNote';
import { STORY_FIRST_RULE } from '@/novel/storyQuality';
import { CHARACTER_DESIGN_RULE } from '@/novel/characterDesign';
import { UNTRUSTED_GUARD_RULE } from './untrusted';

/** Style-layer inputs shared by every prose prompt (docs/writing/README.md §4.5 / §5.2). */
export interface StyleExtras {
  profile?: StyleProfile | null;
  derivative?: DerivativeDecl | null;
  sourceTitle?: string | null;
  /** 这本书的「作者附加指令」（§2.3 第 6 条）；由 `llm/prompts/authorNote.ts` 提供。 */
  authorNote?: string | null;
}

export const FORMAT_RULES = '只输出正文，不要章节标题、序号、说明或元评论；段落之间用一个空行分隔；使用中文标点。';

export const JSON_ONLY_RULE = '只输出一个合法的 JSON，不要使用 Markdown 代码围栏，不要在 JSON 前后添加任何说明文字。';

export const READER_GROUNDING_RULE = '【读者理解与人物动机】\n读者看不到创作资料。新故事开篇要通过当前行动、对话或有触发的短回忆，交代人物处境、眼前任务及失败的具体代价；不要仅用暗号、意象和悬念代替背景。人物的重要选择须让读者看到触发信息、情绪/身体反应、权衡与行动的因果联系，不用抽象性格标签代替刻画。只呈现计划与已确认资料支持的经历，不能自行增改身世、规则或结局；秘密真相仍按计划揭示。背景适量嵌入，不写设定百科；关键冲突展开，普通动作简写，避免每句话都堆比喻。后续章只补理解当前选择所必需的背景，不重复整段前情。';

/** 题材/风格/视角/时态/基调/受众/语言/禁忌/必须包含/额外要求，逐行列出（空项省略）。 */
export function requirementsBlock(req: NovelRequirements): string {
  const lines: string[] = [];
  const push = (label: string, value: string) => {
    const v = value.trim();
    if (v) lines.push(`${label}：${v}`);
  };
  push('题材', req.genre);
  push('风格', req.style);
  push('视角', req.pov);
  push('时态', req.tense);
  push('基调', req.tone);
  push('受众', req.audience);
  push('语言', req.language || '简体中文');
  const taboos = req.taboos.map((t) => t.trim()).filter(Boolean);
  if (taboos.length > 0) lines.push(`绝对禁止出现：${taboos.join('、')}`);
  const must = req.mustHave.map((t) => t.trim()).filter(Boolean);
  if (must.length > 0) lines.push(`必须包含：${must.join('、')}`);
  push('额外要求', req.extra);
  return lines.join('\n');
}

/** Doc-type writing rules as one block (empty for the default type with no extra rules). */
export function docTypeBlock(req: NovelRequirements): string {
  const g = docTypeGuide(req.docType);
  if (g.writingRules.length === 0) return '';
  return `【${g.label}·写法】\n${g.writingRules.map((r) => `- ${r}`).join('\n')}`;
}

/** Every selected pack reaches prose; caller budget checks handle overflow instead of silently dropping later packs. */
export function genreBlock(m: MergedGenre): string {
  if (isEmptyGenre(m)) return '';
  const lines = m.writingRules.map((r) => `- ${r}`);
  if (m.forbiddenWords.length > 0) lines.push(`- 不要出现这些词：${m.forbiddenWords.slice(0, 24).join('、')}`);
  if (m.forbiddenPatterns.length > 0) lines.push(`- 不要用这些句式：${m.forbiddenPatterns.slice(0, 6).join('；')}`);
  if (lines.length === 0) return '';
  return `【题材惯例·${m.labels.join(' + ')}（创作指导，本书设定优先）】\n${lines.join('\n')}`;
}

/** System prompt shared by every prose-writing template. Style profile / derivative notice are appended when present. */
export function systemBase(req: NovelRequirements, extras: StyleExtras = {}): string {
  const block = requirementsBlock(req);
  const g = docTypeGuide(req.docType);
  const role = g.fiction ? '你是一位专业的中文小说作家，文笔成熟，擅长长篇连载。' : `你是一位专业的中文写作者，擅长${g.label}，结构清晰、言之有物。`;
  const derivative = extras.derivative ? renderDerivativeNotice(extras.derivative, extras.sourceTitle ?? null) : '';
  const style = extras.profile ? renderStyleSummary(extras.profile) : '';
  const genre = g.fiction ? genreBlock(mergedGenreOf(req)) : '';
  // 作者附加指令排在文风之后、输出格式之前：它可以覆盖通用要求，但改不了输出格式。
  const authorNote = renderAuthorNote(extras.authorNote);
  return [role, '【创作要求】', block, docTypeBlock(req), g.fiction ? READER_GROUNDING_RULE : '', g.fiction ? STORY_FIRST_RULE : '', g.fiction ? CHARACTER_DESIGN_RULE : '', genre, derivative, style, authorNote, '【输出格式】', FORMAT_RULES, UNTRUSTED_GUARD_RULE]
    .filter((s) => s.length > 0)
    .join('\n');
}

/** System prompt shared by planning/editing templates that emit JSON. */
export function planningSystem(role: string, req: NovelRequirements): string {
  const block = requirementsBlock(req);
  return [role, block ? '【创作要求】\n' + block : '', JSON_ONLY_RULE].filter((s) => s.length > 0).join('\n');
}

export function takeLast<T>(xs: readonly T[], n: number): T[] {
  return n <= 0 ? [] : xs.slice(Math.max(0, xs.length - n));
}

export function bullets(items: readonly string[]): string {
  return items
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => `- ${s}`)
    .join('\n');
}

export function section(header: string, body: string): string {
  const b = body.trim();
  return b ? `【${header}】\n${b}` : '';
}

export function joinSections(parts: readonly string[]): string {
  return parts.filter((p) => p.trim().length > 0).join('\n\n');
}

export function sys(content: string): ChatMessage {
  return { role: 'system', content };
}
export function user(content: string): ChatMessage {
  return { role: 'user', content };
}
