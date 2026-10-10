// TEST / SIMULATED model responses exercise the real Pi SDK and topic-tree code, not model quality.
import {test,expect} from 'bun:test';
import {runTopicTreeSession} from '../src/modules/writing/topic-tree/session';
import {loadEnv} from '../src/env';
import type {HarnessRequest} from '@the-water/shared';
import type {FetchLike,StreamEvent} from '@the-water/llm/types';
const env=()=>loadEnv({WRITING_HARNESS_ENABLED:'1',LUNAROUTE_API_KEY:'TEST-KEY'});
const request=(n:number):HarnessRequest=>({messages:[{role:'system',content:'TEST current confirmed rule: never reveal future secrets'},{role:'user',content:`TEST turn ${n}, secret key is TEST-鹭岛`}],maxTokens:200,topicTree:{workId:'TEST-book',branchId:'main',channel:'writing',epoch:'a'.repeat(64),chapterNo:n}});
function response(content:string, tool=false){return new Response(`data: ${JSON.stringify({choices:[{index:0,delta:tool?{tool_calls:[{index:0,id:'TEST-call',type:'function',function:{name:'recall_topic',arguments:JSON.stringify({action:'search',query:'鹭岛',limit:1})}}]}:{content},finish_reason:null}]})}\n\ndata: ${JSON.stringify({choices:[{index:0,delta:{},finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:17,completion_tokens:23}})}\n\ndata: [DONE]\n\n`,{headers:{'content-type':'text/event-stream'}});}
test('TEST actual SDK loads recall_topic, persists a session and executes a tool loop without leaking commentary',async()=>{
 const calls:any[]=[];let recall=false;
 const transport:FetchLike=async(_url,init)=>{const body=JSON.parse(String(init?.body));calls.push(body);
  const system=body.messages.find((m:any)=>m.role==='system')?.content ?? '';
  if(system.includes('You maintain a topic tree')) return response(JSON.stringify({newTopics:[{ref:'n1',title:'TEST key',parent:null}],assignments:[...body.messages.at(-1).content.matchAll(/<turn index="(\d+)">/g)].map((m:any)=>({turn:Number(m[1]),topics:['n1']})),globalFacts:['TEST fabricated standing rule must not become canon']}));
  if(system.includes('running summary')) return response('TEST summary of a work record, not canon');
  if(recall && !body.messages.some((m:any)=>m.role==='tool')) {recall=false;return response('TEST commentary must not become prose',true);}
  return response('TEST final answer');
 };
 const events:StreamEvent[]=[];
 let entries=await runTopicTreeSession({env:env(),request:request(1),signal:new AbortController().signal,fetchImpl:transport,emit:e=>events.push(e)});
 expect(calls[0].tools.map((t:any)=>t.function.name)).toEqual(['recall_topic']);
 expect(calls[0].messages[0].content).toContain('TEST current confirmed rule');
 expect(entries.some(e=>e.type==='message' && e.message.role==='assistant')).toBe(true);
 recall=true;
 entries=await runTopicTreeSession({env:env(),request:request(2),entries,signal:new AbortController().signal,fetchImpl:transport,emit:e=>events.push(e)});
 expect(calls.some(c=>c.messages.some((m:any)=>m.role==='tool' && m.content.includes('TEST-鹭岛')))).toBe(true);
 expect(events.filter(e=>e.type==='delta').map(e=>e.text)).toEqual(['TEST final answer','TEST final answer']);
 expect(entries.some(e=>e.type==='message' && e.message.role==='toolResult')).toBe(true);
});

test('TEST classification and projection keep raw Chinese evidence recallable and never promote inferred global rules',async()=>{
 const calls:any[]=[];const events:StreamEvent[]=[];
 const transport:FetchLike=async(_url,init)=>{const b=JSON.parse(String(init?.body));calls.push(b);const system=b.messages[0].content;
  if(system.includes('You maintain a topic tree')) return response(JSON.stringify({newTopics:[{ref:'n1',title:'TEST 伏笔',parent:null}],assignments:[...b.messages.at(-1).content.matchAll(/<turn index="(\d+)">/g)].map((m:any)=>({turn:Number(m[1]),topics:['n1']})),globalFacts:['TEST fabricated global rule']}));
  if(system.includes('running summary')) return response('TEST historical summary');
  if(JSON.stringify(b.messages.at(-1).content).includes('TEST recall now') && b.messages.at(-1).role==='user') return response('',true);
  return response('TEST final');
 };
 let entries:Awaited<ReturnType<typeof runTopicTreeSession>>|undefined;
 for(let n=1;n<=5;n++) entries=await runTopicTreeSession({env:env(),request:{...request(n),messages:[request(n).messages[0]!,{role:'user',content:n===5?'TEST recall now':`TEST turn ${n} key TEST-鹭岛`}]},entries,signal:new AbortController().signal,fetchImpl:transport,emit:e=>events.push(e)});
 expect(calls.some(b=>b.messages[0].content.includes('You maintain a topic tree'))).toBe(true);
 expect(entries?.some(e=>e.type==='custom' && e.customType.includes('topic-tree'))).toBe(true);
 const lastMain=calls.filter(b=>b.tools?.length).at(-1);
 expect(JSON.stringify(lastMain)).not.toContain('TEST fabricated global rule');
 expect(lastMain.messages.some((m:any)=>m.role==='tool'&&m.content.includes('TEST-鹭岛'))).toBe(true);
 expect(events.filter(e=>e.type==='usage').at(-1)).toMatchObject({inputReported:true,outputReported:true});
});

test('TEST multi-call missing usage is marked incomplete and a cancelled session returns no snapshot',async()=>{
 let calls=0;const events:StreamEvent[]=[];
 await runTopicTreeSession({env:env(),request:request(1),signal:new AbortController().signal,fetchImpl:async()=>++calls===1?response('',true):new Response('data: {"choices":[{"index":0,"delta":{"content":"TEST result"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'),emit:e=>events.push(e)});
 expect(events.filter(e=>e.type==='usage').at(-1)).toMatchObject({cumulative:true,inputTokens:17,outputTokens:23,inputReported:false,outputReported:false});
 const controller=new AbortController();controller.abort();
 await expect(runTopicTreeSession({env:env(),request:request(1),signal:controller.signal,fetchImpl:async()=>{throw new Error('TEST cancelled session must not call upstream');},emit:()=>{}})).rejects.toMatchObject({kind:'aborted'});
});
test('TEST unending recall loop fails at the declared limit, without publishing a final answer',async()=>{
 let calls=0;const events:StreamEvent[]=[];
 await expect(runTopicTreeSession({env:env(),request:request(1),signal:new AbortController().signal,fetchImpl:async()=>{calls++;return response('',true);},emit:e=>events.push(e)})).rejects.toThrow();
 expect(calls).toBe(16);expect(events.some(e=>e.type==='done'||e.type==='delta')).toBe(false);
});

test('TEST concurrent SDK hosts keep provider transport, topic registration and output isolated',async()=>{
 let entered=0,release!:()=>void;const barrier=new Promise<void>(resolve=>{release=resolve;});
 const run=async(label:string)=>{
  const events:StreamEvent[]=[];
  const entries=await runTopicTreeSession({env:env(),request:{...request(1),topicTree:{...request(1).topicTree!,workId:label},messages:[{role:'system',content:`TEST current rule ${label}`},{role:'user',content:`TEST work ${label}`}]},signal:new AbortController().signal,fetchImpl:async(_url,init)=>{
   const body=JSON.parse(String(init?.body));expect(JSON.stringify(body.messages)).toContain(label);expect(body.tools.map((t:any)=>t.function.name)).toEqual(['recall_topic']);
   if(++entered===2) release();await barrier;return response(label);
  },emit:e=>events.push(e)});
  return {entries,text:events.filter(e=>e.type==='delta').map(e=>e.text).join('')};
 };
 const [a,b]=await Promise.all([run('TEST-private-A'),run('TEST-private-B')]);
 expect(a.text).toBe('TEST-private-A');expect(b.text).toBe('TEST-private-B');
 expect(JSON.stringify(a.entries)).not.toContain('TEST-private-B');expect(JSON.stringify(b.entries)).not.toContain('TEST-private-A');
});
