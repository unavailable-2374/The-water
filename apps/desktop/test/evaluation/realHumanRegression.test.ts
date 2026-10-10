/** REAL model re-audit of frozen TEST fiction. Human answers are deliberately excluded from requests. */
import { it, expect } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { evaluationCredential, evaluationSource } from './runtime';
import { useTestDb } from '../helpers/testDb';
import { createProvider } from '@/db/repos/providersRepo';
import { createNovel } from '@/db/repos/novelsRepo';
import { defaultRequirements } from '@/novel/types';
import { setSecretStore } from '@/secrets/keychain';
import { setFetchImpl, providerFromConfig } from '@/llm/registry';
import { requestJson } from '@/llm/json';
import { firstReadingPrompt, locateFirstReading } from '@/llm/prompts/firstReading';
import { auditStoryPresentation } from '@/novel/storyExploration';
import { sha256Hex } from '@the-water/shared';

it.skipIf(process.env.RUN_REAL_HUMAN_REGRESSION!=='1')('REAL frozen samples get independent understanding and mechanism audits',async()=>{
  const path=process.env.REAL_HUMAN_REGRESSION_RECORD;
  if(!path)throw new Error('REAL_HUMAN_REGRESSION_RECORD is required');
  if(existsSync(path))throw new Error('Refusing to overwrite real evaluation evidence');
  const {key,source:credentialSource}=evaluationCredential(),db=useTestDb(),pending:Promise<void>[]=[];
  const requests:Record<string,unknown>[]=[];
  const record:Record<string,unknown>={label:'REAL AI re-audit of frozen TEST fiction, not new human feedback or literary improvement proof',...evaluationSource(),credentialSource,startedAt:new Date().toISOString(),requests};
  setSecretStore({get:async()=>key,set:async()=>undefined,delete:async()=>undefined});
  setFetchImpl(async(url,init)=>{
    const entry:Record<string,unknown>={url,body:JSON.parse(String(init?.body))};requests.push(entry);
    const response=await fetch(url,init);entry.httpStatus=response.status;
    pending.push(response.clone().text().then(body=>{entry.responseBody=body;}));return response;
  });
  try {
    const root=resolve('../../docs/writing/evaluation');
    const prosePacket=readFileSync(resolve(root,'acceptance-first-reading-20261010.md'),'utf8');
    const text=prosePacket.split('## 正文 · 第 1 章\n\n')[1]!.split('\n\n## 评阅填写')[0]!;
    const comparison=readFileSync(resolve(root,'acceptance-narration-blind-20261010.md'),'utf8');
    const samples=[comparison.split('## X · 第 1 章\n\n')[1]!.split('\n\n## Y')[0]!,comparison.split('## Y · 第 1 章\n\n')[1]!.split('\n\n## 评阅填写')[0]!];
    const previous=JSON.parse(readFileSync(resolve(root,'story-narration-real-20261010-indexed.json'),'utf8'));
    const fixedFacts=previous.stages.narration.fixedFacts as string;
    expect(samples.every(sample=>previous.stages.narration.candidates.some((c:{sample:string})=>c.sample===sample))).toBe(true);
    const config=await createProvider({name:'REAL TEST human regression',kind:'openai_compatible',baseUrl:'https://gw.lunaroute.com/v1',model:'deepseek-4.1-flash',contextWindow:1048576,maxOutputTokens:262144,reasoningTokens:32000,reasoningEffort:'low',jsonMode:'json_schema',temperature:0.1,extraHeaders:{},secretRef:'TEST environment',firstByteTimeoutMs:120000,idleTimeoutMs:120000});
    record.parameters={model:config.model,reasoningEffort:config.reasoningEffort,jsonMode:config.jsonMode,contextWindow:config.contextWindow,maxOutputTokens:config.maxOutputTokens};
    const novel=await createNovel({title:'TEST frozen audit only',premise:'TEST fiction; no human answers supplied',requirements:defaultRequirements(),targetChars:1000});
    const sources=[{chapterNo:1,versionId:'TEST frozen prose',contentHash:await sha256Hex(text),text}];
    record.input={sources,fixedFacts,samples};
    const spec=firstReadingPrompt(sources),provider=await providerFromConfig(config);
    const first=await requestJson(provider,{...spec,schema:spec.schema!},{signal:AbortSignal.timeout(240000)});
    const reading=locateFirstReading(first.value,sources);record.firstReading=reading;
    const audit=await auditStoryPresentation(novel.id,'narration',fixedFacts,samples.map((sample,index)=>({title:index===0?'X':'Y',method:'TEST frozen narration',readerExperience:'TEST unverified',sample})),AbortSignal.timeout(240000));
    record.audit=audit;
    // These are diagnostic requirements, not a claim of agreement on taste or overall quality.
    expect(reading.observations.stakes.confidence).not.toBe('supported');
    expect(reading.inferenceChecks?.some(c=>c.status!=='supported'&&c.evidence.some(e=>e.evidence.quote.includes('真正看见'))),'The closing knowledge inference needs an explicit grounding concern').toBe(true);
    expect(audit.candidates.every(c=>c.causality)).toBe(true);
    expect(audit.candidates.some(c=>c.causality?.status==='missing_basis'||c.causality?.status==='contradiction'),'At least one frozen sample must expose the unestablished control mechanism').toBe(true);
    record.status='schema_evidence_and_mechanism_diagnosis_verified';
  }catch(e){record.status='failed';record.error=String(e);throw e;}
  finally{await Promise.allSettled(pending);record.finishedAt=new Date().toISOString();writeFileSync(path,JSON.stringify(record,null,2));db.raw.close();}
},600000);
