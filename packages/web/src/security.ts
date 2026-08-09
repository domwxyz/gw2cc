import { Gw2ccError } from '@gw2cc/core';

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type DnsResolver = (hostname: string, signal?: AbortSignal) => Promise<ResolvedAddress[]>;

function parseIpv4(value: string): number[] | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  const numbers = parts.map((part) => /^\d{1,3}$/.test(part) ? Number(part) : Number.NaN);
  return numbers.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) ? numbers : null;
}

function ipv6Parts(value: string): number[] | null {
  const withoutBrackets = value.replace(/^\[|\]$/g, '').toLowerCase();
  if (withoutBrackets.includes('%') || !withoutBrackets.includes(':')) return null;
  const pieces = withoutBrackets.split('::');
  if (pieces.length > 2) return null;
  const parseSide = (side: string): number[] | null => {
    if (!side) return [];
    const output: number[] = [];
    for (const part of side.split(':')) {
      const ipv4 = parseIpv4(part);
      if (ipv4) {
        output.push((ipv4[0]! << 8) | ipv4[1]!, (ipv4[2]! << 8) | ipv4[3]!);
      } else if (/^[0-9a-f]{1,4}$/.test(part)) {
        output.push(Number.parseInt(part, 16));
      } else {
        return null;
      }
    }
    return output;
  };
  const left = parseSide(pieces[0] ?? '');
  const right = parseSide(pieces[1] ?? '');
  if (!left || !right) return null;
  const missing = 8 - left.length - right.length;
  if ((pieces.length === 1 && missing !== 0) || (pieces.length === 2 && missing < 1)) return null;
  return [...left, ...Array.from({ length: Math.max(0, missing) }, () => 0), ...right];
}

function blockedIpv4(parts: number[]): boolean {
  const [a, b, c] = parts as [number, number, number, number];
  return a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224;
}

export function isBlockedIpAddress(value: string): boolean {
  const ipv4 = parseIpv4(value);
  if (ipv4) return blockedIpv4(ipv4);
  const parts = ipv6Parts(value);
  if (!parts) return true;
  const bytes = parts.flatMap((part) => [part >> 8, part & 0xff]);
  const allZero = bytes.every((byte) => byte === 0);
  const loopback = bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1;
  const uniqueLocal = (bytes[0]! & 0xfe) === 0xfc;
  const linkLocal = bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80;
  const multicast = bytes[0] === 0xff;
  const documentation = bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8;
  const mapped = bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  const compatible = bytes.slice(0, 12).every((byte) => byte === 0);
  const nat64 = parts.slice(0, 6).every((part, index) => part === [0x64, 0xff9b, 0, 0, 0, 0][index]);
  const embedded = [bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!];
  return allZero || loopback || uniqueLocal || linkLocal || multicast || documentation ||
    ((mapped || compatible || nat64) && blockedIpv4(embedded));
}

function blockedHostname(hostname: string): boolean {
  const normalized = hostname.replace(/\.$/, '').toLowerCase();
  return normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized.endsWith('.local') ||
    normalized === 'metadata.google.internal' ||
    normalized === 'instance-data' ||
    normalized.endsWith('.internal');
}

export async function assertSafeHttpUrl(
  value: string,
  resolve: DnsResolver,
  signal?: AbortSignal
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Gw2ccError('WEB_FETCH_BLOCKED', 'The page URL is invalid.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Gw2ccError('WEB_FETCH_BLOCKED', 'Only HTTP and HTTPS page URLs are allowed.');
  }
  if (url.username || url.password) {
    throw new Gw2ccError('WEB_FETCH_BLOCKED', 'Page URLs containing embedded credentials are blocked.');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!hostname || blockedHostname(hostname)) {
    throw new Gw2ccError('WEB_FETCH_BLOCKED', 'Local and internal network destinations are blocked.');
  }
  const literalV4 = parseIpv4(hostname);
  const literalV6 = hostname.includes(':') ? ipv6Parts(hostname) : null;
  if (literalV4 || literalV6) {
    if (isBlockedIpAddress(hostname)) {
      throw new Gw2ccError('WEB_FETCH_BLOCKED', 'Private, local, link-local, metadata, and reserved destinations are blocked.');
    }
    return url;
  }
  if (signal?.aborted) throw new Gw2ccError('CANCELLED', 'Page fetching was cancelled.');
  let addresses: ResolvedAddress[];
  try {
    addresses = await resolve(hostname, signal);
  } catch (error) {
    if (signal?.aborted) throw new Gw2ccError('CANCELLED', 'Page fetching was cancelled.');
    throw new Gw2ccError('WEB_FETCH_FAILED', 'The page hostname could not be resolved.', { retryable: true, cause: error });
  }
  if (signal?.aborted) throw new Gw2ccError('CANCELLED', 'Page fetching was cancelled.');
  if (addresses.length === 0) {
    throw new Gw2ccError('WEB_FETCH_FAILED', 'The page hostname did not resolve to an address.', { retryable: true });
  }
  if (addresses.some((entry) => isBlockedIpAddress(entry.address))) {
    throw new Gw2ccError('WEB_FETCH_BLOCKED', 'The page hostname resolves to a blocked network destination.');
  }
  return url;
}
