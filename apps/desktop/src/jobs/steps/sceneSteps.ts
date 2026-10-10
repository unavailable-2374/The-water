import { genreOutlineBlock } from '@/llm/prompts/outline';
import { mergedGenreOf } from '@/novel/genrePacks';
import { z } from 'zod';
import { docTypeGuide } from '@/novel/docTypes';
import { CHARACTER_PLANNING_RULE } from '@/novel/characterDesign';
import { PLOT_PLANNING_RULE } from '@/novel/plotDesign';
import { ScenePlanSchema, countZh } from '@the-water/shared';
import { createVersion, findVersionByStep } from '@/db/repos/chaptersRepo';
import { chapterDependencies, listWritingCards, listPlanProposals, listCanonEvents } from '@/db/repos/writingRepo';
import { sceneReferenceIssues } from '@/novel/sceneReferences';
import { getDb, now } from '@/db/db';
import { requestJson, schemaReserveTokens } from '@/llm/json';
import { completeWithRetry } from '@/llm/complete';
import { estimateMessagesTokens } from '@/llm/tokens';
import { sys, user, systemBase, JSON_ONLY_RULE } from '@/llm/prompts/base';
import { wrapUntrusted, UNTRUSTED_GUARD_RULE } from '@/llm/prompts/untrusted';
import { maxTokensForChapter } from '@/novel/wordBudget';
import { AwaitingReviewError } from '../awaitingReview';
import type { StepHandler } from '../context';
import { buildChapterContextText, loadChapterEnv, styleExtrasOf } from './common';
import { nanoid } from 'nanoid';
import { emitJobEvent } from '../events';

const requiredSceneText = z.string().trim().min(1).max(12000);
const generatedScene = ScenePlanSchema.extend({
  readerInterest:requiredSceneText,choice:requiredSceneText,choiceReason:requiredSceneText,
  consequence:requiredSceneText,beforeState:requiredSceneText,afterState:requiredSceneText,
  presentation:z.enum(['dramatize','summarize']),
});
const SceneBatch = z.object({
  chapters: z
    .array(z.object({ chapterId: z.string(), scenes: z.array(generatedScene).min(1).max(12) }))
    .min(1)
    .max(5),
});
export const scenePlanStep: StepHandler = async (ctx) => {
  const env = await loadChapterEnv(ctx);
  ctx.setMessage(`正在规划第 ${env.chapter.chapterNo} 章及后续章节的场景`);
  const existing = await listWritingCards(env.novel.id, {
    kind: 'scene',
    chapterId: env.chapter.id,
    confirmed: true,
  });

  const pending = await getDb().select<{ id: string }>(
    "SELECT id FROM writing_proposals WHERE novel_id=? AND chapter_id=? AND kind='plan' AND state='pending'",
    [env.novel.id, env.chapter.id],
  );
  if (pending.length) throw new AwaitingReviewError('本章场景建议已生成，请在章节页审阅并采纳',{kind:'proposal'});
  if (
    (await listWritingCards(env.novel.id, { kind: 'scene', chapterId: env.chapter.id, confirmed: false }))
      .length
  )
    throw new AwaitingReviewError('本章仍有待核对的场景卡，请先确认',{kind:'proposal'});
  if (existing.length) return { outputRef: existing[0]!.id };
  const confirmedCards = await listWritingCards(env.novel.id, { confirmed: true });
  const brief = confirmedCards.find((c) => c.kind === 'brief');
  const window = env.chapters
    .filter((c) => c.chapterNo >= env.chapter.chapterNo && (!Array.isArray(ctx.job.params.assistantChapterIds) || ctx.job.params.assistantChapterIds.includes(c.id)))
    .slice(0, brief?.kind === 'brief' ? brief.data.rollingChapters : 5);
  const outstanding = await listPlanProposals(env.novel.id);
  const needed: typeof window = [];
  for (const c of window)
    if (
      !(await listWritingCards(env.novel.id, { kind: 'scene', chapterId: c.id })).length &&
      !outstanding.some((p) => p.chapterId === c.id)
    )
      needed.push(c);
  const planningDependencies = await Promise.all(
    needed.map((c) => chapterDependencies(env.novel.id, c.chapterNo)),
  );
  const context = await buildChapterContextText(env, ctx.provider, 10000);
  const planningReferences = {
    characters: env.doc.characters,
    characterIntents: confirmedCards.filter(c => c.kind === 'character'),
    arcs: env.doc.arcs,
    volumes: confirmedCards.filter(
      (c) =>
        c.kind === 'volume' &&
        c.data.endChapterNo >= env.chapter.chapterNo &&
        c.data.startChapterNo <= window.at(-1)!.chapterNo,
    ),
    threads: confirmedCards.filter((c) => c.kind === 'thread'),
    canonEventsByChapter: await Promise.all(needed.map(async c => ({ chapterId: c.id, events: await listCanonEvents(env.novel.id, c.chapterNo) }))),
  };
  const schema = SceneBatch.superRefine((batch, check) => {
    if (batch.chapters.length !== needed.length || new Set(batch.chapters.map(c => c.chapterId)).size !== needed.length)
      check.addIssue({ code: 'custom', path: ['chapters'], message: '必须恰好返回待规划章节集合，不得遗漏或重复' });
    batch.chapters.forEach((row, i) => {
      const chapter = needed.find(c => c.id === row.chapterId);
      if (!chapter) { check.addIssue({ code: 'custom', path: ['chapters', i, 'chapterId'], message: 'chapterId 必须来自待规划章节' }); return; }
      const refs = {
        characterIds: new Set(planningReferences.characters.map(c => c.id)),
        volumes: new Map(planningReferences.volumes.flatMap(c => c.kind === 'volume' ? [[c.id, c.data] as const] : [])),
        threadIds: new Set(planningReferences.threads.map(c => c.id)),
        factIds: new Set(planningReferences.canonEventsByChapter.find(c => c.chapterId === chapter.id)!.events.map(e => e.id)),
      };
      for (const card of planningReferences.threads) if (card.kind==='thread' && card.data.milestones?.some(m=>m.chapterNo===chapter.chapterNo) && !row.scenes.some(scene=>scene.threadIds.includes(card.id)))
        check.addIssue({code:'custom',path:['chapters',i,'scenes'],message:`场景遗漏本章计划伏笔阶段：${card.data.title}`});
      row.scenes.forEach((scene, j) => sceneReferenceIssues(scene, refs, chapter.chapterNo).forEach(issue =>
        check.addIssue({ code: 'custom', path: ['chapters', i, 'scenes', j, issue.field], message: issue.message })));
    });
  });
  const messages = [
    sys(
      `根据已确认主线与分卷，为给定的最多五章细化场景。分卷范围必须一致，不得改变已确认设定或结局。文体框架（例如 Save the Cat 八拍）作用于整部作品，不得在每一章重复一整套起承转合；按当前章在全书中的职责规划场景，不提前兑现后续章节。每章通常 2–4 个有完整事件的场景，避免将同一次对话拆成重复的小节；确有独立事件才增加。每场景有明确动机、目标、阻力、转折和结果：goal 同时写明读者此刻在意什么，turn 写关键选择或理解/关系变化，outcome 写变化、阶段满足及引出的后果；平静相处也可推进。povCharacterId/characterIds 仅使用 characters 人物 ID，volumeId 仅使用 volumes 分卷卡 ID，threadIds 仅使用 threads 伏笔卡 ID。dependencyIds 仅使用 canonEventsByChapter 中对应章节的正文事实 ID，绝不使用 settings/characters/arcs/volumes/brief 或未来计划 ID；事实列表为空必须填 []，其他未知引用填 null/[]。返回 chapters:[{chapterId,scenes:[{title,volumeId,povCharacterId,time,location,characterIds,goal,obstacle,turn,outcome,targetChars,dependencyIds,threadIds}]}]。${docTypeGuide(env.novel.requirements.docType).outlineRules.join("\n")}\n${genreOutlineBlock(mergedGenreOf(env.novel.requirements))}\n${JSON_ONLY_RULE}`,
    ),
    user(
      `${context}\n本次规划引用：${JSON.stringify(planningReferences)}\n待规划章节：${JSON.stringify(needed.map((c) => ({ chapterId: c.id, chapterNo: c.chapterNo, title: c.title, goal: c.goal, endHook: c.endHook, targetChars: c.targetChars })))}`,
    ),
  ];
  if (docTypeGuide(env.novel.requirements.docType).fiction) messages[0]!.content += `\n${CHARACTER_PLANNING_RULE}\n${PLOT_PLANNING_RULE}`;
  messages[0]!.content += '\nthreads 中 milestones 是全书伏笔阶段。当前章节命中的每个阶段，至少一个场景的 threadIds 必须引用该伏笔 ID，场景目标/结果应呈现相应 detail。不得将未来 payoff 提前写成真相；已埋设只推进，不重复开局。';
  messages[0]!.content += '\n章节与场景字数均为创作参考。按关键选择与互动安排篇幅，大场景可很长、过渡可很短，不平均切分、不要求场景字数之和等于章节参考。重要事件尽量在完整章节中呈现，避免为了凑章数拆成零碎残章。';
  messages[0]!.content += '\n每个新场景必须另给 readerInterest（读者在意的问题）、choice（人物主动选择，包括有依据的不行动）、choiceReason（触发和权衡）、consequence（这次选择造成什么后果）、beforeState/afterState（处境、关系、知识或理解的具体变化）、presentation（重要选择与互动用 dramatize；过渡用 summarize）。检查相邻场景是否只是重复同一争执或手续，合并无新变化的段落。变化须是本场能呈现的，不能只写“为后文铺垫”；允许平静互动和情感积累，不要求强行反转。';
  if (
    estimateMessagesTokens(messages, ctx.provider.caps.cjkTokenRatio) +
      schemaReserveTokens(SceneBatch, ctx.provider.caps) +
      10000 +
      (ctx.provider.caps.reasoningTokens ?? 0) +
      1500 >
    ctx.provider.caps.contextWindow
  )
    throw new AwaitingReviewError('滚动规划必需资料超出模型窗口，请使用更大窗口的模型');
  const r = await requestJson(
    ctx.provider,
    {
      messages,
      schema,
      maxTokens: 10000,
      temperature: 0.5,
      label: '滚动规划未来五章',
    },
    { signal: ctx.signal, gate: ctx.gate },
  );
  await ctx.recordUsage(r.usage);
  if (
    r.value.chapters.length !== needed.length ||
    new Set(r.value.chapters.map((c) => c.chapterId)).size !== needed.length ||
    r.value.chapters.some((c) => !needed.some((n) => n.id === c.chapterId))
  )
    throw new Error('场景规划返回了错误的章节集合');
  // A crash or concurrent plan change cannot leave half a rolling window staged.
  await (ctx.commit ?? (ops => getDb().atomic(ops)))([
    ...planningDependencies.map((d) => d.guard),
    ...needed.map((c) => ({
      sql: "UPDATE chapters SET id=id WHERE id=? AND NOT EXISTS(SELECT 1 FROM writing_cards WHERE chapter_id=? AND kind='scene') AND NOT EXISTS(SELECT 1 FROM writing_proposals WHERE chapter_id=? AND kind='plan' AND state='pending')",
      params: [c.id, c.id, c.id],
      expectedRows: 1,
    })),
    ...r.value.chapters.flatMap((row) =>
      row.scenes.map((scene, order) => ({
        sql: "INSERT INTO writing_proposals(id,novel_id,chapter_id,kind,json,created_at) VALUES (?,?,?,'plan',?,?)",
        params: [
          nanoid(),
          env.novel.id,
          row.chapterId,
          JSON.stringify({ card: { kind: 'scene', data: scene }, base: null, order }),
          now(),
        ],
      })),
    ),
  ]);
  emitJobEvent({ type: 'plan:proposed', novelId: env.novel.id });
  throw new AwaitingReviewError('场景计划已生成，请在章节页审阅并采纳',{kind:'proposal'});
};

export const writeScenesStep: StepHandler = async (ctx) => {
  const env = await loadChapterEnv(ctx),
    chapter = env.chapter;
  const existing = await findVersionByStep(chapter.id, ctx.step.id);
  if (existing) {
    if (existing.id !== chapter.currentVersionId)
      throw new AwaitingReviewError('已生成候选与当前工作稿冲突，请人工合并');
    return { outputRef: existing.id };
  }
  const scenes = await listWritingCards(env.novel.id, {
    kind: 'scene',
    chapterId: chapter.id,
    confirmed: true,
  });
  if (
    (await listWritingCards(env.novel.id, { kind: 'scene', chapterId: chapter.id, confirmed: false })).length
  )
    throw new AwaitingReviewError('本章仍有待核对场景');
  if (!scenes.length) throw new AwaitingReviewError('请先确认本章场景计划');
  const deps = await chapterDependencies(env.novel.id, chapter.chapterNo);
  const pieces: string[] = [];
  for (const card of scenes) {
    if (card.kind !== 'scene') continue;
    ctx.setMessage(`正在写第 ${chapter.chapterNo} 章：${card.data.title}`);
    const previous = await getDb().select<{ content: string; dependency_hash: string }>(
      'SELECT content,dependency_hash FROM scene_drafts WHERE job_step_id=? AND scene_id=?',
      [ctx.step.id, card.id],
    );
    if (previous[0]) {
      if (previous[0].dependency_hash !== deps.hash)
        throw new AwaitingReviewError('场景输入已变化，需要重新生成');
      pieces.push(previous[0].content);
      continue;
    }
    const maxTokens = maxTokensForChapter(card.data.targetChars, ctx.provider.caps);
    const context = await buildChapterContextText(env, ctx.provider, maxTokens, { scene: card.data });
    const messages = [
      sys(
        `${systemBase(env.novel.requirements, styleExtrasOf(env))}\n你是小说作者。按已确认场景写纯文本正文，保持人物动机、因果和视角知识边界，不提前实现未来计划。只输出当前场景，不重写此前场景，也不提前写下一场景；此前正文仅供衔接。让 choice 的触发与理由出现在当前行动中，让 consequence 和 beforeState→afterState 的变化实际发生，不能只用叙述者总结“他理解了”。presentation=summarize 时压缩过渡，不逐秒演出操作；dramatize 时重点展开选择和人物碰撞。旧场景未提供这些字段时，依据已有 goal/obstacle/turn/outcome 行文，不补造已确认资料以外的经历。\n【本次场景篇幅】参考约 ${card.data.targetChars} 中文字，按本场的戏剧需要展开或收缩，没有固定字数上限。这是场景参考，不是整章配额；内容完整可以合理短于参考，也可超过参考，不能靠细节填满预算。不输出标题或分析。${UNTRUSTED_GUARD_RULE}`,
      ),
      user(
        `${context}\n当前场景：${JSON.stringify(card)}\n${wrapUntrusted('本章已写场景', pieces.join('\n\n'))}`,
      ),
    ];
    if (
      estimateMessagesTokens(messages, ctx.provider.caps.cjkTokenRatio) +
        maxTokens +
        (ctx.provider.caps.reasoningTokens ?? 0) +
        1500 >
      ctx.provider.caps.contextWindow
    )
      throw new AwaitingReviewError('场景必需上下文超出模型窗口，请更换模型');
    const r = await completeWithRetry(
      ctx.provider,
      { messages, maxTokens, temperature: 0.75, signal: ctx.signal },
      {
        requireComplete: true,
        gate: ctx.gate,
        onDelta: (_d, text) => ctx.onDelta([...pieces, text].join('\n\n')),
      },
    );
    await ctx.recordUsage(r.usage);
    if (countZh(r.text) < 50) throw new Error('场景正文过短');
    const fresh = await chapterDependencies(env.novel.id, chapter.chapterNo);
    if (fresh.hash !== deps.hash) throw new AwaitingReviewError('生成期间场景或前文变化，请重新生成');
    await (ctx.commit ?? (ops => getDb().atomic(ops)))([
      deps.guard,
      {
        sql: 'INSERT INTO scene_drafts(id,chapter_id,scene_id,job_step_id,dependency_hash,content,created_at) VALUES (?,?,?,?,?,?,?)',
        params: [nanoid(), chapter.id, card.id, ctx.step.id, deps.hash, r.text.trim(), now()],
      },
    ]);
    pieces.push(r.text.trim());
  }
  let content = pieces.join('\n\n');
  if (pieces.length > 1) {
    const maxTokens = maxTokensForChapter(chapter.targetChars || countZh(content), ctx.provider.caps);
    const messages = [
      sys(
        `${systemBase(env.novel.requirements, styleExtrasOf(env))}\n完成章节衔接：只调整场景边界的过渡、重复信息、视角和时空交接，保留每场景事件、动机、结果以及证据，不引入新事件。保持草稿整体篇幅，不扩写或重复已发生事件。返回整章纯文本。${UNTRUSTED_GUARD_RULE}`,
      ),
      user(`${JSON.stringify(scenes)}\n${wrapUntrusted('场景草稿', content)}`),
    ];
    if (
      estimateMessagesTokens(messages, ctx.provider.caps.cjkTokenRatio) +
        maxTokens +
        (ctx.provider.caps.reasoningTokens ?? 0) +
        1500 >
      ctx.provider.caps.contextWindow
    )
      throw new AwaitingReviewError('章节衔接必需上下文超出模型窗口');
    ctx.setMessage(`正在衔接第 ${chapter.chapterNo} 章场景`);
    const linked = await completeWithRetry(
      ctx.provider,
      { messages, maxTokens, temperature: 0.2, signal: ctx.signal },
      { requireComplete: true, gate: ctx.gate, onDelta: (_d, text) => ctx.onDelta(text) },
    );
    await ctx.recordUsage(linked.usage);
    content = linked.text.trim();
    if (countZh(content) < 50) throw new Error('章节衔接输出过短');
  }
  if ((await chapterDependencies(env.novel.id, chapter.chapterNo)).hash !== deps.hash)
    throw new AwaitingReviewError('衔接期间计划变化，请重新生成');
  const version = await createVersion({ commit: ctx.commit,
    chapterId: chapter.id,
    content,
    source: 'generated',
    expectedWorkingVersionId: chapter.currentVersionId,
    expectedWorkingHash: ctx.step.input.candidateHash as string | null | undefined,
    storylineSnapshotId: env.snapshotId,
    jobStepId: ctx.step.id,
    model: ctx.provider.model,
  });
  return { outputRef: version.id };
};
