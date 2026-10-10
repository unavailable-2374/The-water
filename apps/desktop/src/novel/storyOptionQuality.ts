import { z } from 'zod';
import { StoryOptionComparisonSchema, StoryOptionChecksSchema, StoryOptionFindingSchema, StoryOptionDifferenceSchema, StoryOptionAuditSchema, type StoryOption, type StoryOptionComparison } from '@the-water/shared';

export const OPTION_GENERATION_RULE = `【候选内部落实】
先独立设计不同的因果主干，再写摘要字段；四份不能共用同一组中段与高潮、只替换标题和解释。作者明确固定的事件或结局可共用，其余差异必须改变人物行动与后续局势。
outline/turns 是事件依据。mainline 的先后顺序、choiceAndCost 的交易/勒索/损失、growth 的起点与改变、ending 的得到与失去，都必须在事件中有对应行动和结果；不得把未发生的代价只写在说明栏。成长可是不变或恶化，但须以选择表现，不能用演讲、身份升级或“完成救赎”代替。
对本次输入中明确要求的人物行为、关系机制和私人特征逐项落实：重要关系至少交代进入主线、分歧/吸引的具体行动及结果。作者要求循环机制时写明触发、反弹、具体收益和人物解释，不用“建立信任”“成为情感锚点”代替。
关系的靠近、留下、帮助、拒绝和转向从双方需要与已有相处规则长出；写出行动被如何理解、触碰什么边界及怎样改变后续选择，不以一次作证或救援自动换来全面信任。重要配角有独立目标和拒绝理由；相处快乐可成为留下的理由，不强加恋爱、创伤、关系破裂或和解。
高潮交代准备如何取得、规则如何触发、谁有决定权、资源何时可用、对手为何未能阻止；不必展开法律条文或逐章细节，但不能只写启动条款/资本入场就翻盘。主角不能承诺自己无权决定的判决或减刑。合作交代双方收益、代价与转为对抗的触发。反派得意后的反转须有具体错误判断与先前准备。
结尾的新状态与潜在未来问题分开：ending/outline 写本故事实际兑现，aftermath 可写未来可能影响，但不能替代故事中应发生的后果。候选允许补全合理的新剧情与制度规则，统一作为尚未采纳的虚构方案，不声称作者已确认；非核心细节可待定，作者要求的核心结果不能因此不写。`;

export const OPTION_EVENT_COVERAGE_RULE = `【从事件构建完整候选】
按本次输入的文体、目标字数和范围分配叙事：长篇全书大纲须呈现数次阶段目标、阶段结果以及结果引发的新局面，不能把一轮清算包装成整部长篇。无需逐章或按字数机械凑事件；短篇与局部候选按其范围完整收束。
全书候选必须覆盖整部作品，不得自作主张缩成第一卷；作者核心目标不能留给未写的后续卷。逐项兑现作者的核心阅读承诺及重要摘要承诺。夺回控制权、公开洗冤、关系改变、走向新市场是不同结果，不能用最后一句“开始发展”代替输入承诺的重要后半程。重要对手与受损关系有处置或明确留下的状态，不必人人和解或强加感情线。
人物起点须在事件中可见；写出旧办法取得收益、遇到限制后作出选择的过程，可以坚持或恶化。关键配角的信任、倒戈、帮助与离开须有自身欲望、判断依据及行动结果，不能一接近就交证据。新增的代价人物必须提前参与事件，不能结尾临时出现供主角失去。
高潮资源逐项建立取得途径与交换条件；金额比例不必精算，但资金、股权、资产、职权不能互相替代。规则/合同/能力须交代可理解的触发条件、对手为何接受或误判及生效结果，不用“漏洞”“完整证据链”“内部线人”直接跳过胜负机制。材料只能证明其实际支持的事实，关联交易不自动证明另一份材料伪造；前世信息须在今生核验取用。制度程序须有具体触发和权限，不能用未获支持的精神异常、监控、裁判等标签制造便利。
重要胜利留下已发生的持续变化；区分已支付损失和未来可能风险。主角让他人承担代价时写明为何这样选、保护或止损边界及受影响者的反应，不强制悲剧或道德惩罚。四卡除设计轴还应改变中段事件与关系运作，不共用万能证人和同一收尾。生成后自行对照上述事件依据修正缺口，再提交候选。`;

export const OPTION_COMPARISON_RULE = `【独立、证据化比较】
只核对本次作者输入及候选原文，旧作品不是约束。比较不能替候选补齐情节。每个候选必须完成 checks 五项：字段时序和事实一致性；选择到后果与高潮资源的因果；作者明确人物/关系要求；成长与结局兑现；与其他候选的实质差异（融合卡则核对来源取舍与融合后因果）。四卡逐对核对 design：不同的措辞不等于不同的关键选择或解决机制，重复同一骨架须指出，不能因为标题不同就声称有差异。differences 必须覆盖所有两两组合（四卡六对，单张融合卡为 []）。每对用 substantive/cosmetic/undetermined 如实判断；substantive 必须在至少两个不同 design 轴引用各卡逐字引文并解释行动/局势为何不同，不能为了通过校验而虚报差异。每项说明原文依据及缺口，缺少信息时承认未知，不用“合法合规”“反派智商在线”等标签作通过证据。
findings 分 hard_constraint（违反本次作者明确要求）、contradiction（候选字段/事件互相矛盾）、missing_information（关键环节未交代）、editorial（审美建议）。每条引用相关字段中逐字存在的 quote，指出影响与具体修改方向；hard_constraint 还必须提供作者输入中的逐字 authorQuote。field/quote 只能来自候选本身，不能把作者要求当作候选原文；缺失内容无原句时引用候选实际的相关行动或结果，解释缺少什么，不编造缺失句子。例如只写“开始调查”而未兑现作者要求的“查清真相”，quote 引候选的“开始调查”，不是作者的“查清真相”。设计栏的字段写 causalSpine/decisiveChoice/resolutionMechanism，不得将设计栏引文归到 outline；判断实际发生仍须引用 outline/turns。逐字引文尽量短，不改标点、不合并不同句子。没有问题可为 []，不得凭空制造问题。不把信息缺失判为已违法，也不把幸福、简单反派、熟悉桥段或旧作品差异判违规。
特别核对说明栏的代价是否在 outline/turns 发生，主线合作的先后是否一致，反转规则是否预先建立且实际影响胜负，人物改变是否作出新选择，明确感情推进机制是否真实发生。范围只规定输出深度，独立构思不受未输入的正文边界限制。报告总体状态由程序汇总，不输出笼统“全部符合”的总结。`;

export const OPTION_AUDIT_RULE = `【可用性事件审查】
qualityAudit 恰好覆盖五项：scopeCoverage（目标篇幅/范围的阶段推进）、promisePayoff（本次输入及摘要的重要承诺实际兑现）、characterProcess（起点、关键关系选择及转变过程）、resolutionSetup（资源来源、权限、规则触发、对手判断与反击）、lastingConsequences（选择与胜利已造成的持续后果）。按事件审查，不能照抄 design、ending、growth 的自我声明作为发生证据。
关系相关发现归入已有 characterProcess、promisePayoff 或 lastingConsequences，不新增评分或检查点。重要关系转向须有双方可理解的需要、判断与回应，修复不能只有道歉而无支持新信任的后续行动；但不要求每条关系呈现六个维度、每章都有关系变化、每个配角都有独立支线或所有秘密被解释。不因持续亲近、明确敌对、拒绝和解或责任不对等判失败；一般相处细节不足只列 editorial，仅当本次重要承诺或关键行为因果无法由原文支持时判关键缺口，不能补造动机证明通过。
每项 status 为 supported/gap/not_applicable；supported 必须引用 outline/turns 的逐字事件，explanation 对照主张说明这些事件为什么足够，而不是只写“链条完整”。可引用最后一段，但一句“开始国际化”不证明已实现作者要求的国际事业发展；写“受伤/离开”不证明有关系形成与伤害过程。角色从反咬到作证、从敌对到帮助需桥接事件。不得把尚未开设账户直接判定永远不可能存在：无形成节点是信息缺口，有互斥事实才是矛盾。
gap 指影响候选核心可写性的缺口，findingIndices 必须指向本卡 findings 中对应的非 editorial 问题，指出原文位置、缺失过程和影响。先写 findings，再关联：数组下标从 0 开始，第一条问题的下标是 0，不是 1；例如只有一条 missing_information 时 gap 的 findingIndices 写 [0]。关键过程缺失应写 missing_information，不能把同一个缺口在 findings 写 editorial 又在 qualityAudit 写 gap；supported/not_applicable 的 findingIndices 必须为 []。所有非 editorial 发现（包括 missing_information）都属于本轮关键问题，必须至少关联一个 gap，不得一边承认关键过程缺失一边把所有检查点标为 supported。一般细化空间或审美偏好仅列 editorial，不阻断。先判断已写内容能否支持核心结果，而不是要求正文所有细节提前写完。时间跨度未写精确年月但没有互斥事实，不影响现有结果时仅为 editorial；不得将自己明确判断“不影响核心因果链”的问题列为 missing_information。总纲不是逐场执行记录：已交代今生录音并随后播放，不因缺少手机文件拷贝步骤判为关键缺失；不要求每个证据都有技术保管日志、每位配角都有完整传记或每次交易都有法律条文。只有资源来源不可达、跨时间物证、关键权限/规则或必要立场转变缺失、主线承诺与范围未完成等影响胜负或重要关系的过程，才列非 editorial。例如“醒来确认重生节点”无需另列日期核对步骤；配角今生持有录音并主动提供，无需追问录音设备与存放位置；主角自行记录和保留与自己的接触、谈话，已是今生形成与持有路径；未指定司法规则时，不能凭猜测的同意或可采性要求将其判为关键缺失。公司角色已具有通常业务权限时，不要求总纲列出完整批准流程；但亲缘身份不能代替职权，访问无关他人账户或私人通信须有可达路径。本人查询自身账户无需假设银行人员违规，但以本人流水读取无关第三人账户仍须可达路径。不能将候选新增人物关系称为作者指定设定；缺失细节不等于事件不存在，先判断已写出的取得、判断、选择是否足以支持结果。要求短暂反派视角时，总纲写出其得意或错判的局面即具备切入点，不要求特殊标签或正文内心段落。not_applicable 必须说明本次范围/输入为何不需要该项，不能因没写就声称不适用。若模型不能确认重要机制，以 gap 如实记录，不补造情节或用主观评分通过。作者明确要求未被充分呈现与审美偏好分开，不因爽文、幸福结局或不变人物判失败。`;

export function optionComparisonModelSchema(options: StoryOption[], snapshot: Record<string, unknown>, feedback: string) {
  const item = StoryOptionComparisonSchema.shape.options.element.omit({ concerns: true, violations: true, requiresWiderScope: true, checks: true, findings: true, qualityAudit: true }).extend({
    checks: StoryOptionChecksSchema, findings: z.array(StoryOptionFindingSchema).max(20),
    qualityAudit: z.array(StoryOptionAuditSchema).length(5),
  });
  // JSON escapes newlines/quotes. Exact evidence is checked against original string leaves instead.
  const leaves = (v: unknown): string[] => typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(leaves) : v && typeof v === 'object' ? Object.values(v).flatMap(leaves) : [];
  const authorLeaves = leaves({ authorInput: snapshot.authorInput, authorMaterials: snapshot.authorMaterials, feedback });
  return z.object({ options: z.array(item).length(options.length), differences: z.array(StoryOptionDifferenceSchema).length(options.length * (options.length - 1) / 2) }).superRefine((review, ctx) => {
    if (new Set(review.options.map(o => o.optionId)).size !== options.length || review.options.some(o => !options.some(candidate => candidate.id === o.optionId))) ctx.addIssue({ code: 'custom', message: '比较必须恰好覆盖本批次的真实 optionId' });
    review.options.forEach((assessment, index) => {
      const candidate = options.find(o => o.id === assessment.optionId);
      if (!candidate) return;
      if (new Set(assessment.qualityAudit.map(a => a.checkpoint)).size !== 5) ctx.addIssue({ code: 'custom', path: ['options', index, 'qualityAudit'], message: '事件审查必须完整覆盖五个不同检查点' });
      assessment.qualityAudit.forEach((audit, j) => {
        const path = ['options', index, 'qualityAudit', j];
        if (audit.status === 'supported' && !audit.evidence.length) ctx.addIssue({ code: 'custom', path, message: '通过判断必须提供大纲或转折中的事件证据' });
        audit.evidence.forEach((e, k) => {
          if (!e.quote.trim() || !(candidate[e.field] ?? []).some(t => t.includes(e.quote))) ctx.addIssue({ code: 'custom', path: [...path, 'evidence', k], message: '事件证据必须逐字存在于 outline/turns，不能以摘要自证' });
        });
        if (audit.findingIndices.some(n => !assessment.findings[n] || assessment.findings[n]!.kind === 'editorial') || audit.status === 'gap' && !audit.findingIndices.length) ctx.addIssue({ code: 'custom', path, message: '关键缺口必须关联本卡真实的非审美问题' });
        if (audit.status !== 'gap' && audit.findingIndices.length) ctx.addIssue({ code: 'custom', path, message: '有关联关键问题的检查点不能标为通过或不适用' });
      });
      const linked = new Set(assessment.qualityAudit.filter(a => a.status === 'gap').flatMap(a => a.findingIndices));
      assessment.findings.forEach((f, j) => {
        if (f.kind !== 'editorial' && !linked.has(j)) ctx.addIssue({ code: 'custom', path: ['options', index, 'qualityAudit'], message: `findings[${j}] 是非审美问题，必须关联至少一个 gap 检查点，不能承认关键缺失又全项通过` });
      });
      assessment.findings.forEach((finding, j) => {
        const field = (candidate as unknown as Record<string, unknown>)[finding.field] ?? (candidate.design as Record<string, string> | undefined)?.[finding.field];
        const texts = typeof field === 'string' ? [field] : Array.isArray(field) ? field : [];
        if (!finding.quote.trim() || !texts.some(t => typeof t === 'string' && t.includes(finding.quote))) ctx.addIssue({ code: 'custom', path: ['options', index, 'findings', j, 'quote'], message: '审查引文必须逐字存在于候选对应字段，不得补造证据' });
        if (finding.kind === 'hard_constraint' && (!finding.authorQuote.trim() || !authorLeaves.some(t => t.includes(finding.authorQuote)))) ctx.addIssue({ code: 'custom', path: ['options', index, 'findings', j, 'authorQuote'], message: '硬约束必须逐字引用本次作者明确输入，不得引用旧故事线' });
      });
    });
    validateDifferenceEvidence(review.differences, options, ctx);
  });
}
/** Model selects source identifiers; the application copies real source text, never rewrites it. */
export function optionReviewRequest(options: StoryOption[], snapshot: Record<string, unknown>, feedback: string) {
  const citations: { id: string; optionId: string; field: z.infer<typeof StoryOptionFindingSchema>['field']; quote: string }[] = [];
  let eventNo = 0, summaryNo = 0;
  for (const option of options) for (const field of StoryOptionFindingSchema.shape.field.options) {
    const value = (option as unknown as Record<string, unknown>)[field] ?? (option.design as Record<string, string> | undefined)?.[field];
    const texts: string[] = typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
    for (const quote of texts) {
      const event = field === 'outline' || field === 'turns';
      citations.push({ id: event ? `E${eventNo++}` : `S${summaryNo++}`, optionId: option.id, field, quote });
    }
  }
  const leaves = (v: unknown): string[] => typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(leaves) : v && typeof v === 'object' ? Object.values(v).flatMap(leaves) : [];
  const authorCitations = leaves({ authorInput: snapshot.authorInput, authorMaterials: snapshot.authorMaterials, feedback }).filter(Boolean).map((quote, i) => ({ id: `A${i}`, quote }));
  const citationIds = z.enum(citations.map(c => c.id) as [string, ...string[]]);
  const eventIds = z.enum(citations.filter(c => c.field === 'outline' || c.field === 'turns').map(c => c.id) as [string, ...string[]]);
  const normal = optionComparisonModelSchema(options, snapshot, feedback);
  const finding = StoryOptionFindingSchema.omit({ field: true, quote: true, authorQuote: true }).extend({ citationId: citationIds, authorCitationId: z.enum(['none', ...authorCitations.map(c => c.id)]), checkpoint: StoryOptionAuditSchema.shape.checkpoint.describe('这个问题影响哪一个事件检查点；程序据此计算关键缺口及关联，不让模型维护数组下标') });
  const audit = StoryOptionAuditSchema.omit({ evidence: true, status: true, findingIndices: true }).extend({ evidenceIds: z.array(eventIds).max(4).describe('只从事件目录选最多四个完整段落编号，不枚举全部句子，不引用说明栏或猜测编号'), notApplicable: z.boolean().describe('只有本次范围或输入不需要该项时为 true；缺失事件不是不适用') });
  const item = normal.shape.options.element.omit({ findings: true, qualityAudit: true }).extend({ findings: z.array(finding).max(20), qualityAudit: z.array(audit).length(5) });
  const wire = z.object({ options: z.array(item).length(options.length), differences: normal.shape.differences });
  const decode = (review: z.infer<typeof wire>) => ({ ...review, options: review.options.map(o => ({ ...o,
    findings: o.findings.map(f => { const c = citations.find(c => c.id === f.citationId)!; return { kind: f.kind, field: c.field, quote: c.quote, authorQuote: authorCitations.find(a => a.id === f.authorCitationId)?.quote ?? '', explanation: f.explanation, revision: f.revision }; }),
    qualityAudit: o.qualityAudit.map(a => {
      const findingIndices = o.findings.flatMap((f, i) => f.kind !== 'editorial' && f.checkpoint === a.checkpoint ? [i] : []);
      return { checkpoint: a.checkpoint, status: findingIndices.length ? 'gap' as const : a.notApplicable ? 'not_applicable' as const : 'supported' as const, explanation: a.explanation, findingIndices, evidence: a.evidenceIds.map(id => { const c = citations.find(c => c.id === id)!; return { field: c.field as 'outline' | 'turns', quote: c.quote }; }) };
    }),
  })) });
  const schema = wire.superRefine((review, ctx) => {
    review.options.forEach((o, i) => {
      const ids = [...o.findings.map(f => f.citationId), ...o.qualityAudit.flatMap(a => a.evidenceIds)];
      if (ids.some(id => citations.find(c => c.id === id)?.optionId !== o.optionId)) ctx.addIssue({ code: 'custom', path: ['options', i], message: '引用编号必须属于正在审查的候选，不能引用另一张卡' });
    });
    const result = normal.safeParse(decode(review));
    if (!result.success) result.error.issues.forEach(issue => ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message }));
  });
  return { schema, decode: (review: z.infer<typeof wire>) => normal.parse(decode(review)), citations, authorCitations };
}

function validateDifferenceEvidence(differences: z.infer<typeof StoryOptionDifferenceSchema>[], options: StoryOption[], ctx: z.RefinementCtx) {
    const pairs = new Set<string>();
    differences.forEach((pair, i) => {
      const left = options.find(o => o.id === pair.leftId), right = options.find(o => o.id === pair.rightId);
      const key = [pair.leftId, pair.rightId].sort().join(':');
      if (!left || !right || left.id === right.id || pairs.has(key)) ctx.addIssue({ code: 'custom', path: ['differences', i], message: '必须恰好覆盖所有不同候选的两两组合，不能重复或引用外部卡片' });
      pairs.add(key);
      if (new Set(pair.axes.map(a => a.axis)).size !== pair.axes.length || pair.judgment === 'substantive' && pair.axes.length < 2) ctx.addIssue({ code: 'custom', path: ['differences', i, 'axes'], message: '实质差异必须至少有两个不同设计轴的依据' });
      pair.axes.forEach((axis, j) => {
        if (!left?.design?.[axis.axis].includes(axis.leftQuote) || !right?.design?.[axis.axis].includes(axis.rightQuote)) ctx.addIssue({ code: 'custom', path: ['differences', i, 'axes', j], message: '差异依据必须逐字引用两张卡的对应 design 字段' });
      });
    });
}
export function optionDifferenceModelSchema(options: StoryOption[]) {
  return z.object({ differences: z.array(StoryOptionDifferenceSchema).length(options.length * (options.length - 1) / 2) }).superRefine((review, ctx) => validateDifferenceEvidence(review.differences, options, ctx));
}
export function optionDifferenceRequest(options: StoryOption[]) {
  const normal = optionDifferenceModelSchema(options);
  const axis = StoryOptionDifferenceSchema.shape.axes.element.omit({ leftQuote: true, rightQuote: true });
  const wire = z.object({ differences: z.array(StoryOptionDifferenceSchema.extend({ axes: z.array(axis).max(3) })).length(options.length * (options.length - 1) / 2) });
  const decode = (review: z.infer<typeof wire>) => ({ differences: review.differences.map(p => ({ ...p, axes: p.axes.map(a => ({ ...a,
    leftQuote: options.find(o => o.id === p.leftId)?.design?.[a.axis] ?? '',
    rightQuote: options.find(o => o.id === p.rightId)?.design?.[a.axis] ?? '',
  })) })) });
  const schema = wire.superRefine((review, ctx) => { const result = normal.safeParse(decode(review)); if (!result.success) result.error.issues.forEach(issue => ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message })); });
  return { schema, decode: (review: z.infer<typeof wire>) => normal.parse(decode(review)) };
}

type ModelComparison = z.infer<ReturnType<typeof optionComparisonModelSchema>>;
export function optionQualityBlocked(comparison: StoryOptionComparison) {
  return comparison.options.some(o => o.findings?.some(f => f.kind !== 'editorial') || o.qualityAudit?.some(a => a.status === 'gap'));
}
export function finalizeOptionComparison(review: ModelComparison) {
  const options = review.options.map(o => ({ ...o,
    concerns: o.findings.filter(f => f.kind !== 'hard_constraint').map(f => `【${f.kind === 'contradiction' ? '明确矛盾' : f.kind === 'missing_information' ? '信息待补' : '编辑建议'}】${f.field}：“${f.quote}”。${f.explanation}；${f.revision}`),
    violations: o.findings.filter(f => f.kind === 'hard_constraint').map(f => `作者要求：“${f.authorQuote}”；候选 ${f.field}：“${f.quote}”。${f.explanation}；${f.revision}`),
    requiresWiderScope: false,
  }));
  const hard = options.filter(o => o.violations.length).length, pending = options.filter(o => o.concerns.length).length;
  const insufficient = review.differences.filter(p => p.judgment !== 'substantive').length;
  const blocked = options.filter(o => optionQualityBlocked({ summary: 'check', options: [o] })).length;
  return StoryOptionComparisonSchema.parse({ summary: `${options.length === 1 ? '融合候选已审查' : '四个候选已分别审查'}：${hard} 个被指出违反本次作者明确要求，${pending} 个有矛盾、待补信息或编辑建议。${blocked ? `${blocked} 个存在关键质量缺口，本批次不可选择，需重新抽取。` : ''}${insufficient ? `${insufficient} 对候选的差异不足或尚未确认，需重新抽取。` : ''}具体依据见各卡片；未发现问题不代表文学质量已经验证。`, options, differences: review.differences });
}

export const OPTION_COMBINATION_RULE = `【作者指定多卡融合】
本轮只生成一张完整融合卡。combinationSources 是作者明确选中的材料，不是旧作品约束。按本轮偏好说明保留各来源的哪些行动、人物关系、冲突或解法，舍弃哪些互斥内容；不能把各卡的高潮或结局机械串联。没有明确偏好时综合来源的可兼容优势并在新大纲中建立统一因果。
人物身份、事件先后、资源权属、结局相冲突时，明确作出候选级取舍并交代原因；不得写成同时成立，也不能让作者约束被融合覆盖。新 choiceAndCost/growth/ending 必须对应融合后的事件，不复制来源摘要冒充新过程。融合后的 design 写统一因果主干、关键选择与解决机制。比较时交代来源贡献、舍弃及冲突处理；来源旧问题须重新核对，不能沿用“已通过”的结论。原卡保持不变，融合不代表作者已经采用。`;
