/**
 * §4.5：TRUST_PROXY 改为可信代理列表。
 * X-Forwarded-For 是谁都能写的头，从前无条件取第一段等于把限流键与浏览去重键交给伪造方。
 */
import { describe, expect, it } from 'bun:test';
import { resolveClientIp } from '../src/middleware/client-id';
import { ipInList, ipMatches, ipToBytes } from '../src/lib/net';

describe('IP / CIDR 匹配', () => {
  it('IPv4 单地址与 CIDR', () => {
    expect(ipMatches('10.0.0.5', '10.0.0.5')).toBe(true);
    expect(ipMatches('10.0.0.6', '10.0.0.5')).toBe(false);
    expect(ipMatches('10.0.3.7', '10.0.0.0/16')).toBe(true);
    expect(ipMatches('10.1.3.7', '10.0.0.0/16')).toBe(false);
    // 非 8 的倍数的前缀长度。
    expect(ipMatches('192.168.1.130', '192.168.1.128/25')).toBe(true);
    expect(ipMatches('192.168.1.127', '192.168.1.128/25')).toBe(false);
    expect(ipMatches('1.2.3.4', '0.0.0.0/0')).toBe(true);
  });

  it('IPv6 单地址与 CIDR，含 :: 缩写', () => {
    expect(ipMatches('2001:db8::1', '2001:db8::1')).toBe(true);
    expect(ipMatches('2001:db8::1', '2001:db8::/32')).toBe(true);
    expect(ipMatches('2001:db9::1', '2001:db8::/32')).toBe(false);
    expect(ipMatches('fd00:1:2:3::9', 'fd00::/8')).toBe(true);
    expect(ipMatches('2001:db8::abcd', '2001:db8::ab00/120')).toBe(true);
    expect(ipMatches('2001:db8::ac00', '2001:db8::ab00/120')).toBe(false);
  });

  it('IPv4-mapped IPv6 折算成 IPv4 再比', () => {
    expect(ipToBytes('::ffff:10.0.0.5')).toEqual(ipToBytes('10.0.0.5')!);
    expect(ipMatches('::ffff:10.0.0.5', '10.0.0.0/8')).toBe(true);
  });

  it('非法输入一律不命中，不抛错', () => {
    expect(ipMatches('not-an-ip', '10.0.0.0/8')).toBe(false);
    expect(ipMatches('unknown', '0.0.0.0/0')).toBe(false);
    expect(ipMatches('10.0.0.1', '10.0.0.0/99')).toBe(false);
    expect(ipMatches('10.0.0.1', 'garbage/8')).toBe(false);
    expect(ipToBytes('1.2.3.999')).toBeNull();
    expect(ipToBytes('2001:db8::1::2')).toBeNull();
    expect(ipInList('10.0.0.1', [])).toBe(false);
  });
});

describe('客户端 IP 解析', () => {
  const trusted = ['10.0.0.0/8', '2001:db8::/32'];

  it('TRUST_PROXY=0 时完全不看 XFF', () => {
    expect(
      resolveClientIp({ remote: '10.0.0.1', xff: '1.2.3.4', trustProxy: false, trustedProxies: trusted }),
    ).toBe('10.0.0.1');
  });

  it('直连来源不在名单里就不采信 XFF', () => {
    // 伪造者直接连上来并自带一个 XFF 头。
    expect(
      resolveClientIp({ remote: '203.0.113.9', xff: '9.9.9.9', trustProxy: true, trustedProxies: trusted }),
    ).toBe('203.0.113.9');
  });

  it('来源命中名单时，从右往左取第一个不在名单里的一跳', () => {
    // 链条：客户端 → 未知代理 → 我们的 LB(10.0.0.7) → 本进程(remote=10.0.0.7)
    expect(
      resolveClientIp({ remote: '10.0.0.7', xff: '1.1.1.1, 203.0.113.9, 10.0.0.7', trustProxy: true, trustedProxies: trusted }),
    ).toBe('203.0.113.9');
    // 客户端把整段 XFF 都伪造成内网地址也没用：最右一个非可信项才是真的。
    expect(
      resolveClientIp({ remote: '10.0.0.7', xff: '10.9.9.9, 203.0.113.9, 10.0.0.7', trustProxy: true, trustedProxies: trusted }),
    ).toBe('203.0.113.9');
    // 整条链都是自己的代理，那最左段就是客户端。
    expect(
      resolveClientIp({ remote: '10.0.0.7', xff: '10.1.1.1, 10.0.0.7', trustProxy: true, trustedProxies: trusted }),
    ).toBe('10.1.1.1');
  });

  it('IPv6 可信代理同样生效', () => {
    expect(
      resolveClientIp({ remote: '2001:db8::7', xff: '203.0.113.9, 2001:db8::7', trustProxy: true, trustedProxies: trusted }),
    ).toBe('203.0.113.9');
    expect(
      resolveClientIp({ remote: '2001:dead::7', xff: '203.0.113.9', trustProxy: true, trustedProxies: trusted }),
    ).toBe('2001:dead::7');
  });

  it('名单为空退化成旧行为（取最左段），且没有 XFF 时用直连来源', () => {
    expect(resolveClientIp({ remote: '203.0.113.9', xff: '1.2.3.4, 5.6.7.8', trustProxy: true, trustedProxies: [] })).toBe('1.2.3.4');
    expect(resolveClientIp({ remote: '203.0.113.9', xff: null, trustProxy: true, trustedProxies: trusted })).toBe('203.0.113.9');
    expect(resolveClientIp({ remote: 'unknown', xff: '1.2.3.4', trustProxy: true, trustedProxies: trusted })).toBe('unknown');
  });
});
