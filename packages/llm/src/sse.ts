/**
 * Minimal Server-Sent Events parser over a byte stream.
 *
 * - Decodes UTF-8 incrementally (multi-byte chars may straddle chunk boundaries).
 * - Lines are split on `\n`; a trailing `\r` is stripped so CRLF works.
 * - Multiple `data:` lines in one event are joined with `\n`.
 * - An event is dispatched on a blank line; comment lines (`:`) are ignored.
 * - A trailing event without a terminating blank line is flushed at end of stream.
 */
export interface SSEMessage {
  event: string | null;
  data: string;
}

export async function* parseSSE(stream: ReadableStream<Uint8Array>): AsyncGenerator<SSEMessage> {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let event: string | null = null;
  let dataLines: string[] = [];

  const flush = (): SSEMessage | null => {
    if (dataLines.length === 0) {
      event = null;
      return null;
    }
    const msg: SSEMessage = { event, data: dataLines.join('\n') };
    event = null;
    dataLines = [];
    return msg;
  };

  const handleLine = (rawLine: string): SSEMessage | null => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line === '') return flush();
    if (line.startsWith(':')) return null;
    const idx = line.indexOf(':');
    let field: string;
    let value: string;
    if (idx === -1) {
      field = line;
      value = '';
    } else {
      field = line.slice(0, idx);
      value = line.slice(idx + 1);
      if (value.startsWith(' ')) value = value.slice(1);
    }
    if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
    // `id` / `retry` are irrelevant for a one-shot completion stream.
    return null;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        const msg = handleLine(line);
        if (msg) yield msg;
      }
    }
    buffer += decoder.decode();
    if (buffer.length > 0) {
      const msg = handleLine(buffer);
      if (msg) yield msg;
    }
    const last = flush();
    if (last) yield last;
  } finally {
    // If the consumer stopped early, release the underlying connection.
    reader.cancel().catch(() => undefined);
  }
}
