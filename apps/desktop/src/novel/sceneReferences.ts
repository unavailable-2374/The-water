import type { ScenePlan } from '@the-water/shared';

export interface SceneReferences {
  characterIds: Set<string>;
  volumes: Map<string, { startChapterNo: number; endChapterNo: number }>;
  threadIds: Set<string>;
  factIds: Set<string>;
}

/** Plans/settings are future constraints; only canon events are factual dependencies. */
export function sceneReferenceIssues(scene: ScenePlan, refs: SceneReferences, chapterNo: number) {
  const issues: { field: keyof ScenePlan; message: string }[] = [];
  if (scene.povCharacterId && !refs.characterIds.has(scene.povCharacterId))
    issues.push({ field: 'povCharacterId', message: '视角人物必须使用本书人物 ID，未知填 null' });
  if (scene.characterIds.some(id => !refs.characterIds.has(id)))
    issues.push({ field: 'characterIds', message: '人物必须使用本书人物 ID' });
  if (scene.volumeId) {
    const volume = refs.volumes.get(scene.volumeId);
    if (!volume || chapterNo < volume.startChapterNo || chapterNo > volume.endChapterNo)
      issues.push({ field: 'volumeId', message: '分卷必须已确认且包含当前章节，未知填 null' });
  }
  if (scene.threadIds.some(id => !refs.threadIds.has(id)))
    issues.push({ field: 'threadIds', message: '伏笔必须使用已确认伏笔卡 ID，没有则填 []' });
  if (scene.dependencyIds.some(id => !refs.factIds.has(id)))
    issues.push({ field: 'dependencyIds', message: 'dependencyIds 只能引用当前章之前正文已证实的 canonEvents 事实 ID，不能使用设定、人物、故事弧或计划 ID；没有事实时必须填 []' });
  return issues;
}
