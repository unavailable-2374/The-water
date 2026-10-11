/** REAL network responses on explicitly labeled TEST fiction. No human quality claim. */
import { expect, it } from 'vitest';
import { existsSync, writeFileSync } from 'node:fs';
import { evaluationCredential, evaluationSource } from './runtime';
import { useTestDb } from '../helpers/testDb';
import { createProvider } from '@/db/repos/providersRepo';
import { setSecretStore } from '@/secrets/keychain';
import { setFetchImpl, providerFromConfig } from '@/llm/registry';
import { firstReadingPrompt, locateFirstReading } from '@/llm/prompts/firstReading';
import { narrativeReviewPrompt, locateNarrativeIssues, locateNarrativeStory } from '@/llm/prompts/narrativeReview';
import { requestJson } from '@/llm/json';
import { sha256Hex } from '@the-water/shared';

it.skipIf(process.env.RUN_REAL_FIRST_READING!=='1')('REAL prose-only inference precedes author alignment, with original evidence preserved',async()=>{
  const {key,source:credentialSource}=evaluationCredential();
  const path=process.env.REAL_FIRST_READING_RECORD;if(!path)throw new Error('REAL_FIRST_READING_RECORD is required');
  if(existsSync(path))throw new Error('Refusing to overwrite real evaluation evidence');
  const db=useTestDb();setSecretStore({get:async()=>key,set:async()=>undefined,delete:async()=>undefined});setFetchImpl(fetch);
  const record:Record<string,unknown>={label:'REAL AI readings of TEST fiction; not human reader feedback or literary improvement evidence',...evaluationSource(),credentialSource,date:new Date().toISOString()};
  try {
    const config=await createProvider({name:'REAL TEST first reading',kind:'openai_compatible',baseUrl:'https://gw.lunaroute.com/v1',model:'deepseek-4.1-flash',contextWindow:1048576,maxOutputTokens:262144,reasoningTokens:32000,reasoningEffort:'low',jsonMode:'json_schema',temperature:0.2,extraHeaders:{},secretRef:'TEST environment',firstByteTimeoutMs:120000,idleTimeoutMs:120000});
    const provider=await providerFromConfig(config);record.parameters={model:provider.model,caps:provider.caps,firstReadingTemperature:0.1,firstReadingMaxTokens:6000,alignmentTemperature:0.1,alignmentMaxTokens:6000};
    const text='TEST 虚构样稿。\n\n顾澄第三次把申诉表推到窗口。父亲的案卷压在玻璃后，她认得封面那一道折痕。\n\n“还缺证人的签字。”窗口里的人说。\n\n她把表收回，沿走廊走到师傅门口。师傅曾教她写这类申请，却也是当年的签字人。她抬起手，在门板前停了一会儿。里面有人问是谁，她答：“来还您那本书。”书其实还在她家里。\n\n师傅开门时，她只递出了申请表。“我想再问一次，您当时看见了什么。”\n\n“你现在肯跟我说话了？”\n\n“只谈这张表。”她没有进屋，“您可以拒绝，我也可以再找别人。”\n\n他把表搁在门边，没接那支笔。她把笔放回口袋，没有替他解释。走到楼梯口，她仍握着口袋里的笔；下一次，她需要先找到真正看见过那件事的人。';
    const sources=[{chapterNo:1,versionId:'TEST fixed version',contentHash:await sha256Hex(text),text}];record.sources=sources;
    const first=firstReadingPrompt(sources);record.blindMessages=first.messages;
    expect(JSON.stringify(first.messages)).not.toContain('TEST attachment answer');
    const r=await requestJson(provider,{...first,schema:first.schema!},{signal:AbortSignal.timeout(240000)});
    const reading=locateFirstReading(r.value,sources);record.firstReading=reading;record.firstUsage=r.usage;
    const context='本书已确认资料：[{"id":"TEST-intent","motivation":"TEST attachment answer：父亲曾在她失败时为她保留回家的位置，她维护父亲的清白也在维护两人的依恋。师傅是她重要的依恋对象，她暂不愿全面揭发他，但需要证词。"},{"id":"TEST-scene","goal":"先争取自愿证词；关系仅恢复有限谈话，不原谅全部过往。谎称还书是人物策略，不是叙述确认书在她手里；未接笔原因暂留白。"}]';
    const spec=narrativeReviewPrompt({chapterNo:1,text,context,firstReading:reading});
    const aligned=await requestJson(provider,{...spec,schema:spec.schema!.superRefine((value,ctx)=>{
      try{locateNarrativeIssues(text,value.issues);locateNarrativeStory(text,value.story);}catch(e){ctx.addIssue({code:'custom',message:String(e)});}
      if(value.readerAlignment?.some(a=>a.sourceIds.some(id=>!['TEST-intent','TEST-scene'].includes(id))))ctx.addIssue({code:'custom',message:'Use only supplied confirmed source IDs'});
    })},{signal:AbortSignal.timeout(240000)});
    record.alignment=aligned.value;record.alignmentUsage=aligned.usage;record.status='schema_and_evidence_verified';
    expect(reading.sources[0]?.contentHash).toBe(await sha256Hex(text));expect(aligned.value.readerAlignment).toBeDefined();
  } catch(e) {record.status='failed';record.error=String(e);throw e;}
  finally {writeFileSync(path,JSON.stringify(record,null,2));db.raw.close();}
},540000);
