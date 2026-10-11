// TEST fictional prose; deterministic evidence-contract checks, not real model results.
import { expect, it } from 'vitest';
import { anchorEvidence } from '../src/writing';

it('TEST ambiguous quotes report distinct surrounding source bytes without choosing an occurrence', () => {
  const text='TEST “三千二不够。”她说。\n\n“我知道。”\n\n“押金至少六千。”\n\n“我知道。”他回答。';
  let message='';
  try { anchorEvidence(text,{from:-1,to:-1,quote:'“我知道。”'}); } catch(error) { message=String(error); }
  expect(message).toContain('重复出现');
  expect(message).toContain('三千二不够');
  expect(message).toContain('押金至少六千');
  expect(message).toContain('\\n\\n');
  const quote='“三千二不够。”她说。\n\n“我知道。”';
  expect(anchorEvidence(text,{from:-1,to:-1,quote})).toEqual({from:5,to:5+quote.length,quote});
});
it('TEST omitted newlines and invented closing punctuation remain invalid with useful raw context', () => {
  const text='TEST “妈妈想留下店。你却想走。”\n\n他停了下来。';
  expect(()=>anchorEvidence(text,{from:-1,to:-1,quote:'“妈妈想留下店。”'})).toThrow('你却想走');
  expect(()=>anchorEvidence(text,{from:-1,to:-1,quote:'“妈妈想留下店。你却想走。”他停了下来。'})).toThrow('\\n\\n');
});
it('TEST exact UTF-16 ranges can disambiguate legacy repeated quotes and never change the source', () => {
  const text='TEST 😀重复。重复。';
  expect(anchorEvidence(text,{from:10,to:12,quote:'重复'})).toEqual({from:10,to:12,quote:'重复'});
  expect(text).toBe('TEST 😀重复。重复。');
});
it('TEST empty or invented quotations are rejected', () => {
  expect(()=>anchorEvidence('TEST actual',{from:-1,to:-1,quote:''})).toThrow('引文为空');
  expect(()=>anchorEvidence('TEST actual',{from:-1,to:-1,quote:'虚构证据'})).toThrow('未逐字匹配');
});
