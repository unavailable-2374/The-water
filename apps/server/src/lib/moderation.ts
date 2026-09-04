import { readFileSync } from 'node:fs';
import type { StorylineDoc } from '@the-water/shared';
import type { Env } from '../env';

/** 可审核的文本片段；label 用于告诉作者是哪一处被拦下。 */
export interface ModerationField {
  label: string;
  text: string;
}

export interface ModerationInput {
  novel: { id: string; title: string; summary: string; tags: string[] };
  storyline: StorylineDoc;
  chapters: Array<{ index: number; title: string; content: string }>;
}

export type ModerationResult = { ok: true } | { ok: false; reason: string };

/** 内容审核钩子。作品提交、资料修改、留言、昵称都必须过这一层。 */
export interface ContentModerator {
  /** 提交版本时的整本检查；失败则版本可见性置为 hidden（“审核中”）。 */
  check(input: ModerationInput): Promise<ModerationResult>;
  /** 任意短文本检查（标题 / 摘要 / 标签 / 留言 / 昵称 / 简介 / handle）。 */
  checkText(fields: ModerationField[]): Promise<ModerationResult>;
}

export const noopModerator: ContentModerator = {
  async check() {
    return { ok: true };
  },
  async checkText() {
    return { ok: true };
  },
};

/**
 * 内置违禁词种子表。这是最低限度的兜底，不是完整的合规方案；
 * 生产部署应通过 MODERATION_BLOCKLIST_PATH 追加按当地法规维护的词表。
 */
const SEED_BLOCKLIST = [
  // 违法交易
  '办证刻章', '代开发票', '出售身份证', '枪支弹药', '仿真枪', '管制刀具批发',
  '冰毒', '海洛因', '甲基苯丙胺', '大麻代购', '迷奸药', '听话水',
  // 赌博与诈骗
  '博彩平台', '澳门赌场开户', '网上赌博', '刷单返利', '包上岸', '黑客接单',
  // 色情
  '裸聊', '约炮上门', '成人影片下载', '强奸幼女', '儿童色情',
  // 极端与暴恐
  '制作炸弹', '自制炸药', '恐怖袭击教程',
] as const;

/** 归一化：去掉常见的分隔干扰字符并统一大小写，降低简单绕过。 */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s　._\-*+~·—…、,，。!！?？:：;；'"“”‘’()（）\[\]【】<>《》/\\|]/g, '');
}

function loadExtraTerms(path: string): string[] {
  if (!path) return [];
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
  } catch (e) {
    console.warn(`[moderation] 无法读取词表 ${path}：${String(e)}`);
    return [];
  }
}

/** 单条正文的长度上限；超长内容按段扫描以免一次性拼接过大字符串。 */
const SCAN_CHUNK = 20_000;

export function createRulesModerator(env: Env): ContentModerator {
  const terms = [...SEED_BLOCKLIST, ...loadExtraTerms(env.moderationBlocklistPath)].map(normalize).filter(Boolean);

  const hit = (text: string): string | null => {
    if (!text) return null;
    for (let i = 0; i < text.length; i += SCAN_CHUNK) {
      const norm = normalize(text.slice(i, i + SCAN_CHUNK + 32));
      for (const term of terms) if (norm.includes(term)) return term;
    }
    return null;
  };

  const scan = async (fields: ModerationField[]): Promise<ModerationResult> => {
    for (const f of fields) {
      const term = hit(f.text);
      if (term) return { ok: false, reason: `${f.label}命中违禁词「${term}」` };
    }
    return { ok: true };
  };

  return {
    async checkText(fields) {
      return scan(fields);
    },
    async check(input) {
      const fields: ModerationField[] = [
        { label: '标题', text: input.novel.title },
        { label: '简介', text: input.novel.summary },
        { label: '标签', text: input.novel.tags.join(' ') },
        { label: '故事线', text: JSON.stringify(input.storyline) },
        ...input.chapters.map((c) => ({ label: `第 ${c.index} 章`, text: `${c.title}\n${c.content}` })),
      ];
      return scan(fields);
    },
  };
}

export function createModerator(env: Env): ContentModerator {
  return env.moderationMode === 'off' ? noopModerator : createRulesModerator(env);
}
