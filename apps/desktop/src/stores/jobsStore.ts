import { create } from 'zustand';
import { isBlockingJob, listJobs, listSteps, type Job, type JobStep } from '@/db/repos/jobsRepo';
import { onJobEvent } from '@/jobs/events';

interface JobsState {
  jobs: Record<string, Job>;
  steps: Record<string, JobStep[]>;
  live: Record<string, { stepId: string; text: string }>;
  /** bumps when chapter versions / bible / storyline change; UI reloads by novelId */
  novelTick: Record<string, number>;
  loadAll: () => Promise<void>;
  loadSteps: (jobId: string) => Promise<void>;
}

export const useJobs = create<JobsState>((set, get) => ({
  jobs: {}, steps: {}, live: {}, novelTick: {},
  loadAll: async () => {
    const list = await listJobs();
    set({ jobs: Object.fromEntries(list.map((j) => [j.id, j])) });
  },
  loadSteps: async (jobId) => set({ steps: { ...get().steps, [jobId]: await listSteps(jobId) } }),
}));

export const activeJobsForNovel = (jobs: Record<string, Job>, novelId: string) =>
  Object.values(jobs).filter((j) => j.novelId === novelId && !['completed', 'cancelled'].includes(j.status)).sort((a, b) => b.createdAt - a.createdAt);

/**
 * 挡住「再起一个任务」的那一个（判定与 service 的 ensureNoActiveJob 同源）。
 * 界面拿它来禁用按钮；`activeJobsForNovel` 那个更宽的集合只用于展示流式文本。
 */
export const blockingJobForNovel = (jobs: Record<string, Job>, novelId: string): Job | null =>
  Object.values(jobs)
    .filter((j) => j.novelId === novelId && isBlockingJob(j.status))
    .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;

let wired = false;
export function wireJobsStore(): void {
  if (wired) return;
  wired = true;
  onJobEvent((e) => {
    const s = useJobs.getState();
    switch (e.type) {
      case 'job:updated':
        useJobs.setState({ jobs: { ...s.jobs, [e.job.id]: e.job } });
        break;
      case 'step:updated': {
        const cur = s.steps[e.step.jobId];
        if (cur) useJobs.setState({ steps: { ...s.steps, [e.step.jobId]: cur.map((x) => (x.id === e.step.id ? e.step : x)) } });
        break;
      }
      case 'step:delta':
        useJobs.setState({ live: { ...s.live, [e.jobId]: { stepId: e.stepId, text: e.text } } });
        break;
      case 'chapter:versionCreated':
      case 'chapter:reviewed':
      case 'novel:bibleUpdated':
      case 'novel:storylineUpdated':
      case 'plan:resolved':
      case 'plan:proposed':
        useJobs.setState({ novelTick: { ...s.novelTick, [e.novelId]: (s.novelTick[e.novelId] ?? 0) + 1 } });
        break;
    }
  });
}
