import { useState } from 'react';
import { Button, Select, Textarea } from '@/components/ui';
import { t } from '@/i18n';
import { useAsyncData } from '@/components/data/useAsyncData';
import { AsyncNotice } from '@/components/data/AsyncNotice';
import { listStructuralRevisions, proposeStructuralRevision, chooseStructuralRevision, authorizeStructuralEdits } from '@/novel/structuralRevision';
import { exploreStoryPresentation, listStoryExplorations, explorationToBranch, reauditStoryExploration, trialOutlineScenes, listProseTrials, type ExplorationGoal } from '@/novel/storyExploration';
import type { StoryAction } from './StoryWorkspace';
import type { StoryWorkspace } from '@/db/repos/storyGraphRepo';
import type { DocumentPlanProposal } from '@/db/repos/planProposalsRepo';
import { OutlineReviewStateSchema } from '@the-water/shared';
import { toast } from '@/components/Toast';
import { listVersions } from '@/db/repos/chaptersRepo';
import { listLiteraryReviewPackets, prepareLiteraryReview, saveHumanLiteraryReview, type LiteraryReviewTask } from '@/novel/literaryEvaluation';

export function StructuralRevisionPanel({novelId,w,act,busy,onResume}:{novelId:string;w:StoryWorkspace;act:StoryAction;busy:boolean;onResume:(id:string)=>void}) {
  const [instruction,setInstruction]=useState(''), [tick,setTick]=useState(0);
  const {data,error,reload}=useAsyncData(()=>listStructuralRevisions(novelId),{key:`structural:${novelId}:${w.revision}:${tick}`});
  const labels=t.studio.development;
  const run=(fn:Parameters<StoryAction>[0])=>act(async signal=>{await fn(signal);setTick(t=>t+1);});
  return <section className="space-y-3 rounded-xl border border-paper-300 p-4">
    <h3 className="font-semibold">{labels.structural}</h3><p className="text-sm text-ink-500">{labels.structuralHint}</p>
    <Textarea aria-label={labels.concern} value={instruction} onChange={e=>setInstruction(e.target.value)} rows={3}/>
    <Button disabled={busy || !instruction.trim()} onClick={()=>run(signal=>proposeStructuralRevision(novelId,instruction,signal))}>{labels.propose}</Button>
    {!!error && <AsyncNotice error={error} retry={reload}/>}
    {data?.map(s=><article key={s.id} className="space-y-2 border-t border-paper-300 pt-3"><strong>{s.report.problem}</strong><p>{labels.cause}: {s.report.cause}</p><p>{s.report.themeQuestion}</p>
      {s.report.evidence.map((e,i)=><blockquote key={i}>#{w.chapters.find(c=>c.id===e.chapterId)?.chapterNo} · 「{e.quote}」</blockquote>)}
      {s.report.alternatives.map((a,i)=><details key={i}><summary>{a.title}</summary><p>{a.rationale}</p><p>{a.themeTrajectory}</p><p>{labels.preserve}: {a.preserve.join('；')}</p><p>{labels.impact}: {a.impacts.join('；')}</p>{a.actions.map((action,j)=><p key={j}>#{w.chapters.find(c=>c.id===action.chapterId)?.chapterNo} · {action.instruction}</p>)}<Button disabled={busy || !!s.proposalId} onClick={()=>run(()=>chooseStructuralRevision(novelId,s.id,i))}>{labels.choosePlan}</Button></details>)}
      {s.proposalId && <><p>{labels.adoptFirst}</p><Button disabled={busy || !!s.mandateId} onClick={()=>run(()=>authorizeStructuralEdits(novelId,s.id))}>{labels.editChapters}</Button>{s.mandateId&&<Button disabled={busy} onClick={()=>onResume(s.mandateId!)}>{t.storyWorkspace.continueTask}</Button>}</>}
    </article>)}
  </section>;
}

export function PresentationExplorationPanel({novelId,goal,sceneId=null}:{novelId:string;goal:ExplorationGoal;sceneId?:string|null}) {
  const [facts,setFacts]=useState(''),[busy,setBusy]=useState(false),[tick,setTick]=useState(0),[error,setError]=useState('');
  const {data}=useAsyncData(()=>listStoryExplorations(novelId),{key:`presentation:${novelId}:${tick}`});
  const labels=t.studio.development;
  const run=async(fn:()=>Promise<unknown>)=>{if(busy)return;setBusy(true);setError('');try{await fn();setTick(t=>t+1);}catch(e){setError(String(e));}finally{setBusy(false);}};
  return <section className="space-y-3"><p>{labels.fixedHint}</p><Textarea aria-label={labels.fixedFacts} rows={5} value={facts} onChange={e=>setFacts(e.target.value)}/><Button disabled={busy||!facts.trim()} onClick={()=>void run(()=>exploreStoryPresentation(novelId,goal,facts,sceneId,new AbortController().signal))}>{labels.explore}</Button>{error&&<p role="alert">{error}</p>}
    {data?.filter(s=>s.goal===goal).map(s=><article key={s.id} className="rounded-xl border border-paper-300 p-4"><p>{s.fixedFacts}</p><Button disabled={busy} onClick={()=>void run(()=>reauditStoryExploration(novelId,s.id,new AbortController().signal))}>{labels.reaudit}</Button><div className="grid gap-4 md:grid-cols-2">{s.candidates.map((c,i)=>{const audit=s.audit.candidates.find(a=>a.index===i);return <section key={i}><h4>{c.title}</h4><p>{c.method}</p><p>{c.readerExperience}</p><p className="my-3 whitespace-pre-wrap">{c.sample}</p>{audit&&<p role="status">{labels[audit.status]}</p>}<p>{audit?.reason}</p><p role="status">{audit?.causality ? labels.causalityStatus[audit.causality.status] : labels.causalityPending}</p><p>{audit?.causality?.reason}</p>{audit?.causality?.evidence.map((e,j)=><blockquote key={`causal-${j}`}>「{e.quote}」</blockquote>)}<p>{labels.preserve}: {audit?.preserve.join('；')}</p><p>{labels.loss}: {audit?.loss.join('；')}</p>{audit?.evidence.map((e,j)=><blockquote key={j}>「{e.quote}」</blockquote>)}{s.sceneId&&<Button disabled={busy||audit?.status!=='supported'||audit?.causality?.status!=='supported'} onClick={()=>void run(async()=>{await explorationToBranch(novelId,s.id,i);toast.success(labels.branchCreated);})}>{labels.toBranch}</Button>}</section>;})}</div>{s.audit.differences.map((d,i)=><p key={i}>{s.candidates[d.left]?.title} / {s.candidates[d.right]?.title} · {d.axis}: {d.explanation}</p>)}</article>)}
  </section>;
}

export function OutlineTrialPanel({novelId,proposal}:{novelId:string;proposal:DocumentPlanProposal}) {
  const parsed=OutlineReviewStateSchema.safeParse(proposal.meta.outlineReview);
  const purposes=parsed.success ? parsed.data.report?.proseValidation ?? [] : [];
  const [selected,setSelected]=useState<string[]>([]),[busy,setBusy]=useState(false),[tick,setTick]=useState(0);
  const {data}=useAsyncData(()=>listProseTrials(novelId),{key:`trials:${novelId}:${proposal.id}:${tick}`});
  const labels=t.studio.development;
  if(!purposes.length)return null;
  return <details className="mt-3"><summary>{labels.trial}</summary><p>{labels.trialHint}</p>{purposes.map((p,i)=><label key={i} className="my-2 flex gap-2"><input type="checkbox" checked={selected.includes(p)} disabled={busy||!selected.includes(p)&&selected.length>=3} onChange={e=>setSelected(s=>e.target.checked?[...s,p]:s.filter(v=>v!==p))}/>{p}</label>)}<Button disabled={busy||!selected.length} onClick={async()=>{setBusy(true);try{await trialOutlineScenes(novelId,proposal.id,selected,new AbortController().signal);}catch(e){toast.error(String(e));}finally{setTick(t=>t+1);setBusy(false);}}}>{labels.trial}</Button>{data?.filter(r=>r.proposalId===proposal.id).map(r=><article key={r.id}><h4>{r.purpose}</h4><p className="whitespace-pre-wrap">{r.sample}</p>{r.uncertainties?.map((u,i)=><p key={i}>{u}</p>)}</article>)}</details>;
}

export function LiteraryEvaluationPanel({novelId,w,act,busy}:{novelId:string;w:StoryWorkspace;act:StoryAction;busy:boolean}) {
  const [chapterId,setChapterId]=useState(w.chapters[0]?.id ?? ''),[task,setTask]=useState<LiteraryReviewTask>('first_reading'),[versionId,setVersionId]=useState(''),[tick,setTick]=useState(0),[feedback,setFeedback]=useState<Record<string,string>>({});
  const {data:versions}=useAsyncData(()=>chapterId?listVersions(chapterId):Promise.resolve([]),{key:`evaluation-versions:${chapterId}:${w.revision}`});
  const {data:packets}=useAsyncData(()=>listLiteraryReviewPackets(novelId),{key:`evaluation-packets:${novelId}:${tick}`});
  const labels=t.studio.development;
  return <section className="space-y-3 rounded-xl border border-paper-300 p-4"><h3>{labels.evaluation}</h3><p>{labels.evaluationHint}</p>
    <Select aria-label={t.storyWorkspace.chapter} value={chapterId} onChange={e=>{setChapterId(e.target.value);setVersionId('');}}>{w.chapters.map(c=><option key={c.id} value={c.id}>#{c.chapterNo} · {c.title}</option>)}</Select>
    <Select aria-label={labels.evaluation} value={task} onChange={e=>setTask(e.target.value as LiteraryReviewTask)}>{(['first_reading','consistency','revision_value'] as const).map(key=><option key={key} value={key}>{labels[key]}</option>)}</Select>
    {task==='revision_value'&&<Select aria-label={labels.otherVersion} value={versionId} onChange={e=>setVersionId(e.target.value)}><option value="">{labels.otherVersion}</option>{versions?.filter(v=>v.id!==w.chapters.find(c=>c.id===chapterId)?.currentVersionId).map(v=><option key={v.id} value={v.id}>{v.versionNo}</option>)}</Select>}
    <Button disabled={busy||!chapterId||task==='revision_value'&&!versionId} onClick={()=>act(async()=>{await prepareLiteraryReview(novelId,chapterId,task,versionId);setTick(t=>t+1);})}>{labels.preparePacket}</Button>
    {packets?.map(({packet,state,feedback:record})=><details key={packet.id}><summary>{labels[packet.task]} · {state==='human_reviewed'?labels.humanReviewed:labels.awaitingHuman}</summary><p>{packet.instruction}</p>{packet.texts.map((s,i)=><article key={i}><h4>{s.label} · #{s.chapterNo}</h4><p className="whitespace-pre-wrap">{s.text}</p></article>)}{packet.materials!==undefined&&<pre className="overflow-auto">{JSON.stringify(packet.materials,null,2)}</pre>}{record&&<p>{record.judgment}</p>}<Textarea aria-label={labels.humanFeedback} value={feedback[packet.id]??''} onChange={e=>setFeedback(f=>({...f,[packet.id]:e.target.value}))}/><Button disabled={busy||!feedback[packet.id]?.trim()} onClick={()=>act(async()=>{await saveHumanLiteraryReview(novelId,packet.id,{judgment:feedback[packet.id]!,findings:[]});setTick(t=>t+1);})}>{labels.saveFeedback}</Button></details>)}
  </section>;
}
