/**
 * 极小的 PNG 编码器（8bit RGB，无滤波）。
 *
 * 只在光栅化不可用时兜底：`@resvg/resvg-js` 的原生二进制在当前平台缺失、
 * 或渲染抛错时，仍然要能给出一张**真 PNG**，否则 og:image 会 404，分享卡片直接没有图。
 * 兜底图没有文字（画字需要字体），只画渐变书封色块。
 */
import { deflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** `rgb` 长度必须是 width*height*3。 */
export function encodePng(width: number, height: number, rgb: Uint8Array): Uint8Array {
  const stride = width * 3;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    raw.set(rgb.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(deflateSync(raw, { level: 6 }))),
    chunk('IEND', new Uint8Array(0)),
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** HSL(0-360, 0-1, 0-1) → RGB(0-255)。 */
function hsl(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/**
 * 兜底封面：米色底 + 左侧渐变书脊色块，与 SVG 版配色一致。
 */
export function fallbackCoverPng(hue: number, width = 1200, height = 630): Uint8Array {
  const rgb = new Uint8Array(width * height * 3);
  const [br, bg, bb] = [250, 247, 240];
  for (let i = 0; i < width * height; i++) {
    rgb[i * 3] = br;
    rgb[i * 3 + 1] = bg;
    rgb[i * 3 + 2] = bb;
  }
  const x0 = Math.round(width * 0.075);
  const x1 = Math.round(width * 0.292);
  const y0 = Math.round(height * 0.214);
  const y1 = Math.round(height * 0.786);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const t = (x - x0) / (x1 - x0) / 2 + (y - y0) / (y1 - y0) / 2;
      const [r, g, b] = hsl((hue + t * 20) % 360, 0.3, 0.78 - t * 0.3);
      const i = (y * width + x) * 3;
      rgb[i] = r;
      rgb[i + 1] = g;
      rgb[i + 2] = b;
    }
  }
  return rgb.length ? encodePng(width, height, rgb) : encodePng(1, 1, new Uint8Array(3));
}
