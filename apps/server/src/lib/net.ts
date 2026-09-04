/**
 * IP 与 CIDR 匹配（§4.5：可信代理列表）。
 *
 * 只做「这个地址在不在名单里」这一件事，支持 IPv4 / IPv6 的单地址与 CIDR 写法。
 * IPv4-mapped IPv6（`::ffff:1.2.3.4`）一律折算成 IPv4 再比，
 * 否则同一个客户端从不同网络栈进来会算成两个地址。
 */

/** 解析成定长字节；解析失败返回 null。IPv4 与 IPv4-mapped 都返回 4 字节。 */
export function ipToBytes(ip: string): Uint8Array | null {
  const s = ip.trim().replace(/^\[|\]$/g, '');
  if (!s) return null;
  if (!s.includes(':')) return ipv4ToBytes(s);

  // 去掉 zone id（fe80::1%eth0）
  const noZone = s.split('%')[0]!;
  const parts = noZone.split('::');
  if (parts.length > 2) return null;
  const headStr = parts[0] ?? '';
  const tailStr = parts.length === 2 ? (parts[1] ?? '') : null;

  const groups = (chunk: string): number[] | null => {
    if (!chunk) return [];
    const out: number[] = [];
    for (const piece of chunk.split(':')) {
      if (piece.includes('.')) {
        const v4 = ipv4ToBytes(piece);
        if (!v4) return null;
        out.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) return null;
      out.push(parseInt(piece, 16));
    }
    return out;
  };

  const head = groups(headStr);
  const tail = tailStr === null ? [] : groups(tailStr);
  if (!head || !tail) return null;
  const fillCount = 8 - head.length - tail.length;
  if (tailStr === null ? head.length !== 8 : fillCount < 0) return null;
  const all = tailStr === null ? head : [...head, ...new Array<number>(fillCount).fill(0), ...tail];
  if (all.length !== 8) return null;

  const bytes = new Uint8Array(16);
  all.forEach((g, i) => {
    bytes[i * 2] = (g >> 8) & 0xff;
    bytes[i * 2 + 1] = g & 0xff;
  });
  // ::ffff:a.b.c.d → 折算成 IPv4
  const mapped = bytes.slice(0, 12).every((b, i) => (i < 10 ? b === 0 : b === 0xff));
  return mapped ? bytes.slice(12) : bytes;
}

function ipv4ToBytes(s: string): Uint8Array | null {
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const p = parts[i]!;
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out[i] = n;
  }
  return out;
}

function samePrefix(a: Uint8Array, b: Uint8Array, bits: number): boolean {
  if (a.length !== b.length) return false;
  const full = bits >> 3;
  for (let i = 0; i < full; i++) if (a[i] !== b[i]) return false;
  const rest = bits & 7;
  if (rest === 0) return true;
  const mask = (0xff << (8 - rest)) & 0xff;
  return (a[full]! & mask) === (b[full]! & mask);
}

/** 判断 ip 是否命中一条规则（单地址或 `addr/len` CIDR）。 */
export function ipMatches(ip: string, rule: string): boolean {
  const target = ipToBytes(ip);
  if (!target) return false;
  const slash = rule.indexOf('/');
  if (slash === -1) {
    const net = ipToBytes(rule);
    return !!net && net.length === target.length && net.every((b, i) => b === target[i]);
  }
  const net = ipToBytes(rule.slice(0, slash));
  const bits = Number(rule.slice(slash + 1));
  if (!net || !Number.isInteger(bits) || bits < 0) return false;
  if (bits > net.length * 8) return false;
  return samePrefix(target, net, bits);
}

/** 判断 ip 是否命中名单里的任意一条。名单为空返回 false。 */
export function ipInList(ip: string, list: readonly string[]): boolean {
  return list.some((rule) => ipMatches(ip, rule));
}
