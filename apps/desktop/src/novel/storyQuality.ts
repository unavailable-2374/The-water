import { z } from 'zod';
import { PLOT_DESIGN_RULE, PLOT_GENRE_RULE } from './plotDesign';
import { StoryAssessmentSchema, anchorEvidence, type ReviewIssue, type StoryAssessment } from '@the-water/shared';

const quote = z.object({ quote: z.string().min(1).max(4000) });
export const ModelStoryAssessmentSchema = StoryAssessmentSchema.extend({
  changes: z.array(StoryAssessmentSchema.shape.changes.element.extend({ evidence: quote })).max(20),
  expectations: z.array(StoryAssessmentSchema.shape.expectations.element.extend({ evidence: quote })).max(20),
});
export type ModelStoryAssessment = z.infer<typeof ModelStoryAssessmentSchema>;
export function locateStoryAssessment(text: string, value: ModelStoryAssessment): StoryAssessment {
  if (new Set(value.expectations.map(item=>item.id)).size !== value.expectations.length) throw new Error('重复的阅读期待 ID');
  const locate = (evidence: {quote:string}) => anchorEvidence(text,{from:-1,to:-1,quote:evidence.quote});
  return StoryAssessmentSchema.parse({...value,
    changes:value.changes.map(change=>({...change,evidence:locate(change.evidence)})),
    expectations:value.expectations.map(expectation=>({...expectation,evidence:locate(expectation.evidence)})),
  });
}
const structuralCategories = new Set<ReviewIssue['category']>(['causality','motivation','knowledge','thread','ending','repetition']);
/** Preferences never become factual violations. Only an explicit editorial diagnosis requests structural revision. */
export function storyRevisionIssues(issues: ReviewIssue[], story?: Pick<StoryAssessment,'verdict'>): ReviewIssue[] {
  return issues.filter(issue=>issue.severity==='block' || story?.verdict==='revise' && structuralCategories.has(issue.category)).sort((a,b)=>Number(b.severity==='block')-Number(a.severity==='block'));
}
export const STORY_FIRST_RULE = `【人物、情节与阅读体验优先】
先写人物为了具体目标采取的行动、遭遇的阻力、由当前信息引出的判断和选择，以及选择的实际后果。重要配角也有自己的目标和做事方式，不只负责告知规则或帮助主角。
场景应改变处境、目标进展、关系、知情范围或读者对人物的理解；平静相处、坚持原则、发现生活的变化也能成立，不强迫冲突升级、反转或章末悬念。持续推进本书承诺的阅读体验，同时给已经建立的期待真实回应。
检查每个人当时知道什么、有何利益及更简单的可行办法；隐瞒者不会为方便破案保留明知危险且能轻易销毁的证据。线索留存需要信息差、现实限制或个人利益，疑点、证词与已查证事实分别表达。
重要选择、有效的人物互动与兑现展开；过渡和重复操作用概述。同一信息、同一次争执或同功能动作不反复演出。细节须服务理解人物、因果、关系、线索或独特的生活体验；不能靠逐秒动作和重复心理说明填满字数。篇幅是预算，内容完整可以合理短于目标；不能为了变长而提前兑现、凭空制造事件或改变已确认计划。\n${PLOT_DESIGN_RULE}\n${PLOT_GENRE_RULE}`;
