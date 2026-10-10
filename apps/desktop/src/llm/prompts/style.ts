/**
 * Render a StyleProfile / DerivativeDecl into prompt text (docs/writing/README.md §4.5, §5.2).
 * - system: ≤ summaryBudget chars of human-readable constraints + voice summary
 * - user: exemplars for the scene type + negatives (its own budgeted section in context.ts)
 */
import { DERIVATIVE_KIND_LABEL, VOICE_DIMENSIONS, VOICE_DIMENSION_LABEL, type DerivativeDecl, type SceneType, type StyleProfile } from '@the-water/shared';

function clip(s: string, max: number): string {
  const cps = Array.from(s.trim());
  return cps.length <= max ? cps.join('') : cps.slice(0, max).join('') + '…';
}

/** Compact style block for the system prompt. Never exceeds `summaryBudget` code points (plus header). */
export function renderStyleSummary(profile: StyleProfile): string {
  const budget = profile.injection.summaryBudget;
  const lines: string[] = [];
  let used = 0;
  const push = (line: string) => {
    const n = Array.from(line).length + 1;
    if (used + n > budget) return false;
    lines.push(line);
    used += n;
    return true;
  };
  for (const c of profile.injection.humanReadableConstraints) if (!push(`- ${c}`)) break;
  for (const d of VOICE_DIMENSIONS) {
    const t = profile.voice[d].text.trim();
    if (!t) continue;
    if (!push(`- ${VOICE_DIMENSION_LABEL[d]}：${clip(t, 80)}`)) break;
  }
  for (const m of profile.voice.signatureMoves) {
    const [lo, hi] = m.frequencyPerChapter;
    if (!push(`- 招牌动作：${clip(m.move, 60)}（每章 ${lo}–${hi} 次，不要更多）`)) break;
  }
  if (lines.length === 0) return '';
  const title = profile.name ? `【文风：${profile.name}】` : '【文风】';
  return `${title}\n${lines.join('\n')}`;
}

export function renderDerivativeNotice(decl: DerivativeDecl, sourceTitle: string | null): string {
  const kind = DERIVATIVE_KIND_LABEL[decl.kind];
  const lines = [
    `这是${sourceTitle ? `《${sourceTitle}》` : '原著'}的${kind}，读者${decl.audience === 'fans' ? '是原著读者，他们会立刻察觉腔调、句式、称呼的任何变化' : '包括没读过原著的人，但仍需保持原著的味道'}。`,
  ];
  if (decl.divergencePoint) lines.push(`分歧点：${decl.divergencePoint}`);
  if (decl.mustKeep.length) lines.push(`必须保持不变：${decl.mustKeep.join('；')}`);
  if (decl.allowedChanges.length) lines.push(`允许改动：${decl.allowedChanges.join('；')}`);
  return `【二创声明】\n${lines.join('\n')}`;
}

/** Pick exemplars for a scene type: same type first, then others, up to `count`. */
export function pickExemplars(profile: StyleProfile, sceneType: SceneType | null, count = profile.injection.exemplarCount): StyleProfile['exemplars'] {
  if (count <= 0) return [];
  const same = profile.exemplars.filter((e) => sceneType && e.sceneType === sceneType);
  const rest = profile.exemplars.filter((e) => !same.includes(e));
  return [...same, ...rest].slice(0, count);
}

/** User-side block: exemplars + negatives. Empty string when nothing to show. */
export function renderStyleUserBlock(profile: StyleProfile, sceneType: SceneType | null, derivative = false): string {
  const parts: string[] = [];
  const ex = pickExemplars(profile, sceneType);
  if (ex.length > 0) {
    parts.push(derivative ? '以下是原著段落，参照其节奏、腔调与用词习惯，不要照抄内容：' : '以下是本作品的文风参照，保持叙述声音，按当前场景调整节奏，不要照抄内容：');
    ex.forEach((e, i) => parts.push(`（示例 ${i + 1}${e.illustrates.length ? '，体现：' + e.illustrates.join('、') : ''}）\n${e.text.trim()}`));
  }
  const neg = profile.negatives;
  const negLines: string[] = [];
  if (neg.avoidWords.length) negLines.push(`不要出现这些词：${neg.avoidWords.join('、')}`);
  if (neg.avoidWordsSoft.list.length) negLines.push(`尽量少用（每千字不超过 ${neg.avoidWordsSoft.limitPerK} 次）：${neg.avoidWordsSoft.list.slice(0, 30).join('、')}`);
  if (neg.avoidPatterns.length) negLines.push(`不要用这些句式：${neg.avoidPatterns.join('；')}`);
  for (const a of neg.antiExemplars.slice(0, 2)) negLines.push(`反例（不要这样写）：「${clip(a.text, 120)}」${a.why ? '——' + a.why : ''}`);
  if (negLines.length) parts.push(negLines.join('\n'));
  return parts.join('\n\n');
}

/** Human-readable metric constraints derived from targets, for profiles that have no hand-written constraints. */
export function constraintsFromTargets(profile: StyleProfile): string[] {
  const t = profile.targets;
  const out: string[] = [];
  if (t.sentenceMean) out.push(`句子平均 ${Math.round(t.sentenceMean[0])}–${Math.round(t.sentenceMean[1])} 字，长短交错`);
  if (t.dialogueRatio) out.push(`对白约占全文 ${Math.round(t.dialogueRatio[0] * 100)}%–${Math.round(t.dialogueRatio[1] * 100)}%`);
  if (t.paragraphMean) out.push(`段落平均 ${Math.round(t.paragraphMean[0])}–${Math.round(t.paragraphMean[1])} 字`);
  if (t.exclamationPerK && t.exclamationPerK[1] < 4) out.push(`感叹号每千字不超过 ${Math.ceil(t.exclamationPerK[1])} 个`);
  if (t.ellipsisPerK && t.ellipsisPerK[1] < 5) out.push(`省略号每千字不超过 ${Math.ceil(t.ellipsisPerK[1])} 个`);
  return out;
}
