import { scenePlanStep, writeScenesStep } from './sceneSteps';
import { commitChapterStep } from './commitChapterStep';
import type { StepKind } from '@/db/repos/jobsRepo';
import type { StepHandler } from '../context';
import { outlineStep } from './outlineStep';
import { chapterTableStep } from './chapterTableStep';
import { writeChapterStep } from './writeChapterStep';
import { adjustLengthStep } from './adjustLengthStep';
import { summarizeStep } from './summarizeStep';
import { nameReplaceStep, rewriteChapterStep } from './rewriteChapterStep';
import { styleCheckStep } from './styleCheckStep';
import { extractStyleStep } from './extractStyleStep';

export const STEP_HANDLERS: Record<StepKind, StepHandler> = {
  scene_plan: scenePlanStep, write_scenes: writeScenesStep,
  commit_chapter: commitChapterStep,
  outline: outlineStep,
  chapter_table: chapterTableStep,
  write_chapter: writeChapterStep,
  adjust_length: adjustLengthStep,
  summarize: summarizeStep,
  rewrite_chapter: rewriteChapterStep,
  name_replace: nameReplaceStep,
  style_check: styleCheckStep,
  extract_style: extractStyleStep,
};

export const STEP_LABELS: Record<StepKind, string> = {
  commit_chapter: '提交正文与事实', scene_plan: '规划场景', write_scenes: '撰写场景',
  outline: '生成大纲', chapter_table: '生成章节表', write_chapter: '撰写章节', adjust_length: '调整字数', summarize: '总结与圣经', rewrite_chapter: '改写章节', name_replace: '名称替换', style_check: '审校文风与人物', extract_style: '拆书提取文风',
};
