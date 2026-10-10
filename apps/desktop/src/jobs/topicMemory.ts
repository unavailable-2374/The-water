import { canonicalJson, sha256Hex } from '@the-water/shared';
import { getNovel } from '@/db/repos/novelsRepo';
import { buildStorylineDoc } from '@/db/repos/storylineRepo';
import { getChapter } from '@/db/repos/chaptersRepo';
import { docTypeGuide } from '@/novel/docTypes';
import { loadAuthorNote } from '@/llm/prompts/authorNote';
import type { Job, JobStep } from '@/db/repos/jobsRepo';
import type { StepPurpose } from './purposes';
import type { CompletionRequest } from '@/llm/types';

/** History is a private working log. The current prompt remains the source of confirmed facts. */
export async function topicMemoryScope(job:Job,step:JobStep,purpose:StepPurpose):Promise<CompletionRequest['topicTree']> {
  if(!step.chapterId || !['writing','styleReview','consistency'].includes(purpose)) return undefined;
  const novel=await getNovel(job.novelId),chapter=await getChapter(step.chapterId);
  if(!novel || !chapter || !docTypeGuide(novel.requirements.docType).fiction) return undefined;
  const doc=await buildStorylineDoc(novel.id,novel.premise,novel.meta.themes);
  const epoch=await sha256Hex(canonicalJson({requirements:novel.requirements,story:doc,authorNote:await loadAuthorNote(novel.id)}));
  // Job runner writes the adopted manuscript. Experimental branches use separate APIs, never this log.
  return {workId:novel.id,branchId:'adopted',channel:purpose,epoch,chapterNo:chapter.chapterNo};
}
