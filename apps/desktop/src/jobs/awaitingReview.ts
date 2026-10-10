/** A recoverable author decision, never an automatic retry or a skippable failure. */
export class AwaitingReviewError extends Error {
  constructor(message: string, readonly action?: { kind: 'memory'; chapterId: string; chapterNo: number } | {kind:'proposal'|'chapter'|'blocker'}) {
    super(message);
    this.name = 'AwaitingReviewError';
  }
}
