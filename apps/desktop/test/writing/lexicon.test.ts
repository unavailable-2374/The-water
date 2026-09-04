import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AI_TELLS_EN, AI_TELLS_ZH } from '@the-water/shared';

const load = (name: string) => {
  const p = fileURLToPath(new URL(`../../../../docs/writing/lexicon/${name}`, import.meta.url));
  const { $comment: _c, ...rest } = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
  void _c;
  return rest;
};

describe('lexicon stays in sync with docs/writing/lexicon', () => {
  it('zh', () => expect(AI_TELLS_ZH).toEqual(load('ai-tells.zh.json')));
  it('en', () => expect(AI_TELLS_EN).toEqual(load('ai-tells.en.json')));
  it('every pattern compiles', () => {
    for (const p of [...AI_TELLS_ZH.patterns, ...AI_TELLS_EN.patterns]) expect(() => new RegExp(p.regex, 'gmu')).not.toThrow();
  });
});
