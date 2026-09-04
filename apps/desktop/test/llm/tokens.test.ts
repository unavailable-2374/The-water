import { describe, expect, it } from 'vitest';
import { countCjkChars, estimateMessagesTokens, estimateTokens } from '@/llm/tokens';

describe('tokens', () => {
  it('counts CJK characters incl. fullwidth punctuation', () => {
    expect(countCjkChars('你好，世界！abc')).toBe(6);
    expect(countCjkChars('hello')).toBe(0);
  });

  it('estimates tokens with default 0.7 CJK ratio and 4 chars/token otherwise', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcdefgh')).toBe(2);
    expect(estimateTokens('abcdefghi')).toBe(3); // ceil(9/4)
    expect(estimateTokens('你好世界')).toBe(3); // ceil(4*0.7)
    expect(estimateTokens('你好世界', 1.0)).toBe(4);
    expect(estimateTokens('你好abcd')).toBe(3); // ceil(1.4 + 1)
  });

  it('adds per-message overhead', () => {
    const msgs = [
      { role: 'system' as const, content: 'abcd' },
      { role: 'user' as const, content: '你好' },
    ];
    expect(estimateMessagesTokens(msgs)).toBe(1 + 4 + 2 + 4);
    expect(estimateMessagesTokens(msgs, 1.0)).toBe(1 + 4 + 2 + 4);
    expect(estimateMessagesTokens([])).toBe(0);
  });
});
