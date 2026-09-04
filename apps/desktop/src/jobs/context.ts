import type { LLMProvider } from '@/llm/types';
import type { Job, JobStep } from '@/db/repos/jobsRepo';

/** Everything a step needs at runtime. */
export interface StepContext {
  job: Job;
  step: JobStep;
  provider: LLMProvider;
  signal: AbortSignal;
  /** Streaming text for the live preview (throttled by the runner). */
  onDelta: (accumulated: string) => void;
  /** Human-readable progress message. */
  setMessage: (msg: string) => void;
}

export interface StepOutcome {
  /** Persisted reference (chapter_version id, bible snapshot id, ...). */
  outputRef: string | null;
}

export type StepHandler = (ctx: StepContext) => Promise<StepOutcome>;
