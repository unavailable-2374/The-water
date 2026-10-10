/** REAL network responses on labeled TEST fiction; no literary quality or human-feedback claim. */
import { it, expect } from 'vitest';
import { existsSync, writeFileSync } from 'node:fs';
import { useTestDb } from '../helpers/testDb';
import { evaluationCredential, evaluationSource } from './runtime';
import { createProvider } from '@/db/repos/providersRepo';
import { createNovel } from '@/db/repos/novelsRepo';
import { createVersion, getChapter, upsertChapterPlan } from '@/db/repos/chaptersRepo';
import { upsertCharacter } from '@/db/repos/storylineRepo';
import { saveWritingCard } from '@/db/repos/writingRepo';
import { proposeDocumentPlan, listDocumentPlans } from '@/db/repos/planProposalsRepo';
import { setSecretStore } from '@/secrets/keychain';
import { setFetchImpl } from '@/llm/registry';
import { defaultRequirements } from '@/novel/types';
import { proposeStructuralRevision, listStructuralRevisions, chooseStructuralRevision, revisionSource } from '@/novel/structuralRevision';
import { exploreStoryPresentation, listStoryExplorations, trialOutlineScenes, explorationToBranch } from '@/novel/storyExploration';

it.skipIf(process.env.RUN_REAL_STORY_DEVELOPMENT!=='1')('REAL structural alternatives, same-fact narration audit and outline trial remain candidates',async()=>{
  const {key,source:credentialSource}=evaluationCredential();
  const path=process.env.REAL_STORY_DEVELOPMENT_RECORD;
  if(!path)throw new Error('REAL_STORY_DEVELOPMENT_RECORD is required');
  if(existsSync(path))throw new Error('Refusing to overwrite real evaluation evidence');
  const scope=process.env.REAL_STORY_DEVELOPMENT_SCOPE ?? 'all';
  if(!['all','narration'].includes(scope))throw new Error('REAL_STORY_DEVELOPMENT_SCOPE must be all or narration');
  const db=useTestDb(),pending:Promise<void>[]=[];
  const record:Record<string,unknown>={label:'REAL AI responses to TEST fiction; not human literary evaluation',...evaluationSource(),scope,credentialSource,startedAt:new Date().toISOString(),stages:{},requests:[]};
  const stages=record.stages as Record<string,unknown>,requests=record.requests as Record<string,unknown>[];
  setSecretStore({get:async()=>key,set:async()=>undefined,delete:async()=>undefined});
  setFetchImpl(async(url,init)=>{
    const request:Record<string,unknown>={url,body:JSON.parse(String(init?.body)),startedAt:new Date().toISOString()};requests.push(request);
    const response=await fetch(url,init);request.httpStatus=response.status;
    pending.push(response.clone().text().then(body=>{request.responseBody=body;request.finishedAt=new Date().toISOString();},e=>{request.responseReadError=String(e);}));
    return response;
  });
  const signal=AbortSignal.timeout(12*60*1000);
  try {
    const config=await createProvider({name:'REAL TEST development',kind:'openai_compatible',baseUrl:'https://gw.lunaroute.com/v1',model:'deepseek-4.1-flash',contextWindow:1048576,maxOutputTokens:262144,reasoningTokens:32000,reasoningEffort:'low',jsonMode:'json_schema',temperature:0.6,extraHeaders:{},secretRef:'TEST environment',firstByteTimeoutMs:120000,idleTimeoutMs:120000});
    record.parameters={model:config.model,contextWindow:config.contextWindow,maxOutputTokens:config.maxOutputTokens,reasoningTokens:config.reasoningTokens,reasoningEffort:config.reasoningEffort,jsonMode:config.jsonMode};
    const novel=await createNovel({title:'TEST 关系修订',premise:'TEST 虚构故事：姐姐与弟弟经营旧店。弟弟曾越权签约，使姐姐损失存款。结尾两人愿意有限合作，但姐姐保留签字权；不得抹掉损失。',requirements:defaultRequirements(),targetChars:1500});
    const sister=await upsertCharacter(novel.id,{name:'TEST 姐姐',description:'重视自主权，愿意合作但拒绝被代替决定'}),brother=await upsertCharacter(novel.id,{name:'TEST 弟弟',description:'习惯替姐姐安排，尚未证明能遵守边界'});
    const chapters=[];
    for(const [i,text] of ['TEST 虚构正文。弟弟把合同放在柜台上。姐姐看见落款是自己的名字，签字却不是自己的笔迹。“你替我签了？”他答：“这对你有好处。”姐姐从存折里取出赔款，没有回答。店门上的铃响了，她转身去接待客人。','TEST 虚构正文。弟弟来到店里，只说了一句对不起。姐姐随即说：“我原谅你了，明天我们一起开店。”新的租约放在桌上。弟弟伸手拿笔，她把笔收了回来：“店可以一起开。我的名字，还是由我自己签。”'].entries()) {
      const chapter=await upsertChapterPlan(novel.id,{chapterNo:i+1,title:`TEST ${i+1}`,targetChars:750});
      const version=await createVersion({chapterId:chapter.id,content:text,source:'user_edit'});
      const sceneId=await saveWritingCard(novel.id,{kind:'scene',data:{title:`TEST scene ${i+1}`,volumeId:null,povCharacterId:sister.id,time:`第${i+1}天`,location:'旧店',characterIds:[sister.id,brother.id],goal:i===0?'承担签约损失':'有限合作',obstacle:'弟弟越权决定',turn:i===0?'发现代签':'道歉后立即原谅',outcome:i===0?'姐姐承担赔款':'合作但签字权未改变',targetChars:750,dependencyIds:[],threadIds:[]}},{chapterId:chapter.id,confirmed:true});
      chapters.push({chapter,version,sceneId});
    }
    record.input=(await revisionSource(novel.id)).input;
    if(scope==='all') {
      const revisionId=await proposeStructuralRevision(novel.id,'TEST 第2章立即原谅是否缺少前文行为改变？提供不同的跨章修改方案；保留损失与签字边界。',signal);
      stages.structural=(await listStructuralRevisions(novel.id)).find(r=>r.id===revisionId);
      expect((stages.structural as {report:{alternatives:unknown[]}}).report.alternatives.length).toBeGreaterThanOrEqual(2);
      const proposalId=await chooseStructuralRevision(novel.id,revisionId,0);
      stages.stagedPlan=(await listDocumentPlans(novel.id)).find(p=>p.id===proposalId);
    }
    await exploreStoryPresentation(novel.id,'narration','TEST 固定事件：弟弟道歉，姐姐答应合作并收回笔，保留本人签字权；不新增人物经历，不改变这些行动或结果。只比较视角、知情顺序及叙述距离。',chapters[1]!.sceneId,signal);
    const narration=(await listStoryExplorations(novel.id))[0]!;stages.narration=narration;
    expect(narration.audit.candidates.length).toBeGreaterThanOrEqual(2);
    if(scope==='narration') {
      const supported=narration.audit.candidates.find(c=>c.status==='supported'&&c.causality?.status==='supported');
      expect(supported,'At least one narration candidate must preserve fixed facts before staging a branch').toBeDefined();
      stages.branch=await explorationToBranch(novel.id,narration.id,supported!.index);
    } else {
      const source=await revisionSource(novel.id),trialPlan=await proposeDocumentPlan(novel.id,source.doc,'TEST 独立大纲试写');
      stages.trials=await trialOutlineScenes(novel.id,trialPlan,['TEST 姐姐第一次看见弟弟把决定权交还给她的场面；没有被原谅的保证。检验行动是否支持有限合作，不能直接宣布治愈。'],signal);
    }
    for(const c of chapters){expect((await getChapter(c.chapter.id))!.currentVersionId).toBe(c.version.id);expect((await getChapter(c.chapter.id))!.committedVersionId).toBeNull();}
    record.status='schema_evidence_and_candidate_isolation_verified';
  }catch(e){record.status='failed';record.error=String(e);throw e;}
  finally{await Promise.allSettled(pending);record.finishedAt=new Date().toISOString();record.usage=await db.select('SELECT purpose,model,input_tokens,output_tokens FROM usage_events');writeFileSync(path,JSON.stringify(record,null,2));db.raw.close();}
},13*60*1000);
