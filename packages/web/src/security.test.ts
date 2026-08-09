import { describe, expect, it } from 'vitest';
import { assertSafeHttpUrl, isBlockedIpAddress, type DnsResolver } from './security';

const publicResolver: DnsResolver = async () => [{ address: '93.184.216.34', family: 4 }];

describe('web URL SSRF validation', () => {
  it.each([
    'file:///etc/passwd',
    'data:text/plain,hello',
    'ftp://example.com/file',
    'http://user:password@example.com/',
    'http://localhost/',
    'http://127.0.0.1/',
    'http://2130706433/',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.1/',
    'http://172.16.0.1/',
    'http://192.168.1.1/',
    'http://[::1]/',
    'http://[fe80::1]/',
    'http://[fc00::1]/',
    'http://[::ffff:127.0.0.1]/'
  ])('blocks unsafe destination %s', async (url) => {
    await expect(assertSafeHttpUrl(url, publicResolver)).rejects.toMatchObject({ code: 'WEB_FETCH_BLOCKED' });
  });

  it('blocks hostnames whose DNS answer includes a private or metadata address', async () => {
    await expect(assertSafeHttpUrl('https://public-looking.example/page', async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '169.254.169.254', family: 4 }
    ])).rejects.toMatchObject({ code: 'WEB_FETCH_BLOCKED' });
  });

  it('accepts only globally routable HTTP(S) destinations', async () => {
    await expect(assertSafeHttpUrl('https://example.com/article', publicResolver))
      .resolves.toMatchObject({ protocol: 'https:', hostname: 'example.com' });
    expect(isBlockedIpAddress('8.8.8.8')).toBe(false);
    expect(isBlockedIpAddress('2606:4700:4700::1111')).toBe(false);
  });
});
