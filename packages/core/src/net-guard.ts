import { isIP } from 'node:net';

/**
 * Guards server-side downloads (image URLs sent through the API) against
 * requests into private networks (SSRF). Only public unicast addresses pass.
 */
export function isPublicAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return isPublicV4(ip);
  if (v === 6) return isPublicV6(ip.toLowerCase());
  return false;
}

function isPublicV4(ip: string): boolean {
  const [a, b, c] = ip.split('.').map(Number) as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return false; // this network, private, loopback
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
  if (a === 169 && b === 254) return false; // link-local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false; // private
  if (a === 192 && b === 168) return false; // private
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // IETF, TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
  if (a >= 224) return false; // multicast, reserved, broadcast
  return true;
}

function isPublicV6(ip: string): boolean {
  if (ip === '::' || ip === '::1') return false;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (mapped) return isPublicV4(mapped[1]!);
  const first = parseInt(ip.split(':')[0] || '0', 16);
  if ((first & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return false; // multicast
  if (ip.startsWith('64:ff9b:') || ip.startsWith('2001:db8:') || ip.startsWith('2001:0db8:'))
    return false;
  return (first & 0xe000) === 0x2000; // global unicast 2000::/3
}
