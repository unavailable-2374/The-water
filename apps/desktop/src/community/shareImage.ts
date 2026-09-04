/**
 * 分享图：用 Canvas 画一张 1200×630 的纸感卡片，与书封同一套配色。
 * 保存流程与 novel/export.ts 一致（dialog 选路径 + fs 写文件）。
 */
import { save } from '@tauri-apps/plugin-dialog';
import { writeFile } from '@tauri-apps/plugin-fs';
import { hashHue } from './avatar';
import { wrapLines } from './textWrap';

export interface ShareCardData {
  title: string;
  authorName: string;
  handle?: string | null;
  summary?: string | null;
  stats?: string;
  url: string;
  badge?: string | null;
}

const W = 1200;
const H = 630;
const SERIF = '"Songti SC","STSong","Noto Serif CJK SC",serif';
const SANS = '"PingFang SC","Noto Sans CJK SC",sans-serif';

export function renderShareCard(data: ShareCardData, dpr = 2): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width = `${W}px`;
  canvas.style.height = `${H}px`;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  ctx.scale(dpr, dpr);

  // 纸底 + 细颗粒
  ctx.fillStyle = '#faf7f0';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(120,108,92,0.05)';
  for (let y = 0; y < H; y += 4) for (let x = (y / 4) % 2 === 0 ? 0 : 2; x < W; x += 4) ctx.fillRect(x, y, 1, 1);

  // 左侧书封
  const hue = hashHue(data.title);
  const cx = 90;
  const cy = 135;
  const cw = 260;
  const ch = 360;
  const grad = ctx.createLinearGradient(cx, cy, cx + cw, cy + ch);
  grad.addColorStop(0, `hsl(${hue} 32% 78%)`);
  grad.addColorStop(0.6, `hsl(${hue} 30% 62%)`);
  grad.addColorStop(1, `hsl(${(hue + 20) % 360} 28% 48%)`);
  ctx.fillStyle = grad;
  roundRect(ctx, cx, cy, cw, ch, 10);
  ctx.fill();
  ctx.fillStyle = 'rgba(0,0,0,0.15)';
  ctx.fillRect(cx, cy, 8, ch);
  // 竖排书名
  ctx.fillStyle = 'rgba(255,252,247,0.96)';
  ctx.font = `600 34px ${SERIF}`;
  ctx.textBaseline = 'top';
  let ty = cy + 28;
  for (const ch2 of Array.from(data.title).slice(0, 9)) {
    ctx.fillText(ch2, cx + cw - 58, ty);
    ty += 38;
  }

  // 右侧文字
  const x = 410;
  ctx.fillStyle = '#2a2622';
  ctx.font = `600 52px ${SERIF}`;
  const titleLines = wrapLines(data.title, W - x - 90, (s) => ctx.measureText(s).width, 2);
  let y = 140;
  for (const line of titleLines) {
    ctx.fillText(line, x, y);
    y += 62;
  }

  ctx.fillStyle = '#655e55';
  ctx.font = `22px ${SANS}`;
  ctx.fillText(`${data.authorName}${data.handle ? `  @${data.handle}` : ''}`, x, y + 6);
  y += 56;

  if (data.badge) {
    ctx.fillStyle = '#8a6a2f';
    ctx.font = `20px ${SANS}`;
    ctx.fillText(data.badge, x, y);
    y += 36;
  }

  if (data.summary) {
    ctx.fillStyle = '#4a443d';
    ctx.font = `24px ${SERIF}`;
    const lines = wrapLines(data.summary, W - x - 90, (s) => ctx.measureText(s).width, 3);
    for (const line of lines) {
      ctx.fillText(line, x, y);
      y += 42;
    }
    y += 8;
  }

  if (data.stats) {
    ctx.fillStyle = '#7d756b';
    ctx.font = `20px ${SERIF}`;
    ctx.fillText(data.stats, x, y);
  }

  ctx.fillStyle = '#345a53';
  ctx.font = `20px ${SANS}`;
  ctx.fillText(data.url, x, H - 118);
  ctx.fillStyle = '#9c948a';
  ctx.font = `18px ${SANS}`;
  ctx.fillText('The Water · 读一本书，写一个故事', x, H - 82);

  return canvas;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function toPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('生成图片失败'));
        return;
      }
      blob.arrayBuffer().then((buf) => resolve(new Uint8Array(buf)), reject);
    }, 'image/png');
  });
}

/** 让用户选一个位置保存分享图；取消返回 null。 */
export async function saveShareCardPng(data: ShareCardData, defaultName: string): Promise<string | null> {
  if (document.fonts?.ready) await document.fonts.ready.catch(() => undefined);
  const canvas = renderShareCard(data);
  const bytes = await toPngBytes(canvas);
  const path = await save({ defaultPath: defaultName, filters: [{ name: 'PNG 图片', extensions: ['png'] }] });
  if (!path) return null;
  await writeFile(path, bytes);
  return path;
}
