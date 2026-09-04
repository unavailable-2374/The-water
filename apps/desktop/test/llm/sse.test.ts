import { describe, expect, it } from 'vitest';
import { parseSSE } from '@/llm/sse';
import { chunkedStream } from './helpers';

async function all(chunks: Array<string | Uint8Array>) {
  const out: Array<{ event: string | null; data: string }> = [];
  for await (const m of parseSSE(chunkedStream(chunks))) out.push(m);
  return out;
}

describe('parseSSE', () => {
  it('parses simple events and dispatches on blank line', async () => {
    const out = await all(['data: hello\n\ndata: world\n\n']);
    expect(out).toEqual([
      { event: null, data: 'hello' },
      { event: null, data: 'world' },
    ]);
  });

  it('handles chunk boundaries mid-line', async () => {
    const out = await all(['data: hel', 'lo\n', '\nda', 'ta: wor', 'ld\n\n']);
    expect(out.map((m) => m.data)).toEqual(['hello', 'world']);
  });

  it('handles chunk boundaries mid multibyte character', async () => {
    const bytes = new TextEncoder().encode('data: 你好世界\n\n');
    // '你' starts at byte 6 and is 3 bytes long; split in the middle of it.
    const a = bytes.slice(0, 7);
    const b = bytes.slice(7, 12);
    const c = bytes.slice(12);
    const out = await all([a, b, c]);
    expect(out).toEqual([{ event: null, data: '你好世界' }]);
  });

  it('accepts CRLF line endings', async () => {
    const out = await all(['event: ping\r\ndata: a\r\n\r\ndata: b\r\n\r\n']);
    expect(out).toEqual([
      { event: 'ping', data: 'a' },
      { event: null, data: 'b' },
    ]);
  });

  it('joins multi-line data with \\n and carries event name', async () => {
    const out = await all(['event: msg\ndata: line1\ndata: line2\ndata:\n\n']);
    expect(out).toEqual([{ event: 'msg', data: 'line1\nline2\n' }]);
  });

  it('ignores comment lines and unknown fields', async () => {
    const out = await all([': keep-alive\nid: 7\nretry: 100\ndata: x\n\n: another\n\n']);
    expect(out).toEqual([{ event: null, data: 'x' }]);
  });

  it('does not dispatch an event with no data lines', async () => {
    const out = await all(['event: only\n\ndata: y\n\n']);
    expect(out).toEqual([{ event: null, data: 'y' }]);
  });

  it('flushes the trailing event without terminating blank line', async () => {
    const out = await all(['data: {"a":1}\n\ndata: [DONE]']);
    expect(out.map((m) => m.data)).toEqual(['{"a":1}', '[DONE]']);
  });

  it('strips exactly one leading space after the colon', async () => {
    const out = await all(['data:  two\n\ndata:none\n\n']);
    expect(out.map((m) => m.data)).toEqual([' two', 'none']);
  });
});
