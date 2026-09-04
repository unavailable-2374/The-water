import type { StorylineDoc } from '@the-water/shared';

export interface ModerationInput {
  novel: { id: string; title: string; summary: string; tags: string[] };
  storyline: StorylineDoc;
  chapters: Array<{ index: number; title: string; content: string }>;
}

export type ModerationResult = { ok: true } | { ok: false; reason: string };

/** 提交版本时调用的内容审核钩子；失败则版本可见性置为 hidden（“审核中”）。 */
export interface ContentModerator {
  check(input: ModerationInput): Promise<ModerationResult>;
}

export const noopModerator: ContentModerator = {
  async check() {
    return { ok: true };
  },
};
