import { describe, expect, it } from 'vitest';
import { emptyStyleProfile } from '@the-water/shared';
import { promoteIntoProfile, removedPhrases } from '@/novel/learning';

describe('removedPhrases', () => {
  it('returns maximal Han phrases present before but absent after', () => {
    const before = '他嘴角微微勾起，眼底闪过一丝笑意，转身离开。';
    const after = '他笑了一下，转身离开。';
    const removed = removedPhrases(before, after);
    const keys = [...removed.keys()];
    expect(keys.some((k) => k.includes('嘴角微微勾起'))).toBe(true);
    expect(keys.some((k) => k.includes('眼底闪过一丝'))).toBe(true);
    expect(keys).not.toContain('转身离开');
    // no sub-phrase of a kept longer phrase
    expect(keys).not.toContain('嘴角微微');
  });
  it('drops generic two-character grams', () => {
    const removed = removedPhrases('他的书。', '书。');
    expect([...removed.keys()]).not.toContain('他的');
  });
});

describe('promoteIntoProfile', () => {
  it('adds phrases to the soft avoid list idempotently', () => {
    const p = emptyStyleProfile({});
    const a = promoteIntoProfile(p, ['嘴角勾起', ' ']);
    const b = promoteIntoProfile(a, ['嘴角勾起', '眼底闪过']);
    expect(b.negatives.avoidWordsSoft.list).toEqual(['嘴角勾起', '眼底闪过']);
    expect(p.negatives.avoidWordsSoft.list).toEqual([]);
  });
});
