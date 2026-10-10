import { assistantParameters, type AssistantOperationName } from '@the-water/shared';
/** One catalogue drives the model contract and the capability checklist. */
export const descriptions: Record<AssistantOperationName, string> = {
  story_options: 'Explore four story directions for a real work/arc/chapter/scene ID. Generate, retain, redraw, combine author-selected cards into a newly reviewed candidate, or resume using the shared story-options service. Exploration is independent: authorMaterials and feedback may only restate material explicitly provided by the author for this request, never derive details from existing plans, prose, cards or adopted directions. Return cards and wait for the author to choose in the card UI. NEVER choose a direction yourself or automatically adopt its plan, even during whole-work tasks.',
  inspect:
    'Read real work data. Read chapter/versions before editing; use IDs, clarify ambiguous names.',
  create_work: 'Create a work with author requirements in the global conversation.',
  edit_work: 'Edit work title, premise, length reference or author requirements.',
  import_manuscript: 'Use a native file picker to import a UTF-8 manuscript as a new work.',
  export_work: 'Export the work using the native destination dialog.',
  character: 'Create or edit a complete character, including voice, relationships and growth.',
  setting: 'Create or edit a world setting.',
  arc: 'Create or edit a story arc.',
  beat: 'Create or edit an outline beat.',
  remove_entity: 'Remove an explicitly selected story entity, respecting references and locks.',
  style: 'Set or clear the writing style profile.',
  card: 'Create/edit/confirm a brief, volume, scene, thread or character-intent card.',
  chapter_plan: 'Create or edit a chapter plan.',
  graph:
    'Edit timeline, causal relations, growth, secrets, anchors, preferences and locks. Preserve unrelated fields; unlock only when explicitly requested.',
  reorder_chapters: 'Reorder the complete chapter ID list.',
  split_chapter: 'Split a chapter at a saved UTF-16 text offset.',
  merge_chapters:
    'Stage the merge of adjacent chapters; review and commit before archiving the second.',
  cancel_merge: 'Cancel a pending chapter merge.',
  reorder_cards: 'Reorder supplied cards.',
  split_scene: 'Split a scene into two unconfirmed scene cards.',
  merge_scenes: 'Merge two scenes from the same chapter.',
  edit_text:
    'Apply a specific replacement or insertion to saved prose. Use inspect chapter first and echo its version ID and content hash as baseVersionId/baseHash (both null for an empty chapter). Follow selected range when present; drafts require independent review before canon.',
  restore_version: 'Restore a historical version as a new working draft.',
  candidate: 'Explicitly accept/discard an existing plan/text candidate identified by ID.',
  plan: 'Generate and adopt a new outline/chapter plan within this request.',
  write: 'Write requested unwritten chapters, then independently review, extract facts and commit.',
  rewrite:
    'Rewrite the specified chapters with instructions, independently review, extract facts and commit.',
  review:
    'Independently review, repair if needed, extract facts and commit specified current chapters. Never dismiss review issues.',
  extract_style: 'Extract a style profile from existing prose.',
  finish_work:
    'Persist a whole-work goal and constraints; plan, write, review and commit continuously. Use only for explicit whole-work instructions.',
  rewrite_candidate:
    'Explicitly adopt or discard an existing chapter rewrite by chapter ID; adoption still requires current independent review and extraction.',
  repair_memory:
    'Insert prerequisite reviews and fact rebuilding into a blocked task without skipping quality gates.',
  derivative: 'Edit the work derivative declaration and fidelity requirements.',
  author_note: 'Edit the author’s additional writing instructions for this work.',
  branch_edit: 'Edit the saved plan, graph and sample of a draft plot experiment.',
  read_prose:
    'Extract actual scenes and evidence-backed reading diagnostics from saved prose, preserving a reviewable candidate.',
  reading_candidate:
    'Explicitly accept a reading candidate to update scene plans, or discard it. Historical candidates need explicit author adoption.',
  suggest_voice:
    'Suggest narrator/dialogue preferences from author-selected samples; this operation only returns suggestions.',
  restore_story_change:
    'Undo the latest existing story-workspace change, with its original dependency checks.',
  task: 'Pause/resume/cancel a background job or assistant run in this work, using its real ID. Resume a blocked original task after resolving its clarification. Never skip required reviews.',
  undo: 'Undo a single operation or a whole turn in reverse order, checking conflicts.',
  branch_create: 'Create an isolated scene experiment.',
  branch_sample: 'Generate a sample in an existing experiment.',
  branch_merge: 'Merge an experiment, respecting its baseline and dependencies.',
};
export const catalog = Object.keys(assistantParameters).map((name) => ({
  name,
  scope: ['create_work', 'import_manuscript'].includes(name)
    ? 'global'
    : name === 'inspect'
      ? 'global/work'
      : 'work',
  description: descriptions[name as AssistantOperationName],
  undo: !['inspect', 'suggest_voice', 'export_work', 'task', 'undo'].includes(name),
}));
