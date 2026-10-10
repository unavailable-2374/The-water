import { getVersion } from '@/db/repos/chaptersRepo';
import { selectOne } from '@/db/db';
import { listSteps } from '@/db/repos/jobsRepo';
import { AwaitingReviewError } from '../awaitingReview';
import { loadChapterEnv } from './common';
import { commitPreparedChapter } from '@/db/repos/writingRepo';
import { emitJobEvent } from '../events';
import type { StepHandler } from '../context';

export const commitChapterStep: StepHandler = async (ctx) => {
  const { chapter } = await loadChapterEnv(ctx);
  const previous = (await listSteps(ctx.job.id))
    .filter(
      (s) =>
        s.chapterId === chapter.id && s.kind === 'summarize' && s.seq < ctx.step.seq && s.status === 'done',
    )
    .at(-1);
  const extraction = previous?.outputRef
    ? await selectOne<{ version_id: string }>('SELECT version_id FROM chapter_extractions WHERE id=?', [
        previous.outputRef,
      ])
    : null;
  if (!extraction) throw new AwaitingReviewError('缺少本任务当前候选的事实提取');
  if (!chapter?.currentVersionId) throw new Error('章节尚无工作稿');
  if(ctx.job.params.assistantRunId) {
    if(chapter.rewriteBaselineVersionId && chapter.rewriteJobId!==ctx.job.id) throw new AwaitingReviewError('历史改写候选不属于本次授权，不能自动采纳');
    const version=await getVersion(extraction.version_id);
    const owned=(await listSteps(ctx.job.id)).some(s=>version?.jobStepId===s.id || version?.jobStepId?.startsWith(`${s.id}#`));
    if(!ctx.step.input.standalone && !owned) throw new AwaitingReviewError('候选正文不属于本次任务，不能自动提交');
  }
  const id = await commitPreparedChapter(chapter.id, extraction.version_id, !!ctx.job.params.assistantRunId, ctx.commit);
  emitJobEvent({ type: 'novel:bibleUpdated', novelId: chapter.novelId, afterChapterNo: chapter.chapterNo });
  return { outputRef: id };
};
