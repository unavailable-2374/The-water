import {expect,it} from 'vitest';
import {complete,completeWithRetry} from '@/llm/complete';
import {sumUsage,type LLMProvider} from '@/llm/types';
import {recordUsage,usageTotals} from '@/db/repos/usageRepo';
import {useTestDb} from '../helpers/testDb';
it('TEST unknown usage in a tool loop remains an unpriced reported subtotal through accounting',async()=>{
 useTestDb();
 const provider:LLMProvider={id:'TEST',model:'deepseek-chat',kind:'openai_compatible',caps:{contextWindow:10000,maxOutputTokens:1000,jsonMode:'json_object',cjkTokenRatio:0.7},async *stream(){
  yield {type:'usage',inputTokens:10,outputTokens:20,cumulative:true};
  yield {type:'usage',inputTokens:10,outputTokens:20,cumulative:true,inputReported:false,outputReported:false};
  yield {type:'delta',text:'TEST draft'};yield {type:'done',finishReason:'stop'};
 }};
 const request={messages:[{role:'user' as const,content:'TEST'}],maxTokens:100};
 const result=await complete(provider,request);expect(result.usage).toEqual({inputTokens:10,outputTokens:20,incomplete:true});
 const retry=await completeWithRetry(provider,request,{gate:{acquire:async()=>{},reportRateLimit:()=>{}} as any});expect(retry.usage.incomplete).toBe(true);
 expect(sumUsage(result.usage,{inputTokens:3,outputTokens:4}).incomplete).toBe(true);
 const row=await recordUsage({usage:result.usage,purpose:'writing',providerKind:'openai_compatible',model:'deepseek-chat'});expect(row?.priceId).toBeNull();
 expect((await usageTotals({})).unpricedCalls).toBe(1);
 const unknown=await recordUsage({usage:{inputTokens:0,outputTokens:0,incomplete:true},purpose:'writing',providerKind:'openai_compatible',model:'deepseek-chat'});expect(unknown).not.toBeNull();
});
