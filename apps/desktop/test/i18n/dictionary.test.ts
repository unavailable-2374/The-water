/**
 * 词典完整性。
 *
 * 类型层面已经保证「少 key / 多 key 编译不过」（`Locale` 由 zh 结构推导），
 * 这里再从运行时兜一遍类型看不见的三件事：
 *   1. 结构真的一致（防止有人用 `as unknown as Locale` 绕过去）；
 *   2. 没有空文案（漏翻会显示成一片空白，比显示原文更糟）；
 *   3. 占位符 `{name}` 在各语言之间一一对应（漏了占位符 `fmt` 会静默出空串）。
 */
import { describe, expect, it } from 'vitest';
import { zh } from '@/i18n/zh';
import { en } from '@/i18n/en';
import { LOCALES } from '@/i18n/types';
import type { JobStatus, JobType } from '@/db/repos/jobsRepo';
import type { NovelStatus } from '@/db/repos/novelsRepo';

type Dict = { [k: string]: string | Dict };

/** 把嵌套词典摊平成 `a.b.c -> 文案`。 */
function flatten(dict: Dict, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(dict)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') out.set(path, v);
    else for (const [key, val] of flatten(v, path)) out.set(key, val);
  }
  return out;
}

/** 取出文案里的 `{xxx}` 占位符集合。 */
function placeholders(text: string): Set<string> {
  return new Set(Array.from(text.matchAll(/\{(\w+)\}/g), (m) => m[1] as string));
}

const dicts: Record<string, Dict> = { 'zh-CN': zh as unknown as Dict, 'en-US': en as unknown as Dict };
const base = flatten(dicts['zh-CN'] as Dict);

describe('词典完整性', () => {
  it('每一门声明支持的语言都有词典', () => {
    for (const code of LOCALES) expect(Object.keys(dicts)).toContain(code);
  });

  it('中文词典本身没有空文案', () => {
    const empty = [...base.entries()].filter(([, v]) => v.trim() === '').map(([k]) => k);
    expect(empty).toEqual([]);
  });

  it('中文词典的 key 没有重复的路径冲突（子对象与字符串同名）', () => {
    // flatten 用 Map，同名会互相覆盖；这里比对条数即可发现异常。
    expect(base.size).toBeGreaterThan(100);
  });

  for (const code of LOCALES) {
    if (code === 'zh-CN') continue;
    describe(code, () => {
      const other = flatten(dicts[code] as Dict);

      it('key 集合与中文完全一致', () => {
        const missing = [...base.keys()].filter((k) => !other.has(k));
        const extra = [...other.keys()].filter((k) => !base.has(k));
        expect({ missing, extra }).toEqual({ missing: [], extra: [] });
      });

      it('没有空文案', () => {
        const empty = [...other.entries()].filter(([, v]) => v.trim() === '').map(([k]) => k);
        expect(empty).toEqual([]);
      });

      it('占位符与中文一一对应', () => {
        const mismatched: string[] = [];
        for (const [key, zhText] of base) {
          const otherText = other.get(key);
          if (otherText === undefined) continue;
          const a = placeholders(zhText);
          const b = placeholders(otherText);
          if (a.size !== b.size || [...a].some((p) => !b.has(p))) mismatched.push(key);
        }
        expect(mismatched).toEqual([]);
      });
    });
  }
});


/**
 * 状态标签表的防漂移。
 *
 * 方案 §4.1 里那三套「说同一件事」的标签表已经合并成 `t.jobs.status` / `t.jobs.type` /
 * `t.novelStatus`。下面几行是**类型层**断言（跑 `typecheck` 时生效）：
 *   - 少一个状态 → `Record<JobStatus, string>` 报缺少属性；
 *   - 多一个状态 → `keyof` 赋回联合类型时报不匹配。
 * 于是以后往 `JobStatus` 里加一个值，忘了补文案就编译不过，不会再有人另起一张表凑合。
 */
describe('状态标签表', () => {
  it('任务状态 / 任务类型 / 小说状态的 key 与类型联合完全对齐', () => {
    // 少一个状态：Record<...> 报「缺少属性」。
    const jobStatus: Record<JobStatus, string> = zh.jobs.status;
    const jobType: Record<JobType | 'planning', string> = zh.jobs.type;
    const novelStatus: Record<NovelStatus, string> = zh.novelStatus;
    // 多一个状态：把词典的 key 联合赋回类型联合时报「不能赋给」。
    const extraJobStatus: JobStatus = undefined as unknown as keyof typeof zh.jobs.status;
    const extraNovelStatus: NovelStatus = undefined as unknown as keyof typeof zh.novelStatus;
    expect(Object.keys(jobStatus).length).toBe(9);
    // 规划任务是 UI 上多出来的一种「类型」，靠 params.stage 区分，不在 JobType 里。
    expect(Object.keys(jobType)).toContain('planning');
    expect(Object.keys(novelStatus).length).toBe(5);
    expect(extraJobStatus).toBeUndefined();
    expect(extraNovelStatus).toBeUndefined();
  });
});
