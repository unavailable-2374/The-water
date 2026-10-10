import type { PromptSpec } from '@/llm/types';
import { OutlineDocSchema, type NovelRequirements, type OutlineDoc } from '@/novel/types';
import { SettingKind } from '@the-water/shared';
import { joinSections, planningSystem, section, sys, user } from './base';
import { OUTLINE_PLANNING_RULE, OUTLINE_DESIGN_RULES } from '@/novel/outlineQuality';
import { docTypeGuide } from '@/novel/docTypes';
import { isEmptyGenre, mergedGenreOf, type MergedGenre } from '@/novel/genrePacks';

export interface OutlineInput {
  premise: string;
  requirements: NovelRequirements;
  targetChars: number;
  chapterCount: number;
}

export const OUTLINE_JSON_SHAPE = `{
  "writing": {"brief":{"premise":"创作前提","mainline":"全书主线","ending":"已规划结局","audience":"读者","readingExperience":"主要阅读体验与持续期待","distinctiveApproach":"主角独特做事方式","protagonistLimits":"方式的边界与限制","firstChoice":"首篇重要选择","choiceConsequences":"选择造成的后续局面","storyEngine":"目标受阻→主动应对→后果改变处境→新的选择，如何持续产生故事","endingConditions":"事件、人物选择与情感回应达到什么状态才结束","constraints":["不可突破的约束"],"rollingChapters":5},"volumes":[{"title":"第一卷","summary":"本卷目标和转折","startChapterNo":1,"endChapterNo":5,"arcIndexes":[0]}],"threads":[{"title":"贯穿故事的伏笔","setup":"埋设时读者看到的表面信息","progression":"后续如何强化疑问或误导","payoff":"回收如何改变理解与选择","plannedChapterNo":5,"characterNames":["姓名"],"milestones":[{"chapterNo":1,"kind":"setup","detail":"首次出现"},{"chapterNo":3,"kind":"progress","detail":"新的疑问与线索"},{"chapterNo":5,"kind":"payoff","detail":"合理揭示"}]}],"intents":[{"characterName":"姓名","goal":"外部目标","motivation":"为何必须行动","contradiction":"内在矛盾","fear":"害怕失去什么","belief":"相信什么","habitualStrategy":"习惯如何应对困难","independentAgenda":"主角不在场时他会主动做什么","growth":[{"chapterNo":5,"change":"成长节点"}]}]},
  "title": "书名",
  "logline": "一句话概括全书主线",
  "themes": ["主题1", "主题2"],
  "settings": [{ "name": "设定名", "kind": "${SettingKind.options.join('|')}", "description": "设定说明" }],
  "characters": [{
    "name": "姓名", "aliases": ["别名/称呼"], "role": "主角/反派/配角…", "description": "外貌、性格、背景",
    "arc": "人物在全书中的成长或转变", "relationships": [{ "targetName": "另一位人物的姓名", "kind": "关系类型", "note": "补充说明" }]
  }],
  "arcs": [{ "title": "故事弧标题", "summary": "该弧的核心冲突与走向", "startChapterNo": 1, "endChapterNo": 5 }],
  "beats": [{ "arcIndex": 0, "title": "情节点标题", "summary": "发生了什么、意义何在", "characterNames": ["姓名"], "settingNames": ["设定名"], "suggestedChapterNo": 1 }]
}`;

export function outlinePrompt(input: OutlineInput): PromptSpec<OutlineDoc> {
  const n = Math.max(1, Math.round(input.chapterCount));
  const system = planningSystem('你是一位资深小说策划编辑，擅长把创意框架发展成结构完整、节奏可控的长篇大纲。', input.requirements);

  const rules = [
    `1. 篇幅参考约 ${input.targetChars} 字、约 ${n} 章，用于判断长中短篇。先按剧情需要选择合适章数，可以增加或减少；这些数值不是必须达成的配额。`,
    '2. title 为书名；logline 用一句话概括主线；themes 给 2–5 个主题。',
    `3. settings 给 3–10 个关键设定，kind 只能取：${SettingKind.options.join('、')}。`,
    '4. characters 给 3–8 位主要人物（可另加少量重要配角），每人写清 role、description、arc；relationships 的 targetName 必须是本列表中另一位人物的 name。',
    '5. arcs 按顺序连续覆盖你实际规划的全书章节，第一条 startChapterNo 为 1，最后一条 endChapterNo 给出本次建议章数；范围不重叠、不留空。章号是可调整的规划位置，依据选择、变化与收束划分章节，不为凑章数拆碎场景或拖延结尾。',
    `分卷与故事弧必须完整对应：先生成 arcs 数组，再给 writing.volumes.arcIndexes 和 beats.arcIndex 填写从 0 开始的数组下标，最大值为 arcs.length - 1。不得把分卷当作 arcs 的替代品；有分卷或引用时 arcs 不得为空。人物动机的 characterName 必须对应 characters 的姓名。`,
    `6. 只细化未来前 ${Math.min(n,5)} 章的 beats，每章 1–3 个；后续发展由 arcs 高层描述，不一次展开全书情节点。arcIndex 为从 0 开始的 arcs 下标；suggestedChapterNo 不得大于 ${Math.min(n,5)}；characterNames / settingNames 使用上面的 name。`,
    '7. 小说必须提供 writing：分卷是出版组织，区别于可以跨卷的故事弧；分卷连续覆盖全书。人物目标、动机、矛盾和成长节点必须相互支持。非虚构可以省略 writing。',
    '跨章伏笔：writing.threads 规划贯穿故事的埋设、推进、回收；milestones 按规划位置递增、不超本次实际规划的结尾，kind 为 setup/progress/payoff，plannedChapterNo 等于最后 payoff 章。长篇安排跨故事弧的线索，关联已有角色；不在每个滚动窗口重新埋设或提前回收。短篇无需机械加入长伏笔，允许 threads:[]。这些是待作者采纳的计划，不是正文事实。',
    '8. 阅读体验必须具体，并在开篇提供真实样本；先检查故事能否由人物行动与后果持续生长，再分配章节。主要篇章说明目标、持续阻力、关键选择及结果后的新局面，不靠换地点、换对手、提高数值制造假推进。人物的目标、恐惧、信念和应对习惯要能解释行为；配角有自己的事情。重要选择有可理解的触发与代价，成长可表现为改变自己或坚持自己后改变关系。平静章节可以积累理解和亲近，不能用固定黄金三章、固定反转套所有题材。细节只规划必要的线索和生活经验，不把操作流程摊成多个无变化场景。',
    '9. 逐项反向检查人物为何不采用更简单的办法，尤其隐瞒者知道什么、能销毁什么、为何保留线索；证据留存必须出自信息差、现实限制或个人利益，不能为让主角找到而无故留存。记录、物件与证词分别能证明什么，不能把疑点直接当事实。若现有前提存在无法解释的因果矛盾，应在大纲中重构行为与条件，不照抄错误。',
    '10. 所有文字使用简体中文；不要输出 JSON 之外的内容。',
  ].join('\n');

  const guide = docTypeGuide(input.requirements.docType);
  const framework = guide.outlineRules.length ? section(`结构框架（${guide.label}：${guide.framework}）`, guide.outlineRules.map((r) => `- ${r}`).join('\n')) : '';
  const genre = guide.fiction ? genreOutlineBlock(mergedGenreOf(input.requirements)) : '';
  const text = joinSections([
    section('故事框架', input.premise),
    guide.fiction ? OUTLINE_PLANNING_RULE : OUTLINE_DESIGN_RULES,
    framework,
    genre,
    section('任务', `请基于以上框架生成完整大纲，严格按下面的 JSON 结构输出。\n${rules}`),
    section('JSON 结构', OUTLINE_JSON_SHAPE),
  ]);

  return {
    messages: [sys(system), user(text)],
    maxTokens: 8000,
    temperature: 0.7,
    schema: guide.fiction ? OutlineDocSchema.superRefine((value,ctx)=>{
      const brief=value.writing?.brief;
      for (const key of ['readingExperience','distinctiveApproach','protagonistLimits','firstChoice','choiceConsequences','storyEngine','endingConditions'] as const)
        if (!brief?.[key]?.trim()) ctx.addIssue({code:'custom',path:['writing','brief',key],message:'新小说大纲必须说明阅读体验、选择后果和结束条件'});
      for(const character of value.characters) {
        const intent=value.writing?.intents.find(item=>item.characterName===character.name);
        for(const key of ['goal','motivation','contradiction','fear','belief','habitualStrategy','independentAgenda'] as const)
          if(!intent?.[key]?.trim()) ctx.addIssue({code:'custom',path:['writing','intents'],message:`人物 ${character.name} 缺少 ${key}，不能只给性格标签`});
      }
    }) : OutlineDocSchema,
    label: '生成大纲',
  };
}

/** Genre preparation guidance must not invent fixed world rules in the outline. */
export function genreOutlineBlock(m: MergedGenre): string {
  if (isEmptyGenre(m)) return '';
  const lines: string[] = [];
  for (const h of m.outlineHints) lines.push(`- ${h}`);
  if (m.entries.length > 0) {
    lines.push(`- 下列是准备问题与创作指导，非本书事实；仅将本书实际采用的具体规则写进 settings，不照抄通用指导作为世界设定：`);
    for (const e of m.entries) lines.push(`  · ${e.name}：${e.description}`);
  }
  if (m.tropes.use.length > 0) lines.push(`- 优先用这些套路：${m.tropes.use.join('；')}`);
  if (m.tropes.avoid.length > 0) lines.push(`- 避开这些烂俗桥段：${m.tropes.avoid.join('；')}`);
  return lines.length > 0 ? section(`题材惯例（${m.labels.join(' + ')}）`, lines.join('\n')) : '';
}
