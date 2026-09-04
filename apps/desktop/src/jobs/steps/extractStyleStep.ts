/**
 * extract_style（拆书，docs/writing/README.md §5.1）：
 *   metrics 本地统计（不用模型）→ LLM 分批归纳 voice/exemplars/negatives/人物言行/规矩 → 合并 → 写入
 *   StyleProfile、补全人物言行规格（只填空字段）、新增规矩类设定（lorebook）。
 */
import { emptyStyleProfile, targetsFromMetrics, type Setting } from '@the-water/shared';
import { getNovel } from '@/db/repos/novelsRepo';
import { listCurrentVersions } from '@/db/repos/chaptersRepo';
import { buildStorylineDoc, createSnapshot, setStyleProfile, upsertCharacter, upsertSetting } from '@/db/repos/storylineRepo';
import { requestJson } from '@/llm/json';
import { applyExtractToProfile, mergeStyleExtracts, styleExtractPrompt, type StyleExtractResult } from '@/llm/prompts/styleExtract';
import { constraintsFromTargets } from '@/llm/prompts/style';
import { computeStyleMetrics } from '@/novel/styleMetrics';
import { EXTRACT_STYLE } from '@/novel/config';
import { emitJobEvent } from '../events';
import type { StepHandler } from '../context';

/** 批大小 / 批数 / 每章节选长度都在 `novel/config.ts`（§2.3 第 4 条）。 */
const { batchChars: BATCH_CHARS, maxBatches: MAX_BATCHES, excerptPerChapter: EXCERPT_PER_CHAPTER } = EXTRACT_STYLE;

/** Pick chapters spread across the book: first three, then evenly spaced. */
export function sampleChapterNos(total: number, max: number = EXTRACT_STYLE.sampleChapters): number[] {
  if (total <= max) return Array.from({ length: total }, (_, i) => i + 1);
  const picked = new Set<number>([1, 2, 3]);
  const rest = max - picked.size;
  for (let i = 1; i <= rest; i++) picked.add(Math.min(total, Math.round(3 + (i * (total - 3)) / (rest + 1))));
  return [...picked].sort((a, b) => a - b);
}

export const extractStyleStep: StepHandler = async (ctx) => {
  const novel = await getNovel(ctx.job.novelId);
  if (!novel) throw new Error('小说不存在');
  const rows = (await listCurrentVersions(novel.id)).filter((r) => r.version && r.version.content.trim().length > 200);
  if (rows.length === 0) throw new Error('还没有可供拆书的正文');
  const doc = await buildStorylineDoc(novel.id, novel.premise, novel.meta.themes);
  const base = doc.styleProfile ?? emptyStyleProfile({ id: `extracted_${novel.id}`, name: `《${novel.origin?.sourceTitle ?? novel.title}》原著文风` });

  ctx.setMessage('正在统计原著的句长、段落与标点习惯');
  const nos = sampleChapterNos(rows.length);
  const sampled = rows.filter((r) => nos.includes(r.chapter.chapterNo));
  const metrics = computeStyleMetrics(sampled.map((r) => r.version!.content));
  const fidelity = doc.derivative?.styleFidelity ?? 0.85;
  const targets = targetsFromMetrics(metrics, fidelity);
  const metricsHint = [
    `平均句长 ${metrics.sentenceLength.mean} 字（起伏 ${metrics.burstiness}），平均段长 ${metrics.paragraphLength.mean} 字，对白占比 ${Math.round(metrics.dialogueRatio * 100)}%`,
    `每千字：感叹号 ${metrics.punctuationPerK['！'] ?? 0}，省略号 ${metrics.punctuationPerK['……'] ?? 0}，破折号 ${metrics.punctuationPerK['——'] ?? 0}`,
    metrics.ngramSignature.length ? `高频词组：${metrics.ngramSignature.join('、')}` : '',
  ].filter(Boolean).join('\n');

  // batches of excerpts (head of each sampled chapter)
  const excerpts = sampled.map((r) => ({ chapterNo: r.chapter.chapterNo, text: Array.from(r.version!.content).slice(0, EXCERPT_PER_CHAPTER).join('') }));
  const batches: Array<typeof excerpts> = [];
  let cur: typeof excerpts = [];
  let curChars = 0;
  for (const e of excerpts) {
    if (curChars + e.text.length > BATCH_CHARS && cur.length) { batches.push(cur); cur = []; curChars = 0; }
    cur.push(e);
    curChars += e.text.length;
  }
  if (cur.length) batches.push(cur);
  const known = doc.characters.map((c) => c.name);
  const results: StyleExtractResult[] = [];
  for (const [i, b] of batches.slice(0, MAX_BATCHES).entries()) {
    ctx.setMessage(`正在拆书（第 ${i + 1}/${Math.min(batches.length, MAX_BATCHES)} 批：第 ${b.map((x) => x.chapterNo).join('、')} 章）`);
    const spec = styleExtractPrompt({ title: novel.origin?.sourceTitle ?? novel.title, excerpts: b, knownCharacterNames: known, metricsHint });
    const r = await requestJson(ctx.provider, { ...spec, schema: spec.schema! }, { signal: ctx.signal, gate: ctx.gate, onDelta: (_d, acc) => ctx.onDelta(acc) });
    await ctx.recordUsage(r.usage);
    results.push(r.value);
  }
  const merged = mergeStyleExtracts(results);
  let profile = applyExtractToProfile({ ...base, metrics, targets }, merged, nos);
  if (profile.injection.humanReadableConstraints.length === 0) profile = { ...profile, injection: { ...profile.injection, humanReadableConstraints: constraintsFromTargets(profile) } };
  await setStyleProfile(novel.id, profile);

  // characters: fill empty voice fields only (user edits win)
  const byName = new Map(doc.characters.map((c) => [c.name, c] as const));
  for (const c of merged.characters) {
    const target = byName.get(c.name) ?? doc.characters.find((x) => x.aliases.includes(c.name));
    if (!target) continue;
    const idx = doc.characters.indexOf(target);
    await upsertCharacter(novel.id, {
      ...target,
      speechSamples: target.speechSamples.length ? target.speechSamples : c.speechSamples,
      verbalTics: target.verbalTics.length ? target.verbalTics : c.verbalTics,
      addressBook: Object.keys(target.addressBook).length ? target.addressBook : c.addressBook,
      redlines: target.redlines.length ? target.redlines : c.redlines,
    }, idx);
  }
  // lore: add rule-like settings not yet present
  const existingNames = new Set(doc.settings.map((s) => s.name));
  let order = doc.settings.length;
  for (const l of merged.lore) {
    if (existingNames.has(l.name)) continue;
    const setting: Partial<Setting> & { name: string } = { name: l.name, kind: l.kind, description: l.content, triggerKeys: l.triggerKeys.length ? l.triggerKeys : [l.name], priority: l.kind === 'rule' ? 70 : 50, constant: false };
    await upsertSetting(novel.id, setting, order++);
  }
  const after = await buildStorylineDoc(novel.id, novel.premise, novel.meta.themes);
  const snap = await createSnapshot(novel.id, after, 'generated');
  emitJobEvent({ type: 'novel:storylineUpdated', novelId: novel.id });
  return { outputRef: snap.id };
};
