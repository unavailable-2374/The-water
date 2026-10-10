import type { Job, JobStep } from '@/db/repos/jobsRepo';

export type JobEvent =
  | { type: 'plan:resolved'; novelId: string }
  | { type: 'plan:proposed'; novelId: string }
  | { type: 'job:updated'; job: Job }
  | { type: 'step:updated'; step: JobStep }
  | { type: 'step:delta'; jobId: string; stepId: string; text: string }
  | { type: 'chapter:versionCreated'; novelId: string; chapterId: string; versionId: string }
  | { type: 'novel:bibleUpdated'; novelId: string; afterChapterNo: number }
  | { type: 'novel:storylineUpdated'; novelId: string }
  | { type: 'chapter:reviewed'; novelId: string; chapterId: string; reviewId: string };

type Listener = (e: JobEvent) => void;
const listeners = new Set<Listener>();

export function onJobEvent(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function emitJobEvent(e: JobEvent): void {
  for (const l of listeners) {
    try {
      l(e);
    } catch (err) {
      console.error('job event listener failed', err);
    }
  }
}
