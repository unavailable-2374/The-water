import { hueFromSeed } from '@the-water/shared';

/** XML 文本转义。SVG 由字符串拼接而成，标题与作者名必须先过这里。 */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function clip(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length <= max ? chars.join('') : `${chars.slice(0, max).join('')}…`;
}

/**
 * 分享卡片图（1200×630）。纯 SVG，无外部资源、无脚本。
 * 注意：微信/Twitter 的抓取器不渲染 SVG 版 og:image，这张图主要供站内 <img> 与预览使用。
 */
export function novelCoverSvg(opts: { title: string; authorName: string; summary: string; stats: string }): string {
  const hue = hueFromSeed(opts.title);
  const h2 = (hue + 20) % 360;
  const summaryLines = wrap(opts.summary, 26, 3);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" font-family="'Songti SC','Noto Serif CJK SC',serif">
<defs><linearGradient id="cover" x1="0" y1="0" x2="1" y2="1">
<stop offset="0%" stop-color="hsl(${hue} 32% 78%)"/><stop offset="60%" stop-color="hsl(${hue} 30% 62%)"/><stop offset="100%" stop-color="hsl(${h2} 28% 48%)"/>
</linearGradient></defs>
<rect width="1200" height="630" fill="#faf7f0"/>
<rect x="90" y="135" width="260" height="360" rx="10" fill="url(#cover)"/>
<rect x="90" y="135" width="8" height="360" fill="rgba(0,0,0,0.15)"/>
${Array.from(opts.title).slice(0, 9).map((ch, i) => `<text x="292" y="${186 + i * 38}" font-size="34" font-weight="600" fill="rgba(255,252,247,0.96)">${esc(ch)}</text>`).join('')}
<text x="410" y="190" font-size="52" font-weight="600" fill="#2a2622">${esc(clip(opts.title, 16))}</text>
<text x="410" y="240" font-size="24" fill="#655e55" font-family="'PingFang SC',sans-serif">${esc(clip(opts.authorName, 24))}</text>
${summaryLines.map((line, i) => `<text x="410" y="${300 + i * 40}" font-size="24" fill="#4a443d">${esc(line)}</text>`).join('')}
<text x="410" y="470" font-size="20" fill="#7d756b">${esc(opts.stats)}</text>
<text x="410" y="540" font-size="18" fill="#9c948a" font-family="'PingFang SC',sans-serif">The Water · 读一本书，写一个故事</text>
</svg>`;
}

function wrap(text: string, perLine: number, maxLines: number): string[] {
  const chars = Array.from(text.replace(/\s+/g, ' ').trim());
  if (!chars.length) return [];
  const lines: string[] = [];
  for (let i = 0; i < chars.length && lines.length < maxLines; i += perLine) {
    lines.push(chars.slice(i, i + perLine).join(''));
  }
  if (chars.length > perLine * maxLines) lines[lines.length - 1] = `${lines[lines.length - 1]!.slice(0, -1)}…`;
  return lines;
}
