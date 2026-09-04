import { describe, expect, it } from 'vitest';
import { targetsFromMetrics } from '@the-water/shared';
import { compareMetrics, computeStyleMetrics, dialogueChars, guessSceneType, ngramSignature, splitParagraphs, splitSentences } from '@/novel/styleMetrics';

const terse = `刀出。人退。灯灭了。\n\n他没有答话，把刀鞘往桌上一搁。风从檐角过，带着铁锈味。\n\n“你来了。”\n\n“来了。”\n\n“喝酒？”\n\n“不喝。”\n\n他想起十年前那个雪夜，师父也是这样背对着他站在门口，什么都没说。`;
const flowery = `他的心中涌起一股难以言喻的悲伤，仿佛整个世界都在这一刻崩塌了，而他却无能为力地站在那里，看着一切慢慢消逝！他的心中涌起一股难以言喻的悲伤，仿佛整个世界都在这一刻崩塌了，而他却无能为力地站在那里，看着一切慢慢消逝！他的心中涌起一股难以言喻的悲伤，仿佛整个世界都在这一刻崩塌了，而他却无能为力地站在那里，看着一切慢慢消逝！`;

describe('splitting', () => {
  it('splits sentences on Chinese terminators and strips quotes', () => {
    expect(splitSentences('刀出。人退。灯灭了。')).toEqual(['刀出', '人退', '灯灭了']);
    expect(splitSentences('“你来了。”“来了。”')).toEqual(['你来了', '来了']);
  });
  it('splits paragraphs on newlines', () => {
    expect(splitParagraphs(terse)).toHaveLength(7);
  });
  it('counts dialogue chars inside quotes', () => {
    expect(dialogueChars('“你来了。”他说。')).toBe(4);
  });
});

describe('computeStyleMetrics', () => {
  it('measures sentence length, burstiness, dialogue ratio and punctuation per K', () => {
    const m = computeStyleMetrics([terse]);
    expect(m.sampledChars).toBeGreaterThan(50);
    expect(m.sentenceLength.mean).toBeLessThan(15);
    expect(m.burstiness).toBeGreaterThan(0.5);
    expect(m.dialogueRatio).toBeGreaterThan(0.05);
    expect(m.punctuationPerK['。']).toBeGreaterThan(0);
    expect(m.paragraphLength.singleSentenceRatio).toBeGreaterThan(0.5);
  });
  it('flowery repeated text has low burstiness and long sentences', () => {
    const m = computeStyleMetrics([flowery]);
    expect(m.sentenceLength.mean).toBeGreaterThan(40);
    expect(m.burstiness).toBeLessThan(0.3);
    expect(m.punctuationPerK['！']).toBeGreaterThan(5);
  });
  it('ngram signature surfaces repeated phrases and skips function-word grams', () => {
    const sig = ngramSignature(flowery.repeat(2));
    expect(sig.length).toBeGreaterThan(0);
    expect(sig.some((g) => g.includes('的'))).toBe(false);
  });
});

describe('targets & compare', () => {
  it('derives bands from metrics and flags deviations with hints', () => {
    const base = computeStyleMetrics([terse, terse, terse]);
    const targets = targetsFromMetrics(base, 0.85);
    expect(targets.sentenceMean).not.toBeNull();
    const ok = compareMetrics(base, targets);
    expect(ok.score).toBe(100);
    expect(ok.findings).toHaveLength(0);
    const bad = compareMetrics(computeStyleMetrics([flowery]), targets);
    expect(bad.score).toBeLessThan(80);
    expect(bad.hardViolations.map((f) => f.key)).toContain('sentenceMean');
    expect(bad.findings.find((f) => f.key === 'sentenceMean')!.hint).toContain('句子偏长');
    expect(bad.findings.find((f) => f.key === 'exclamationPerK')!.hint).toContain('感叹号');
  });
  it('lower fidelity widens the band', () => {
    const m = computeStyleMetrics([terse]);
    const tight = targetsFromMetrics(m, 0.95).sentenceMean!;
    const loose = targetsFromMetrics(m, 0.6).sentenceMean!;
    expect(loose[1] - loose[0]).toBeGreaterThan(tight[1] - tight[0]);
  });
  it('empty targets → score 100', () => {
    expect(compareMetrics(computeStyleMetrics([flowery]), { sentenceMean: null, burstiness: null, paragraphMean: null, dialogueRatio: null, exclamationPerK: null, ellipsisPerK: null, hard: [] }).score).toBe(100);
  });
});

describe('guessSceneType', () => {
  it('detects dialogue-heavy and action-heavy text', () => {
    expect(guessSceneType('“你来了。”“来了。”“喝酒？”“不喝。”“为什么？”“不想。”')).toBe('dialogue');
    expect(guessSceneType('刀光一闪，他劈砍过去，血溅三尺，拳掌交击，战至天明。')).toBe('fight');
  });
});
