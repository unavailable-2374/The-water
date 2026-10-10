import { z } from 'zod';
import { StoryThreadSchema, type StoryThread, type WritingCardData } from '@the-water/shared';
export const PlannedThreadSchema = z.object({
  title: z.string().trim().min(1).max(200),
  setup: z.string().trim().min(1).max(2000),
  progression: z.string().trim().min(1).max(2000),
  payoff: z.string().trim().min(1).max(2000),
  plannedChapterNo: z.number().int().min(1).max(500),
  characterNames: z.array(z.string().trim().min(1).max(80)).max(30),
  milestones: StoryThreadSchema.shape.milestones.unwrap().min(2),
}).superRefine((thread, ctx) => {
  const parsed = StoryThreadSchema.safeParse({ ...thread, characterIds: [] });
  if (!parsed.success) for (const issue of parsed.error.issues) ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message });
});
export type PlannedThread = z.infer<typeof PlannedThreadSchema>;
export function plannedThreadCards(threads: readonly PlannedThread[], characters: readonly { id: string; name: string; aliases: string[] }[]): WritingCardData[] {
  return threads.map(thread => {
    const { characterNames, ...data } = thread;
    const characterIds = characterNames.map(name => {
      const character = characters.find(c => c.name === name || c.aliases.includes(name));
      if (!character) throw new Error(`伏笔引用不存在的人物：${name}`);
      return character.id;
    });
    return { kind: 'thread', data: StoryThreadSchema.parse({ ...data, characterIds }) };
  });
}
/** Include a scheduled thread from setup through payoff, even before scene IDs exist. */
export function threadRelevantAt(thread: StoryThread, chapterNo: number): boolean {
  const steps = thread.milestones;
  return !!steps?.length && steps[0]!.chapterNo <= chapterNo && steps.at(-1)!.chapterNo >= chapterNo;
}
