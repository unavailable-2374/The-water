/** TEST rendering fixtures; no user novels or real model results. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { emptyStoryline } from '@the-water/shared';
import { PlanReview } from '@/features/studio/PlanReview';
import { jobReviewPath } from '@/jobs/presentation';
import { createNovel } from '@/db/repos/novelsRepo';
import { defaultRequirements } from '@/novel/types';
import { useTestDb } from '../helpers/testDb';
import { t } from '@/i18n';
import type { DocumentPlanProposal } from '@/db/repos/planProposalsRepo';

let db: ReturnType<typeof useTestDb>;
beforeEach(()=>{db=useTestDb();});afterEach(()=>db.raw.close());
const proposal=():DocumentPlanProposal=>({id:'TEST hidden proposal id',label:'TEST',before:emptyStoryline(),after:emptyStoryline(),meta:{outlineDone:true,logline:'TEST mainline'},baseHash:'TEST hidden hash'});
const novel=()=>createNovel({title:'TEST novel',premise:'TEST premise',targetChars:1000,requirements:defaultRequirements()});
it('places outline adoption above readable changes and keeps technical identifiers out of the preview',async()=>{
  const html=renderToStaticMarkup(createElement(PlanReview,{novel:await novel(),documents:[proposal()]}));
  expect(html).toContain(t.studio.workflow.acceptOutline);expect(html.indexOf(t.studio.workflow.acceptOutline)).toBeLessThan(html.indexOf('TEST mainline'));
  expect(html).not.toContain('TEST hidden proposal id');expect(html).not.toContain('TEST hidden hash');expect(html).not.toContain('planProposalId');
});
it('labels chapter-plan approval correctly and disables approval of invalid candidates',async()=>{
  const p=proposal();p.meta={tableDone:true};
  expect(renderToStaticMarkup(createElement(PlanReview,{novel:await novel(),documents:[p]}))).toContain(t.studio.workflow.acceptTable);
  p.meta={outlineDone:true,logline:''};
  const html=renderToStaticMarkup(createElement(PlanReview,{novel:await novel(),documents:[p]}));expect(html).toContain('role="alert"');expect(html).toContain('disabled');
});
it('routes review to the page and exact chapter that owns the checkpoint',()=>{
  const job={novelId:'TEST-novel',type:'generate_novel' as const,params:{stage:'plan'}};
  expect(jobReviewPath(job,{kind:'outline',chapterId:null})).toBe('/studio/TEST-novel/plan');
  expect(jobReviewPath(job,{kind:'chapter_table',chapterId:null})).toBe('/studio/TEST-novel/plan');
  expect(jobReviewPath(job)).toBe('/studio/TEST-novel/plan');
  expect(jobReviewPath(job,{kind:'scene_plan',chapterId:'TEST chapter/?'})).toBe('/studio/TEST-novel/chapters?chapter=TEST%20chapter%2F%3F');
  expect(jobReviewPath({...job,type:'extract_style'})).toBe('/studio/TEST-novel/storyline');
});

it('TEST independent outline findings show evidence and block adoption without treating preferences as factual errors',async()=>{
  const { simulatedOutlineReview } = await import('../helpers/outlineReview');
  const p=proposal(), report=simulatedOutlineReview();
  report.findings=[{dimension:'causality',kind:'contradiction',priority:'critical',location:'TEST setting',problem:'TEST future evidence survived reset',evidence:[{location:'TEST setting',excerpt:'TEST evidence'}],impact:'TEST ending invalid',suggestion:'TEST reacquire evidence'}];
  p.meta.outlineReviewRequired=true;p.meta.outlineReview={state:'complete',signature:'TEST',error:null,report,reviewedAt:0};
  const html=renderToStaticMarkup(createElement(PlanReview,{novel:await novel(),documents:[p]}));
  expect(html).toContain(t.outlineReview.title);expect(html).toContain(t.outlineReview.contradiction);expect(html).toContain('TEST reacquire evidence');expect(html).toContain('TEST evidence');expect(html).toContain('disabled');
  p.meta.outlineReviewOnly=true;
  const inspection=renderToStaticMarkup(createElement(PlanReview,{novel:await novel(),documents:[p]}));
  expect(inspection).not.toContain(t.studio.workflow.acceptOutline);expect(inspection).toContain(t.outlineReview.closeReport);
});
