import { describe, expect, it } from 'vitest';
import { emptyStyleProfile } from '@the-water/shared';
import { lintIssuesToInstructions, lintText } from '@/novel/lint';

const clean = `刀出。人退。灯灭了。\n\n他没有答话，把刀鞘往桌上一搁。风从檐角过，带着铁锈味。\n\n“你来了。”\n\n“来了。”`;

describe('lintText', () => {
  it('finds hard AI-tell words and soft words over limit', () => {
    const r = lintText('这就是底层逻辑。我们要赋能每一个人。仿佛仿佛仿佛仿佛仿佛。', { minCharsForStructure: 100000 });
    const rules = r.issues.map((i) => i.rule);
    expect(rules).toContain('ai-word-hard');
    expect(r.issues.find((i) => i.message.includes('底层逻辑'))).toBeTruthy();
    expect(rules).toContain('ai-word-soft');
    expect(r.aiTellScore).toBeLessThan(60);
  });
  it('matches lexicon patterns like 不是…而是… and 眼底闪过一丝', () => {
    const r = lintText('他不是害怕，而是愤怒。她眼底闪过一丝笑意。');
    expect(r.issues.some((i) => i.rule === 'ai-pattern:not-but')).toBe(true);
    expect(r.issues.some((i) => i.rule === 'ai-pattern:eyes-cliche')).toBe(true);
  });
  it('clean prose has no AI tells', () => {
    const r = lintText(clean);
    expect(r.issues.filter((i) => i.rule.startsWith('ai-'))).toHaveLength(0);
    expect(r.aiTellScore).toBe(100);
  });
  it('applies profile negatives (hard words block, wildcard patterns warn)', () => {
    const profile = emptyStyleProfile({ negatives: { avoidWords: ['尴尬'], avoidWordsSoft: { limitPerK: 1, list: [] }, avoidPatterns: ['心中涌起一股…'], antiExemplars: [], oocRedlines: [] } });
    const r = lintText('场面一度尴尬。他心中涌起一股暖流。', { profile });
    expect(r.issues.find((i) => i.rule === 'profile-avoid-word')?.severity).toBe('block');
    expect(r.issues.some((i) => i.rule === 'profile-avoid-pattern' && i.quote.includes('心中涌起一股'))).toBe(true);
  });
  it('flags uniform structure on long texts', () => {
    const para = '他走到窗边，看着外面的雨，想起了很多年前的事情，那时候一切都还没有开始。';
    const text = Array.from({ length: 20 }, () => para).join('\n\n');
    const r = lintText(text);
    expect(r.issues.some((i) => i.rule === 'low-burstiness')).toBe(true);
    expect(r.issues.some((i) => i.rule === 'uniform-paragraphs')).toBe(true);
  });
  it('flags hollow endings', () => {
    const body = Array.from({ length: 60 }, (_, i) => `第${i}句话很长很长，说了一些事情。`).join('');
    const r = lintText(body + '\n\n总之，真正重要的是我们都在路上。');
    expect(r.issues.some((i) => i.rule === 'hollow-ending')).toBe(true);
  });
  it('turns issues into deduplicated instructions, block first', () => {
    const r = lintText('这就是底层逻辑。这就是底层逻辑。他不是害怕，而是愤怒。', { minCharsForStructure: 100000 });
    const ins = lintIssuesToInstructions(r, 3);
    expect(ins.length).toBeLessThanOrEqual(3);
    expect(ins[0]).toContain('底层逻辑');
    expect(new Set(ins).size).toBe(ins.length);
  });
});
