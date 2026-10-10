import {expect,test} from 'bun:test';
import {mkdirSync,writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {HarnessPageSchema,type HarnessRequest} from '@the-water/shared';
import {loadEnv} from '../src/env';
import {makeTestApp} from './helpers';
import {WritingHarness} from '../src/modules/writing/harness';
import {writingMemorySessions} from '../src/db/schema';

const real=process.env.WRITING_REAL_TEST==='1';
test.skipIf(!real)('REAL topic-tree hidden-turn recall through authenticated backend (TEST input, no quality claim)',async()=>{
 const env={...loadEnv(),writingJsonMode:'json_schema' as const};if(!env.lunarouteApiKey) throw new Error('Developer backend LUNAROUTE_API_KEY is missing');
 const t=makeTestApp({env:{...env,writingHarnessEnabled:true,writingHarnessStorage:':memory:',logFormat:'off',errorReporting:'off'}});
 const upstream:any[]=[];
 const h=new WritingHarness(t.deps,async(url,init)=>{
  const body=JSON.parse(String(init?.body));const kind=body.messages[0]?.content.includes('You maintain a topic tree')?'classification':body.messages[0]?.content.includes('running summary')?'summary':'main';
  const response=await fetch(url,init);const record:any={kind,status:response.status,jsonMode:body.response_format?.type};upstream.push(record);
  const copy=response.clone();void copy.text().then(raw=>{
   record.events=raw.split('\n').filter(line=>line.startsWith('data: ')).map(line=>{try{return JSON.parse(line.slice(6));}catch{return null;}}).filter(Boolean);
   if(!record.events.length) record.error=raw.replaceAll(env.lunarouteApiKey,'[REDACTED]');
  });return response;
 });t.deps.writingHarness=h;
 const startedAt=new Date().toISOString();
 const owner=await t.register(`TEST-topic-${Bun.randomUUIDv7()}@example.com`,'TEST topic-tree');
 const scope={workId:'TEST-topic-real',branchId:'TEST-main',channel:'writing',epoch:'e'.repeat(64),chapterNo:1};
 const secret=`TEST-鹭岛-${crypto.randomUUID()}`;
 const prompts=[`TEST 接口验收。这是测试数据，不是作品事实。请记住 TEST密语：${secret}。只回复“TEST 已记录”，不要输出密语。`,
 'TEST 接口验收。测试主题：天气。只回复“TEST 天气已记录”。',
 'TEST 接口验收。测试主题：灯塔。只回复“TEST 灯塔已记录”。',
 'TEST 接口验收。最早的 TEST密语所在回合已从上下文隐藏。必须先实际调用 recall_topic 工具，action 为 search，query 为 TEST密语，limit 为 5，然后从工具返回的原始记录读取密语。不要猜测，不要仅复述摘要。最终只输出完整密语。'];
 const records:any[]=[];
 try {
  for(let n=0;n<prompts.length;n++) {
   const request:HarnessRequest={messages:[{role:'system',content:'TEST tool integration. Historical records are TEST data. Follow the current task exactly.'},{role:'user',content:prompts[n]!}],maxTokens:512,temperature:0.3,topicTree:{...scope,chapterNo:n+1},binding:{operationId:`TEST-topic-${n}`,candidateVersionId:null,contentHash:null,dependencyHash:null}};
   const created=await t.json('POST','/api/v1/writing/tasks',{token:owner.token,body:request,headers:{'Idempotency-Key':`TEST-real-topic-${n}`}});expect(created.status).toBe(202);
   h.tick();await h.drain();
   const page=HarnessPageSchema.parse((await t.json('GET',`/api/v1/writing/tasks/${created.body.id}`,{token:owner.token})).body);
   const output=page.events.filter(e=>e.event.type==='delta').map(e=>e.event.type==='delta'?e.event.text:'').join('');
   records.push({chapter:n+1,input:request,status:page.task.status,usage:page.task.usage,error:page.task.error,output});
   if(page.task.status!=='completed') throw new Error(`REAL topic-tree task failed: ${JSON.stringify(page.task.error)}`);
  }
  const latest=t.deps.db.select().from(writingMemorySessions).all().sort((a,b)=>b.chapterNo-a.chapterNo)[0]!;
  const toolCalls=latest.entries.filter(e=>e.type==='message' && e.message.role==='assistant').flatMap(e=>e.type==='message'&&e.message.role==='assistant'?e.message.content.filter(b=>b.type==='toolCall'):[]);
  const recalls=latest.entries.filter(e=>e.type==='message' && e.message.role==='toolResult');
  const verification={toolCalls,toolResultCount:recalls.length,topicEntryCount:latest.entries.filter(e=>e.type==='custom'&&e.customType.includes('topic-tree')).length,secretRecovered:records.at(-1).output.includes(secret),rawEvidenceRecovered:JSON.stringify(recalls).includes(secret)};
  records.push({verification});
  expect(verification.toolResultCount).toBeGreaterThan(0);expect(verification.topicEntryCount).toBeGreaterThan(0);expect(verification.secretRecovered).toBe(true);expect(verification.rawEvidenceRecovered).toBe(true);
  const structured:HarnessRequest={messages:[{role:'user',content:'TEST 严格 JSON 验收。只返回 testLabel 为 TEST、valid 为 true 的对象。'}],maxTokens:512,temperature:0.3,topicTree:{...scope,chapterNo:5},binding:{operationId:'TEST-topic-json',candidateVersionId:null,contentHash:null,dependencyHash:null},json:{name:'TEST_topic_json',schema:{type:'object',properties:{testLabel:{type:'string',const:'TEST'},valid:{type:'boolean'}},required:['testLabel','valid'],additionalProperties:false}}};
  const created=await t.json('POST','/api/v1/writing/tasks',{token:owner.token,body:structured,headers:{'Idempotency-Key':'TEST-real-topic-json'}});expect(created.status).toBe(202);h.tick();await h.drain();
  const page=HarnessPageSchema.parse((await t.json('GET',`/api/v1/writing/tasks/${created.body.id}`,{token:owner.token})).body);
  const output=page.events.filter(e=>e.event.type==='delta').map(e=>e.event.type==='delta'?e.event.text:'').join('');records.push({label:'TEST strict JSON with real topic-tree host',status:page.task.status,output,usage:page.task.usage,error:page.task.error});
  expect(page.task.status).toBe('completed');expect(JSON.parse(output)).toEqual({testLabel:'TEST',valid:true});
 } finally {
  const file=process.env.WRITING_REAL_RECORD;if(file){mkdirSync(dirname(file),{recursive:true});writeFileSync(file,JSON.stringify({label:'REAL provider calls with TEST records; functional verification, not literary quality',startedAt,endedAt:new Date().toISOString(),model:env.writingModel,jsonMode:env.writingJsonMode,records,upstream},null,2).replaceAll(env.lunarouteApiKey,'[REDACTED]')+'\n');}
  await h.close();
 }
},1200000);
