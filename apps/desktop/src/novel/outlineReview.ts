import { OUTLINE_REVIEW_DIMENSIONS, OutlineReviewSchema, OutlineReviewStateSchema, outlineReviewSignature, hashStoryline, type OutlineReviewState } from '@the-water/shared';
import { getDb, now, selectOne, writeAtomic, type AtomicWriter } from '@/db/db';
import { getNovel } from '@/db/repos/novelsRepo';
import { listDocumentPlans, proposeDocumentPlan, type DocumentPlanProposal } from '@/db/repos/planProposalsRepo';
import { buildStorylineDoc } from '@/db/repos/storylineRepo';
import { listWritingCards } from '@/db/repos/writingRepo';
import { loadStoryWorkspace } from '@/db/repos/storyGraphRepo';
import { getSetting } from '@/db/repos/settingsRepo';
import { assertBudget, recordUsage } from '@/db/repos/usageRepo';
import { providersForPurposes } from '@/jobs/runner';
import { emitJobEvent } from '@/jobs/events';
import { requestJson, schemaReserveTokens } from '@/llm/json';
import { estimateMessagesTokens } from '@/llm/tokens';
import { LLMError, type LLMProvider, type Usage } from '@/llm/types';
import type { RateGate } from '@/llm/retry';
import { UNTRUSTED_GUARD_RULE, wrapUntrusted } from '@/llm/prompts/untrusted';
import { requirementsBlock } from '@/llm/prompts/base';
import { OUTLINE_REVIEW_RULE, OUTLINE_DESIGN_RULES } from './outlineQuality';
import { docTypeGuide } from './docTypes';

const running = new Map<string, Promise<void>>();
const controllers = new Set<AbortController>();
let suspended = false;
export async function suspendOutlineReviewsForRestore() { suspended = true; for (const c of controllers) c.abort(); await Promise.allSettled([...running.values()]); }
export async function outlineReviewInput(novelId: string, p: DocumentPlanProposal) {
  const novel = await getNovel(novelId); if (!novel) throw new Error('作品不存在 / Work unavailable');
  const currentBaseHash = await hashStoryline(await buildStorylineDoc(novelId, novel.premise, novel.meta.themes));
  const currentCardsHash = await outlineReviewSignature((await listWritingCards(novelId, { confirmed: true })).filter(c => ['brief','volume','character','thread'].includes(c.kind)));
  const independentWork = p.meta.storyOptionIndependent === true && p.meta.storyOptionMode === 'restructure' && (p.meta.storyOptionScope as { kind?: string } | undefined)?.kind === 'work';
  const w = independentWork ? await loadStoryWorkspace(novelId) : null;
  const lockedEntities = w ? [...w.characters, ...w.settings, ...w.arcs, ...w.beats, ...w.chapters, ...w.cards].filter(e => w.graph.lockedNodeIds.includes(e.id)) : [];
  return { currentBaseHash, currentCardsHash, author: { title: novel.title, premise: novel.premise, requirements: novel.requirements, targetChars: novel.targetChars, authorNote: await getSetting(`authorNote:${novelId}`, ''), explorationMaterials: p.meta.storyOptionAuthorMaterials ?? '' }, scope: p.meta.storyOptionScope ?? { kind: 'work', id: novelId }, mode: p.meta.storyOptionMode ?? 'restructure', selectedDirection: p.meta.selectedStoryOption ?? null, planningStage: p.meta.storyOptionStage ?? 'outline', downstreamImpact: p.meta.downstreamImpact ?? [], outline: { title: p.title ?? novel.title, logline: p.meta.logline, after: independentWork ? { ...p.after, chapters: [] } : p.after, cards: p.cards ?? [] }, outsideConstraints: { before: independentWork ? null : p.before, lockedEntities } };
}
function strings(v: unknown): string[] { return typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : []; }
export function outlineReviewPrompt(input: Awaited<ReturnType<typeof outlineReviewInput>>) {
  const sourceStrings = strings(input);
  const outputContract = `checks 的 dimension 必须严格按以下顺序填写，每项恰好一次：${OUTLINE_REVIEW_DIMENSIONS.join(", ")}。不要用重复维度替代 writeability 或 form。excerpt 只能复制输入字段的字符串值中的连续文字，字段名、ID、空数组不是内容证据；材料未提供时用 needs_information 和空 evidence，不引用字段名。返回前核对十二个 dimension 和每条 excerpt。判断缺失前交叉阅读 premise、设定、弧线摘要与卡片：人物动机或关系变化可在摘要中提供，人物数组为空不等于没有人物；缺少 beats/章节表不等于创作总纲无法写作。无特殊物件功能时不要求解释饭盒等日常物件的性质。不要求每个维度都有 finding；已提供的事实不得再称缺失，额外细化建议列为 optional。findings.kind 按事实分类：两条已提供事实相互不能成立用 contradiction；判断所需事实没提供用 missing_information；可以成立但个人偏好不同用 aesthetic_choice。违反明确时间线或硬约束不是审美选择。priority=critical 不允许与 aesthetic_choice 配对。重生人物可通过记忆知道未来，不能将知道未来本身当作矛盾；必须分别检查知识与物件是否可取得。`;
  const schema = OutlineReviewSchema.superRefine((r, ctx) => {
    for (const [key, rows] of [['checks', r.checks], ['findings', r.findings]] as const) rows.forEach((row, i) => row.evidence.forEach((e, j) => {
      if (!sourceStrings.some(text => text.includes(e.excerpt))) ctx.addIssue({ code: 'custom', path: [key, i, 'evidence', j, 'excerpt'], message: '引用在输入中不存在，请逐字引用短片段，不能补造依据' });
    }));
  });
  return { messages: [{ role: 'system' as const, content: `你是独立审查大纲的编辑，不是生成者。${docTypeGuide(input.author.requirements.docType).fiction ? OUTLINE_REVIEW_RULE : OUTLINE_DESIGN_RULES}\n${UNTRUSTED_GUARD_RULE}\n${outputContract}\n只返回 JSON。报告以具体且简明为准，每项检查通常1–2句，引用短片段；数组上限不是数量要求，不填充重复发现。完整覆盖维度和核心问题，不把资料重写成小说。十二个 checks 各出现一次；不适用应解释理由。证据引用输入中逐字存在的短片段，并给作者可读的位置，不只写技术 ID。causalChains 与 timeline 追踪核心转折与关键物件，不把缺失信息补成事实。critical 仅用于导致核心转折/结局不成立的明确矛盾或妨碍判断的关键信息缺失；审美选择永远不阻止作者采纳。总体摘要不能声称所有文学质量已验证。抽卡细化的大纲阶段保留的旧章节表与正文是下一步需要另行调整的参考，新大纲与这些旧计划不同仅记录后续影响，不当成新大纲自身的关键矛盾；检查新大纲内部与硬约束是否成立。检查当前已保存大纲时则检查设定、故事弧和章节计划之间是否一致。重构允许范围内替代走向，不能把与旧正文不同当作错误；保留范围外及明确锁定约束。` }, { role: 'user' as const, content: `请独立审查最终大纲。\n${requirementsBlock(input.author.requirements)}\n文体：${docTypeGuide(input.author.requirements.docType).label}\n${wrapUntrusted('待审大纲与作者约束', JSON.stringify(input))}` }], schema, label: '独立大纲审查 / Independent outline review', temperature: 0.2 };
}
export async function reviewOutlineProposal(novelId: string, id: string, opts: { force?: boolean; provider?: LLMProvider; account?: (usage: Usage) => Promise<void>; signal?: AbortSignal; gate?: RateGate; commit?: AtomicWriter } = {}): Promise<void> {
  if (suspended) throw new Error('数据库恢复中 / Database restore in progress');
  const key = `${novelId}:${id}`; if (running.has(key)) return running.get(key)!;
  const task = (async () => {
    let p = (await listDocumentPlans(novelId)).find(p => p.id === id); if (!p || p.meta.outlineDone !== true) throw new Error('待审大纲不存在 / Pending outline unavailable');
    const input = await outlineReviewInput(novelId, p), signature = await outlineReviewSignature(input);
    if (input.currentBaseHash !== p.baseHash) throw new Error('基础计划已变化，请生成新的大纲建议或重新检查当前大纲 / Base plan changed; create a fresh proposal or inspect the current outline');
    const previous = OutlineReviewStateSchema.safeParse(p.meta.outlineReview);
    if (!opts.force && previous.success && previous.data.state === 'complete' && previous.data.signature === signature) return;
    const commit = opts.commit ?? writeAtomic;
    const update = async (review: OutlineReviewState) => {
      const row = await selectOne<{ json: string }>("SELECT json FROM writing_proposals WHERE id=? AND novel_id=? AND state='pending'", [id, novelId]);
      if (!row) throw new Error('建议已被采纳或丢弃 / Proposal already resolved');
      const current = JSON.parse(row.json) as DocumentPlanProposal;
      if (await outlineReviewSignature(await outlineReviewInput(novelId, current)) !== signature) throw new Error('大纲或作者约束已变化，请重新检查 / Outline or constraints changed; review again');
      p = { ...current, meta: { ...current.meta, outlineReviewRequired: true, outlineReview: review } };
      await commit([{ sql: "UPDATE writing_proposals SET json=? WHERE id=? AND novel_id=? AND state='pending' AND json=?", params: [JSON.stringify(p), id, novelId, row.json], expectedRows: 1 }]);
      emitJobEvent({ type: 'plan:proposed', novelId });
    };
    const controller = new AbortController(); controllers.add(controller); const abort = () => controller.abort(); opts.signal?.addEventListener('abort', abort, { once: true }); if (opts.signal?.aborted) abort();
    let provider: LLMProvider | undefined;
    try {
      await update({ state: 'running', signature, error: null, report: null, reviewedAt: now() });
      await assertBudget(novelId);
      provider = opts.provider ?? (await providersForPurposes({ params: { providerIds: await (await import('./service')).getNovelProviders(novelId) }, providerId: null }, ['planning'])).planning!;
      const spec = outlineReviewPrompt(input);
      const available = provider.caps.contextWindow - estimateMessagesTokens(spec.messages, provider.caps.cjkTokenRatio) - schemaReserveTokens(spec.schema, provider.caps) - (provider.caps.reasoningTokens ?? 0) - 1500;
      const maxTokens = Math.min(32000, provider.caps.maxOutputTokens - (provider.caps.reasoningTokens ?? 0), available);
      if (maxTokens <= 0) throw new Error('大纲审查材料超出模型窗口或输出预算 / Outline review exceeds model budget');
      const account = opts.account ?? ((usage: Usage) => recordUsage({ novelId, usage, purpose: 'planning', model: provider!.model, providerKind: provider!.kind, providerId: provider!.id }));
      const result = await requestJson(provider, { ...spec, maxTokens }, { signal: controller.signal, gate: opts.gate });
      await account(result.usage);
      await update({ state: 'complete', signature, error: null, report: result.value, reviewedAt: now() });
    } catch (e) {
      if (e instanceof LLMError && e.usage && provider) await (opts.account ?? ((usage: Usage) => recordUsage({ novelId, usage, purpose: 'planning', model: provider!.model, providerKind: provider!.kind, providerId: provider!.id })))(e.usage);
      await update({ state: controller.signal.aborted ? 'interrupted' : 'failed', signature, error: e instanceof Error ? e.message : String(e), report: null, reviewedAt: now(), rawOutput: e instanceof LLMError ? e.raw ?? null : null });
      throw e;
    } finally { controllers.delete(controller); opts.signal?.removeEventListener('abort', abort); }
  })().finally(() => running.delete(key)); running.set(key, task); return task;
}

/** Read-only inspection of an existing plan; report persistence never adopts or changes story entities. */
const inspections = new Map<string, Promise<string>>();
export async function inspectCurrentOutline(novelId: string): Promise<string> {
  if (inspections.has(novelId)) return inspections.get(novelId)!;
  const request = inspectCurrentOutlineOnce(novelId).finally(() => inspections.delete(novelId)); inspections.set(novelId, request); return request;
}
async function inspectCurrentOutlineOnce(novelId: string): Promise<string> {
  const novel = await getNovel(novelId); if (!novel) throw new Error('作品不存在 / Work unavailable');
  const after = await buildStorylineDoc(novelId, novel.premise, novel.meta.themes);
  const cards = (await listWritingCards(novelId, { confirmed: true })).filter(c => ['brief','volume','character','thread'].includes(c.kind)).map(c => ({ id: c.id, revision: c.revision, before: c, after: c }));
  const pending = (await listDocumentPlans(novelId)).find(p => p.meta.outlineReviewOnly === true && JSON.stringify(p.after) === JSON.stringify(after) && p.meta.logline === novel.meta.logline && JSON.stringify(p.cards ?? []) === JSON.stringify(cards));
  const id = pending?.id ?? await proposeDocumentPlan(novelId, after, '检查当前大纲 / Inspect current outline', { outlineDone: true, logline: novel.meta.logline, outlineReviewOnly: true, outlineReviewRequired: true }, novel.title, cards);
  await reviewOutlineProposal(novelId, id); return id;
}

export async function recoverOutlineReviews() {
  await getDb().execute("UPDATE writing_proposals SET json=json_set(json,'$.meta.outlineReview.state','interrupted','$.meta.outlineReview.error','请求中断，可重试 / Interrupted; retry available') WHERE state='pending' AND json_extract(json,'$.meta.outlineReview.state')='running'");
}
