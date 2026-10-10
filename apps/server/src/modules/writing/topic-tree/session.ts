import { createAgentSession, DefaultResourceLoader, SettingsManager, SessionManager, ModelRuntime, type FileEntry } from '@earendil-works/pi-coding-agent';
import { stream as streamOpenAI } from '@earendil-works/pi-ai/api/openai-completions';
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript';
import { InMemoryCredentialStore, type AssistantMessage, type Model, type TranscriptContext } from '@earendil-works/pi-ai';
import { registerTopicTree } from './vendor/index';
import { estimateMessagesTokens } from '@the-water/llm/tokens';
import { LLMError, type StreamEvent, type FetchLike } from '@the-water/llm/types';
import type { HarnessRequest } from '@the-water/shared';
import type { Env } from '../../../env';

export const MAX_TOPIC_MODEL_CALLS = 16;
const MEMORY_RULE = `【历史记忆边界】recall_topic 返回的是本作品、方案、审阅角色的历史工作记录，不是正式正文事实。摘要仅用于导航，旧计划、未采纳候选与审稿意见不得变成既成事实。所有设定、作者锁定、人物知情边界、当前伏笔阶段、事实和版本均以本次请求中已确认资料为准；历史与当前资料冲突时遵循当前资料，不补造。需要旧记录的准确细节时调用 recall_topic 后核对原文；不要根据摘要推断正文发生了什么。工具只用于读取历史，不得修改计划或正文。`;

/** Actual Pi coding-agent SDK + upstream topic-tree extension. Only recall_topic is available. */
export async function runTopicTreeSession(input: {
 env: Env; request: HarnessRequest; entries?: FileEntry[]; signal: AbortSignal;
 fetchImpl: FetchLike; emit(event:StreamEvent):void;
}): Promise<FileEntry[]> {
 const {env,request,signal}=input;
 const manager=SessionManager.inMemory('/the-water-private-session',undefined,input.entries);
 // Monotonic timestamps keep upstream turn IDs unique even for retries in one millisecond.
 let timestamp=Math.max(Date.now(),...manager.getEntries().map(e=>e.type==='message'?e.message.timestamp:0));
 const settings=SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:false},cacheWarming:'off'});
 const runtime=await ModelRuntime.create({credentials:new InMemoryCredentialStore(),modelsPath:null,refreshOnCreate:false,allowModelNetwork:false});
 let calls=0, inputTokens=0, outputTokens=0, allInputKnown=true, allOutputKnown=true;
 let failure:unknown;
 const pendingUsage:Promise<void>[]=[];
 const model:Model<'openai-completions'>={id:env.writingModel,name:env.writingModel,api:'openai-completions',provider:'the-water-lunaroute',baseUrl:'https://gw.lunaroute.com/v1',input:['text'],reasoning:true,contextWindow:1048576,maxTokens:env.writingMaxOutputTokens,cost:{input:NaN,output:NaN,cacheRead:NaN,cacheWrite:NaN},compat:{supportsDeveloperRole:false,requiresReasoningContentOnAssistantMessages:true}};
 const metered=(context:TranscriptContext,maxTokens:number,json:HarnessRequest['json'],temperature:number|undefined,abort:AbortSignal) => {
  if(++calls>MAX_TOPIC_MODEL_CALLS) throw new LLMError('bad_request','主题记忆模型调用超过单次任务上限；未提交正文');
  const texts=context.messages.map(m=>({role:m.role==='assistant'?'assistant' as const:m.role==='system'?'system' as const:'user' as const,content: typeof m.content==='string'?m.content:JSON.stringify(m.content)}));
  if(estimateMessagesTokens(texts,0.7)+maxTokens+env.writingReasoningTokens+1500>model.contextWindow) throw new LLMError('context_length','投影后上下文仍超窗；未删减本次必需资料');
  const trackedFetch: typeof fetch=Object.assign(async(url:Parameters<typeof fetch>[0],init?:Parameters<typeof fetch>[1])=>{
   const response=await input.fetchImpl(url instanceof Request?url.url:String(url),init);
   if(!response.ok) failure=new LLMError(response.status===401||response.status===403?'auth':response.status===429?'rate_limit':response.status>=500?'server':'bad_request',`模型供应商返回 HTTP ${response.status}`,{status:response.status});
   const measured=response.clone().text().then(raw=>{
    let usage:{prompt_tokens?:number;completion_tokens?:number}|undefined;
    for(const line of raw.split('\n')) if(line.startsWith('data: ')) {try {const value=JSON.parse(line.slice(6));if(value.usage) usage=value.usage;}catch{/* SSE terminator is not JSON. */}}
    if(typeof usage?.prompt_tokens==='number' && Number.isSafeInteger(usage.prompt_tokens) && usage.prompt_tokens>=0) inputTokens+=usage.prompt_tokens;else allInputKnown=false;
    if(typeof usage?.completion_tokens==='number' && Number.isSafeInteger(usage.completion_tokens) && usage.completion_tokens>=0) outputTokens+=usage.completion_tokens;else allOutputKnown=false;
    input.emit({type:'usage',cumulative:true,inputTokens,outputTokens,inputReported:allInputKnown,outputReported:allOutputKnown});
   });pendingUsage.push(measured);return response;
  },{preconnect:fetch.preconnect});
  return streamOpenAI(model,context,{apiKey:env.lunarouteApiKey,fetch:trackedFetch,signal:abort,maxTokens:maxTokens+env.writingReasoningTokens,temperature,reasoningEffort:env.writingReasoningEffort,timeoutMs:180000,maxRetries:0,onPayload:raw=>{
   const body=raw as Record<string,unknown>;
   body.max_tokens=maxTokens+env.writingReasoningTokens;delete body.max_completion_tokens;
   body.reasoning_effort=env.writingReasoningEffort;
   if(request.stop) body.stop=request.stop;
   if(json) body.response_format=env.writingJsonMode==='json_schema'?{type:'json_schema',json_schema:{name:json.name,strict:true,schema:json.schema}}:{type:'json_object'};
   return body;
  }});
 };
 runtime.registerProvider(model.provider,{api:model.api,apiKey:env.lunarouteApiKey,baseUrl:model.baseUrl,models:[model],streamSimple:(_model,context)=>metered(context,request.maxTokens,request.json,request.temperature,signal)});
 const host={complete:async(system:string,prompt:string,maxTokens:number,lifetime:AbortSignal)=>{
  const stream=metered(normalizeContext({systemPrompt:system,messages:[{role:'user',content:prompt,timestamp:++timestamp}]}),maxTokens,undefined,0.1,AbortSignal.any([signal,lifetime]));
  const reply=await stream.result();
  if(reply.stopReason==='error'||reply.stopReason==='aborted') throw new LLMError(signal.aborted?'aborted':'server','主题分类或摘要请求失败');
  if(reply.stopReason!=='stop') throw new LLMError('bad_request','主题分类或摘要响应未完整结束');
  return reply.content.filter(b=>b.type==='text').map(b=>b.text).join('\n');
 },onError:(error:unknown)=>{failure=error;}};
 const system=request.messages.filter(m=>m.role==='system').map(m=>m.content).join('\n\n')+'\n'+MEMORY_RULE;
 const loader=new DefaultResourceLoader({cwd:'/the-water-private-session',agentDir:'/the-water-private-session',settingsManager:settings,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,systemPrompt:system,extensionFactories:[pi=>{
  registerTopicTree(pi,{PI_TOPIC_TREE:'1'},host);
  // Authoritative context is pinned by the host, never inferred from old model outputs.
  const original=pi.getFlag.bind(pi);
  pi.getFlag=name=>name==='topic-tree-fold-tool-calls'?'0':name==='topic-tree-classify-every'?'1':original(name);
 }]});
 await loader.reload();
 const last=request.messages.at(-1);
 if(!last || last.role!=='user') throw new LLMError('bad_request','主题会话要求最后一条消息为用户任务');
 for(const message of request.messages.slice(0,-1)) if(message.role!=='system') {
  manager.appendMessage(message.role==='user'?{role:'user',content:message.content,timestamp:++timestamp}:{role:'assistant',content:[{type:'text',text:message.content}],api:model.api,provider:model.provider,model:model.id,usage:{input:NaN,output:NaN,cacheRead:NaN,cacheWrite:NaN,totalTokens:NaN,cost:{input:NaN,output:NaN,cacheRead:NaN,cacheWrite:NaN,total:NaN}},stopReason:'stop',timestamp:++timestamp});
 }
 manager.appendCustomEntry('the-water.request',{scope:request.topicTree,binding:request.binding,canonical:false});
 const {session}=await createAgentSession({cwd:'/the-water-private-session',agentDir:'/the-water-private-session',sessionManager:manager,settingsManager:settings,resourceLoader:loader,modelRuntime:runtime,model,thinkingLevel:env.writingReasoningEffort,tools:['recall_topic'],noTools:'builtin'});
 await session.bindExtensions({mode:'print',onError:()=>{failure??=new LLMError('server','主题记忆扩展执行失败');}});
 let final:AssistantMessage|undefined;
 const unsubscribe=session.subscribe(event=>{if(event.type==='message_end' && event.message.role==='assistant') final=event.message as AssistantMessage;});
 const abort=()=>{void session.abort();};signal.addEventListener('abort',abort,{once:true});
 try {
  if(signal.aborted) throw new LLMError('aborted','主题会话已取消');
  await session.prompt(last.content,{expandPromptTemplates:false});
  await Promise.all(pendingUsage);
  if(signal.aborted) throw new LLMError('aborted','主题会话已取消');
  if(failure) throw failure;
  if(!final || !['stop','length'].includes(final.stopReason)) throw new LLMError('server','主题会话未生成完整正文响应');
  // Tool-loop commentary cannot pollute JSON/prose. Publish only the final answer.
  for(const block of final.content) if(block.type==='text') input.emit({type:'delta',text:block.text});
  input.emit({type:'done',finishReason:final.stopReason as 'stop'|'length'});
  return [manager.getHeader()!,...manager.getEntries()];
 } finally {signal.removeEventListener('abort',abort);unsubscribe();session.dispose();await Promise.allSettled(pendingUsage);}
}
