import { describe, expect, it } from 'vitest';
import { MIN_RESUME_SEED_CHARS, RESUME_INSTRUCTION, joinResumed, resumePrefix, trimToSentenceEnd, withResumeSeed } from '@/jobs/resume';

const long = (s: string) => s.repeat(Math.ceil((MIN_RESUME_SEED_CHARS + 20) / s.length));

describe('续写种子', () => {
  it('截到最后一个句末，不让模型从半句接上', () => {
    expect(trimToSentenceEnd('他走进门。风从窗缝里挤')).toBe('他走进门。');
    expect(trimToSentenceEnd('“你来了。”他说，然后')).toBe('“你来了。”');
    expect(trimToSentenceEnd('   ')).toBe('');
  });

  it('没有句末标点时原样保留', () => {
    expect(trimToSentenceEnd('一段没有标点的文字')).toBe('一段没有标点的文字');
  });

  it('半成品太短就不续写（提示词开销比省下的还多）', () => {
    const r = withResumeSeed([{ role: 'user', content: 'q' }], '只写了一句。');
    expect(r.prefix).toBe('');
    expect(r.messages).toHaveLength(1);
    expect(resumePrefix(null)).toBe('');
    expect(resumePrefix(undefined)).toBe('');
  });

  it('够长时追加「续写说明 + assistant 前缀」两条消息', () => {
    const partial = long('他推开门，风灌了进来。');
    const r = withResumeSeed([{ role: 'system', content: 's' }, { role: 'user', content: 'u' }], partial);
    expect(r.prefix.length).toBeGreaterThanOrEqual(MIN_RESUME_SEED_CHARS);
    expect(r.messages).toHaveLength(4);
    expect(r.messages[2]).toEqual({ role: 'user', content: RESUME_INSTRUCTION });
    expect(r.messages[3]!.role).toBe('assistant');
    expect(r.messages[3]!.content).toBe(r.prefix);
    // 原消息不被改动
    expect(r.messages[0]).toEqual({ role: 'system', content: 's' });
  });
});

describe('拼接已写部分与续写', () => {
  it('正常情况直接接上', () => {
    expect(joinResumed('他推开门。', '风灌了进来。')).toBe('他推开门。\n风灌了进来。');
  });

  it('模型重复了结尾时去掉重叠', () => {
    const prefix = '他推开门。风从门缝里挤进来，带着雪。';
    expect(joinResumed(prefix, '风从门缝里挤进来，带着雪。他打了个寒噤。')).toBe(prefix + '他打了个寒噤。');
  });

  it('模型没听懂又从头写了一遍时，采用新文本', () => {
    const prefix = '他推开门，风灌了进来，屋里的灯晃了一下。';
    expect(joinResumed(prefix, prefix + '后面还有很多。')).toBe(prefix + '后面还有很多。');
  });

  it('空值两边都能兜住', () => {
    expect(joinResumed('', ' 新内容')).toBe('新内容');
    expect(joinResumed('旧内容', '')).toBe('旧内容');
  });
});
