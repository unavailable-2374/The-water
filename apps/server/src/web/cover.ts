import { createHash } from 'node:crypto';
import { hueFromSeed } from '@the-water/shared';
import { fallbackCoverPng } from './png';

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
 * 微信 / Twitter 的抓取器不渲染 SVG，因此 og:image 用的是同一张图的 PNG 版
 * （见本文件下半部分的 `novelCoverPng`）；SVG 版保留给站内 <img> 与预览，体积更小。
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

// ---- PNG 光栅化（§3.5：微信 / 推特抓取器不渲染 SVG 版 og:image）----

/**
 * 方案选型：`@resvg/resvg-js`（Rust + napi，各平台预编译二进制随 optionalDependencies 装）。
 * 纯 JS 画字要自带字形数据，中文字体动辄十几 MB；`sharp` 的 SVG 支持依赖 librsvg 且同样要系统字体，
 * 体积更大。resvg 用系统字体，服务器只需装一套中文字体（Debian/Ubuntu：`fonts-noto-cjk`）。
 *
 * 代价是一次渲染约 0.3–1.5 秒（大头是字体库扫描），所以：
 * - 结果按 SVG 内容哈希进内存缓存，命中即零成本；
 * - 响应带长 `Cache-Control`，交给 CDN / 浏览器再挡一层；
 * - 原生模块加载或渲染失败时退回 `fallbackCoverPng`（无文字的渐变书封），保证永远是一张真 PNG。
 */
type ResvgModule = typeof import('@resvg/resvg-js');

let resvgPromise: Promise<ResvgModule | null> | null = null;

function loadResvg(): Promise<ResvgModule | null> {
  resvgPromise ??= import('@resvg/resvg-js').catch((err) => {
    console.warn('[web] 封面光栅化不可用，退回无文字兜底封面：', err instanceof Error ? err.message : err);
    return null;
  });
  return resvgPromise;
}

const PNG_CACHE = new Map<string, Uint8Array>();
const PNG_CACHE_MAX = 64;

function cacheKey(svg: string): string {
  return createHash('sha1').update(svg).digest('hex');
}

function remember(key: string, png: Uint8Array): Uint8Array {
  PNG_CACHE.set(key, png);
  if (PNG_CACHE.size > PNG_CACHE_MAX) {
    const oldest = PNG_CACHE.keys().next();
    if (!oldest.done) PNG_CACHE.delete(oldest.value);
  }
  return png;
}

/** 仅测试用：清空封面缓存。 */
export function clearCoverCache(): void {
  PNG_CACHE.clear();
}

/** 把任意 SVG 光栅化成 PNG；失败时用 `hue` 画一张无文字的兜底封面。 */
export async function rasterizePng(svg: string, opts: { width: number; hue: number }): Promise<Uint8Array> {
  const key = cacheKey(svg);
  const hit = PNG_CACHE.get(key);
  if (hit) return hit;
  const mod = await loadResvg();
  if (mod) {
    try {
      const r = new mod.Resvg(svg, {
        fitTo: { mode: 'width', value: opts.width },
        font: { loadSystemFonts: true, defaultFontFamily: 'Songti SC' },
      });
      return remember(key, new Uint8Array(r.render().asPng()));
    } catch (err) {
      console.warn('[web] 封面渲染失败，退回兜底封面：', err instanceof Error ? err.message : err);
    }
  }
  return remember(key, fallbackCoverPng(opts.hue));
}

/** 分享卡片 PNG（1200×630）。 */
export function novelCoverPng(opts: { title: string; authorName: string; summary: string; stats: string }): Promise<Uint8Array> {
  return rasterizePng(novelCoverSvg(opts), { width: 1200, hue: hueFromSeed(opts.title) });
}
