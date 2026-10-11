/** Opt-in REAL reviewer calls on explicitly fictional TEST prose; not literary quality validation. */
import { expect, it } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { useTestDb } from '../helpers/testDb';
import { setSecretStore } from '@/secrets/keychain';
import { setFetchImpl, providerById } from '@/llm/registry';
import { createProvider } from '@/db/repos/providersRepo';
import { narrativeReviewPrompt, locateNarrativeIssues, locateNarrativeStory } from '@/llm/prompts/narrativeReview';
import { requestJson } from '@/llm/json';
const fixtures = [
 {id:'TEST-missing-choice',action:'expand',text:'顾岚一直坚信不能公开工人的私人住址。她得知公开名单会让十位无辜工人遭到报复。她没有遭到威胁，也没有发现任何新事实。她突然决定把名单完整公开，觉得这毫无问题。第二天名单公布了。',context:'TEST 已确认：保护工人隐私是顾岚的原则；本章计划是顾岚认真权衡后拒绝公开住址，改交匿名证据。这是她本章最重要的选择。当前正文跳过判断与权衡。'},
 {id:'TEST-repeated-operation',action:'trim',text:'顾岚先看了名单，确认共十个人，她把名单收进抽屉。她又拿出同一张名单，从头看了一遍，仍是十个人，又收进抽屉。她第三次拿出这张名单，从头数了一遍，仍是十个人，又收进抽屉。没有新信息，她第四次拿出名单，数完十个人，再次收进抽屉。整个下午过去，情况没有任何变化。',context:'TEST 已确认：名单从未改变，清点不揭示顾岚的心理或关系，不埋伏笔，剧情只需确认名单后前去交匿名证据。'},
] as const;
it.skipIf(!process.env.RUN_REAL_LENGTH_REVIEW)('REAL evidenced chapter expansion and trimming decisions on TEST prose',async()=>{
 const key=process.env.LUNAROUTE_API_KEY;if(!key) throw new Error('LUNAROUTE_API_KEY is required');
 const out=process.env.LENGTH_REVIEW_EVAL_OUTPUT;if(!out) throw new Error('LENGTH_REVIEW_EVAL_OUTPUT is required');
 if(existsSync(out)) throw new Error('Refusing to overwrite real evaluation evidence');mkdirSync(out,{recursive:true});
 useTestDb();setFetchImpl(fetch);setSecretStore({get:async()=>key,set:async()=>{},delete:async()=>{}});
 const configured=await createProvider({name:'REAL Lunaroute TEST length reviewer',kind:'openai_compatible',baseUrl:'https://gw.lunaroute.com/v1',model:'deepseek-4.1-flash',contextWindow:1048576,maxOutputTokens:65536,reasoningTokens:32000,jsonMode:'json_object',temperature:0.1,extraHeaders:{},secretRef:'env:LUNAROUTE_API_KEY',firstByteTimeoutMs:120000,idleTimeoutMs:120000});
 const provider=await providerById(configured.id);
 for(const fixture of fixtures){
  const spec=narrativeReviewPrompt({chapterNo:1,text:fixture.text,context:fixture.context});
  writeFileSync(`${out}/${fixture.id}-request.json`,JSON.stringify(spec.messages,null,2));
  const result=await requestJson(provider,{...spec,schema:spec.schema!.superRefine((value,ctx)=>{
   if(!value.lengthReview) ctx.addIssue({code:'custom',path:['lengthReview'],message:'必须返回篇幅审阅'});
   for(const item of value.lengthReview?.actions ?? []) if(!value.issues.some(issue=>issue.id===item.issueId)) ctx.addIssue({code:'custom',message:'篇幅建议必须有原文问题 ID'});
   try{locateNarrativeIssues(fixture.text,value.issues);}catch{ctx.addIssue({code:'custom',message:'证据必须唯一定位至 TEST 正文'});}
  })});
  writeFileSync(`${out}/${fixture.id}-result.json`,JSON.stringify({label:'REAL response to TEST fiction; not literary quality evidence',fixture,result:{...result,value:{...result.value,issues:locateNarrativeIssues(fixture.text,result.value.issues),story:locateNarrativeStory(fixture.text,result.value.story)}}},null,2));
  expect(result.value.lengthReview!.actions.some(item=>item.action===fixture.action)).toBe(true);
 }
},600000);
