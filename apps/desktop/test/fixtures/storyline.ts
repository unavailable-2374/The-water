import { emptyLore, emptyVoice, type StoryBible, type StorylineDoc } from '@the-water/shared';
import type { NovelRequirements } from '@/novel/types';
import type { ProviderCaps } from '@/llm/types';

export const caps: ProviderCaps = { contextWindow: 128_000, maxOutputTokens: 8192, jsonMode: 'json_object', cjkTokenRatio: 0.7 };

export const requirements: NovelRequirements = {
  genre: '悬疑',
  style: '冷峭克制',
  pov: '第三人称有限',
  tense: '过去时',
  tone: '压抑',
  audience: '成年读者',
  taboos: ['血腥描写', '政治隐喻'],
  mustHave: ['雨夜', '旧钟表'],
  language: '简体中文',
  extra: '每章至少一处环境描写',
  docType: 'long-webnovel',
  genrePackIds: [],
  disabledLore: [],
};

export function makeDoc(): StorylineDoc {
  return {
    version: 1,
    premise: '一个钟表匠在雨夜收到一封来自已故妻子的信。',
    themes: ['记忆', '时间'],
    characters: [
      { id: 'c1', name: '沈默', aliases: ['老沈'], role: '主角', description: '钟表匠', arc: '从逃避到面对', relationships: [{ targetId: 'c2', kind: '妻子', note: '已故' }], ...emptyVoice() },
      { id: 'c2', name: '林晚', aliases: [], role: '妻子', description: '已故', arc: '', relationships: [], ...emptyVoice() },
      { id: 'c3', name: '周衍', aliases: ['周警官'], role: '警察', description: '追查旧案', arc: '', relationships: [], ...emptyVoice() },
    ],
    settings: [
      { id: 's1', name: '钟表铺', kind: 'location', description: '老城区的铺子', ...emptyLore() },
      { id: 's2', name: '雨城', kind: 'world', description: '常年阴雨', ...emptyLore() },
      { id: 's3', name: '旧钟表', kind: 'item', description: '停在三点十七分', ...emptyLore() },
    ],
    arcs: [
      { id: 'a1', title: '来信', summary: '收到信并开始追查', startChapterNo: 1, endChapterNo: 2 },
      { id: 'a2', title: '真相', summary: '揭开旧案', startChapterNo: 3, endChapterNo: 4 },
    ],
    beats: [
      { id: 'b1', arcId: 'a1', title: '雨夜来信', summary: '沈默收到信', chapterNo: 1, characterIds: ['c1'], settingIds: ['s1'], order: 0 },
      { id: 'b2', arcId: 'a1', title: '钟停了', summary: '旧钟表停摆', chapterNo: 2, characterIds: ['c1'], settingIds: ['s3'], order: 1 },
      { id: 'b3', arcId: 'a2', title: '警官登门', summary: '周衍来访', chapterNo: 3, characterIds: ['c1', 'c3'], settingIds: ['s1'], order: 2 },
      { id: 'b4', arcId: 'a2', title: '真相', summary: '一切揭开', chapterNo: 4, characterIds: ['c1', 'c2', 'c3'], settingIds: ['s2'], order: 3 },
    ],
    chapters: [
      { chapterNo: 1, title: '信', goal: '建立悬念', beatIds: ['b1'], povCharacterId: 'c1', targetChars: 3000, endHook: '信上是妻子的字迹' },
      { chapterNo: 2, title: '钟', goal: '加深疑惑', beatIds: ['b2'], povCharacterId: 'c1', targetChars: 3000, endHook: '钟停在三点十七分' },
      { chapterNo: 3, title: '客', goal: '引入警察', beatIds: ['b3'], povCharacterId: 'c3', targetChars: 3000, endHook: '警官问起那封信' },
      { chapterNo: 4, title: '真', goal: '揭开真相', beatIds: ['b4'], povCharacterId: 'c1', targetChars: 3000, endHook: '' },
    ],
    styleProfile: null,
    derivative: null,
  };
}

export function makeBible(): StoryBible {
  return {
    characters: {
      c1: { name: '沈默', state: '失眠、疑惑', location: '钟表铺', knowledge: '知道信是妻子字迹', relationships: ['与周衍互不信任'] },
      c3: { name: '周衍', state: '暗中调查', location: '警局', knowledge: '', relationships: [] },
      阿四: { name: '阿四', state: '街头小贩', location: '巷口', knowledge: '', relationships: [] },
    },
    timeline: [
      { chapterNo: 1, event: '沈默在雨夜收到一封信' },
      { chapterNo: 1, event: '老沈发现字迹属于林晚' },
      { chapterNo: 2, event: '旧钟表停摆，阿四来送货' },
    ],
    facts: ['钟表铺位于老城区', '林晚三年前去世'],
    openThreads: ['信是谁寄出的', '钟为什么停在三点十七分'],
    arcSummaries: {},
    styleNotes: '',
  };
}
