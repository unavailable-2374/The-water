/**
 * 留言正文里的 @用户名：切成「普通文字 / 提及」两种片段，好让渲染层给提及上色。
 * 规则与服务端、shared 的 parseMentions 保持一致（3–20 位小写字母数字下划线）。
 */
export interface TextSegment {
  kind: 'text' | 'mention';
  /** kind='mention' 时是不带 @ 的用户名（原样大小写），其余是原文。 */
  value: string;
}

const MENTION_RE = /(^|[^a-z0-9_@])@([a-z0-9_]{3,20})(?![a-z0-9_])/gi;

export function splitMentions(body: string): TextSegment[] {
  const out: TextSegment[] = [];
  let last = 0;
  for (const m of body.matchAll(MENTION_RE)) {
    const lead = m[1] ?? '';
    const handle = m[2]!;
    const at = m.index! + lead.length;
    if (at > last) out.push({ kind: 'text', value: body.slice(last, at) });
    out.push({ kind: 'mention', value: handle });
    last = at + 1 + handle.length;
  }
  if (last < body.length) out.push({ kind: 'text', value: body.slice(last) });
  return out.filter((s) => s.kind === 'mention' || s.value !== '');
}
