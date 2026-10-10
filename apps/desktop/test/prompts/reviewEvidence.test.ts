// TEST fixtures only: invented prose checks validation, not real model quality.
import { expect, it } from 'vitest';
import { emptyStyleProfile } from '@the-water/shared';
import { consistencyReviewPrompt } from '@/llm/prompts/consistencyReview';
import { styleReviewPrompt } from '@/llm/prompts/styleReview';

const text='TEST 她回来了。她放下清单。她回来了。她锁上门。';
it('TEST consistency rejects ambiguous/missing quotations and accepts an extended unique quotation',()=>{
 const schema=consistencyReviewPrompt({chapterNo:1,chapterText:text,facts:[],rules:[],timeline:[],characters:[],qcReminders:[]}).schema!;
 const result=(quote:string)=>({timelineConflicts:[{quote,against:'TEST rule',why:'TEST conflict'}],verdict:'revise'});
 expect(schema.safeParse(result('她回来了。')).success).toBe(false);
 expect(schema.safeParse(result('TEST 不存在的原文')).success).toBe(false);
 expect(schema.safeParse(result('她回来了。她锁上门。')).success).toBe(true);
});
it('TEST OOC redline evidence is validated before a hard conflict can be persisted',()=>{
 const schema=styleReviewPrompt({chapterNo:1,chapterText:text,profile:emptyStyleProfile(),characters:[],derivative:null,sourceTitle:null,canonFacts:[],metricHints:[],qcReminders:[]}).schema!;
 const result=(quote:string)=>({styleScore:90,ooc:[{character:'TEST 人物',quote,verdict:'OOC',redline:'TEST redline',why:'TEST conflict'}],verdict:'revise'});
 expect(schema.safeParse(result('她回来了。')).success).toBe(false);
 expect(schema.safeParse(result('她回来了。她锁上门。')).success).toBe(true);
});
