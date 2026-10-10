export const storyOptions = {
  audit: '查看可用性事件审查', auditLabels: { scopeCoverage: '范围与阶段推进', promisePayoff: '重要承诺兑现', characterProcess: '人物与关系过程', resolutionSetup: '高潮准备与生效', lastingConsequences: '已发生的持续后果' }, auditStatuses: { supported: '有事件依据', gap: '存在关键缺口', not_applicable: '本范围不适用' },
  pairwise: '查看四卡两两差异依据', differenceJudgments: { substantive: '存在实质差异', cosmetic: '仅措辞或装饰差异', undetermined: '差异尚未确认' },

  combine: '生成融合候选', combineCard: '加入组合', combineHint: '勾选两到四张卡，在本轮偏好中说明各卡想保留的部分，再生成一张新的完整融合候选。融合会重新审查，不会自动采纳或修改原卡。', combinationSources: '融合来源',
  designLabels: { causalSpine: '因果主干', decisiveChoice: '关键选择与代价', resolutionMechanism: '高潮解决机制' },

  independentHint: '独立构思仅使用作品框架、创作参数和本轮明确输入的材料。不会自动读取已有故事线、人物卡、章纲、正文或已采纳方向；需要沿用的设定请在下方明确提供。整批重抽不带入旧候选，保留重抽只带入勾选的卡片。',
  authorMaterials: '本轮作者材料（人物要求、关系、设定或局部起点）', inputPreview: '查看使用的作品框架与创作参数', legacyInputs: '旧批次曾使用已有故事线，仅供回看；重新抽卡将独立构思。', checks: '查看逐项核对依据',
  checkLabels: { fieldConsistency: '字段与时序一致性', causality: '因果与翻盘机制', characterRequirements: '人物与关系要求', payoffs: '成长与结局兑现', distinctness: '候选实质差异' },

  outlineTitle: '大纲抽卡', outline: '完整大纲', generateOutlines: '生成四个完整大纲', chooseOutline: '选择这个大纲',
  outlineHint: '先比较从开端到结局的完整大纲。选择后生成待审大纲，采纳后再单独调整章节计划、场景和续写；已有正文不会被改写。保留卡片只影响重抽。',
  legacyOutline: '旧版候选仅有方向摘要。请重新抽卡获取完整大纲。', pendingOutline: '等待审阅大纲；采纳后再生成章节计划和续写',
  concerns: '细化时关注',
  details: '展开候选细节',
  title: '故事线抽卡', hint: '保留只影响重抽；选择方向后生成待审计划，整组采纳才更新计划。正文由你另行发起改写。',
  work: '整部作品', arc: '故事弧', chapter: '章节', scene: '场景',
  mode: '选卡后的衔接方式', continue: '续写', restructure: '重构', amplitude: '探索幅度', close: '贴近输入', moderate: '适度探索', bold: '大胆探索',
  feedback: '本轮偏好', generate: '生成四张候选', redraw: '保留卡片并重抽其余', redrawAll: '整批重抽', retain: '保留卡片', choose: '选择此方向', selected: '已选择方向',
  history: '历史批次', comparison: '差异与取舍（编辑判断）', incomplete: '比较未完成', retry: '恢复未完成阶段', stale: '输入已变化，本批次仅供回看，请重新抽卡。',
  boundary: '续写边界：已保存正文结束位置', emptyBoundary: '尚无已保存正文', savedOnly: '边界依据已保存正文；请先保存编辑器中的改动。',
  conflict: '核心冲突', choiceAndCost: '人物选择与代价', growth: '人物成长', turns: '关键转折', ending: '结局 / 场景结果', aftermath: '后续影响', character: '人物', emotion: '情绪体验', tradeoff: '选择意味着什么',
  broader: '必须扩大范围后重新探索', pending: '等待作者审阅整组计划', undo: '撤销整组采纳', review: '计划已变更，已采纳方向待复核',
  skip: '明确跳过抽卡', confirm: '确认创建', parameters: '创作参数与模型', confirmHint: '保留原始框架；所选方向将生成待审大纲。',
  draftSelected: '已关联所选方向', noSelection: '尚未选择方向，可回到抽卡或明确跳过。', planRetry: '重试计划生成',
};
