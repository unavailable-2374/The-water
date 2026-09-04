/**
 * 头像与书封共用的确定性配色：同一个种子永远得到同一个颜色，
 * 所以同一位作者在书架、动态、榜单里看起来是同一个人。
 */

/** 书封用的暖色盘（原本内联在 components/ui.tsx，提出来供头像复用）。 */
const BOOK_PALETTE = [18, 28, 40, 150, 165, 190, 205, 350, 10, 95];

export function hashSeed(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

export function hashHue(s: string): number {
  return BOOK_PALETTE[hashSeed(s) % BOOK_PALETTE.length]!;
}

/** 头像色相取全色环，比书封更活泼，但同样稳定。 */
export function avatarHue(seed: string): number {
  return hashSeed(seed) % 360;
}

export function avatarGradient(seed: string): string {
  const hue = avatarHue(seed);
  return `linear-gradient(145deg, hsl(${hue} 42% 74%) 0%, hsl(${(hue + 38) % 360} 38% 54%) 100%)`;
}

/** 头像上的那个字：取昵称第一个字形（支持 emoji 与组合字符）。 */
export function avatarInitial(displayName: string): string {
  const first = Array.from(displayName.trim())[0];
  return first ?? '?';
}
