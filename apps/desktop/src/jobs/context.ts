import type { LLMProvider, Usage } from '@/llm/types';
import type { RateGate } from '@/llm/retry';
import type { Job, JobStep } from '@/db/repos/jobsRepo';
import type { StepPurpose } from './purposes';

/** Everything a step needs at runtime. */
export interface StepContext {
  job: Job;
  step: JobStep;
  /** 本步骤用途对应的模型（见 jobs/purposes.ts）。 */
  provider: LLMProvider;
  /** 本步骤的用途。 */
  purpose: StepPurpose;
  /** 任务池的限流闸门；聊天不与它共用队列。 */
  gate: RateGate;
  signal: AbortSignal;
  /** 换用另一种用途的模型（style_check 的定点修订要用写作模型）。 */
  providerFor: (purpose: StepPurpose) => Promise<LLMProvider>;
  /** 记一条用量；不传 purpose / provider 时用本步骤的。 */
  recordUsage: (usage: Usage, opts?: { purpose?: StepPurpose; provider?: LLMProvider }) => Promise<void>;
  /**
   * 取出「上次中断时已写好的正文」作为续写种子，只取一次（取完即清空），
   * 免得一个步骤里的第二次调用又把种子接一遍。没有种子时返回 null。
   */
  takeResumeSeed: () => string | null;
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
