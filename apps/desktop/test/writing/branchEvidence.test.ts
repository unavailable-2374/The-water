/** TEST / SIMULATED model output; no literary quality claim. */
import { expect, it } from 'vitest';
import { BranchSampleSchema } from '@/novel/storyBranches';
import { zodToJsonSchema } from '@/llm/json';
import { locateModelEvidence } from '@/llm/prompts/evidence';
import { useTestDb } from '../helpers/testDb';
import { createNovel } from '@/db/repos/novelsRepo';
import { upsertChapterPlan, createVersion, getChapter } from '@/db/repos/chaptersRepo';
import { testScene } from '../helpers/writing';
import { defaultRequirements } from '@/novel/types';
import { createStoryBranch, saveStoryBranch, reviewBranchFixedFacts, branchConflicts, mergeStoryBranch } from '@/novel/storyBranches';

const sample = 'TEST 林舟留下信件。他核对邮戳。';
const result = (quote: string, from = 0, to = quote.length) => ({
  sample,
  facts: [{ text: 'TEST 核对邮戳', evidence: { from, to, quote } }],
});
it('rejects invented evidence before a branch response can be saved', () => {
  const parsed = BranchSampleSchema.safeParse(result('TEST 他打开信件。'));
  expect(parsed.success).toBe(false);
  if (!parsed.success) expect(parsed.error.issues[0]!.path).toEqual(['facts', 0, 'evidence']);
});
it('accepts uniquely located verbatim evidence despite model offset errors', () => {
  const value = BranchSampleSchema.parse(result('他核对邮戳。'));
  const evidence = locateModelEvidence(value.sample, value.facts[0]!.evidence);
  expect(value.sample.slice(evidence.from, evidence.to)).toBe('他核对邮戳。');
});
it('rejects ambiguous quotes and keeps the provider JSON schema serializable', () => {
  expect(BranchSampleSchema.safeParse({ ...result('他核对邮戳。'), sample: sample + '他核对邮戳。' }).success).toBe(false);
  expect(zodToJsonSchema(BranchSampleSchema)).toMatchObject({ type: 'object', required: ['sample', 'facts'] });
});
it('TEST exploration requires plan-and-sample review and invalidates it after either changes', async () => {
  const db=useTestDb();
  const novel=await createNovel({title:'TEST / SIMULATED branch review',premise:'TEST',requirements:defaultRequirements(),targetChars:1000});
  const chapter=await upsertChapterPlan(novel.id,{chapterNo:1});
  const version=await createVersion({chapterId:chapter.id,content:'TEST 原文保留。',source:'user_edit'});
  const sceneId=await testScene(novel.id,chapter.id);
  let branch=await createStoryBranch(novel.id,sceneId,'TEST branch');
  branch=await saveStoryBranch(novel.id,branch,{name:branch.name,plan:branch.plan,graph:branch.graph,sample:'TEST 新样稿。',exploration:{goal:'narration',fixedFacts:'TEST 仅有限合作，不原谅',reviewedHash:null}});
  expect(await branchConflicts(novel.id,branch)).toContain('exploration_review');
  await expect(mergeStoryBranch(novel.id,branch)).rejects.toThrow('exploration_review');
  branch=await reviewBranchFixedFacts(novel.id,branch);
  expect(branch.exploration?.reviewedHash).toBeTruthy();
  expect(await branchConflicts(novel.id,branch)).not.toContain('exploration_review');
  branch=await saveStoryBranch(novel.id,branch,{name:branch.name,plan:{...branch.plan,turn:'TEST 改变计划'},graph:branch.graph,sample:branch.sample});
  expect(branch.exploration?.reviewedHash).toBeNull();
  branch=await reviewBranchFixedFacts(novel.id,branch);
  branch=await saveStoryBranch(novel.id,branch,{name:branch.name,plan:branch.plan,graph:branch.graph,sample:'TEST 又一次改变样稿。'});
  expect(branch.exploration?.reviewedHash).toBeNull();
  expect((await getChapter(chapter.id))!.currentVersionId).toBe(version.id);
  expect((await getChapter(chapter.id))!.committedVersionId).toBeNull();
  db.raw.close();
});
