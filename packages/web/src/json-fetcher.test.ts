import { describe, expect, it, vi } from 'vitest';
import { SafePageFetcher } from './fetcher';
import { parseAndBoundJson } from './json';
import type { DnsResolver } from './security';

const publicResolver: DnsResolver = async () => [{ address: '93.184.216.34', family: 4 }];

describe('safe public JSON fetching', () => {
  it.each(['application/json', 'application/problem+json', 'application/vnd.api+json'])('accepts and preserves structured %s responses', async (contentType) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ ok: true, nested: { value: 7 } }), {
      headers: { 'content-type': `${contentType}; charset=utf-8` }
    }));
    const fetcher = new SafePageFetcher({ fetch: fetchMock, resolve: publicResolver, now: () => 42 });
    const result = await fetcher.fetchJson('https://example.com/data');
    expect(result).toMatchObject({
      trust: 'untrusted_external',
      data: { ok: true, nested: { value: 7 } },
      contentType,
      retrievedAt: 42,
      bounding: { truncated: false },
      provenance: { sourceKind: 'live_json', trust: 'untrusted_external' }
    });
    expect(fetchMock).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({
      method: 'GET',
      redirect: 'manual',
      headers: expect.objectContaining({
        Accept: expect.stringContaining('application/json'),
        'User-Agent': expect.stringContaining('GW2CC')
      })
    }));
  });

  it('tolerates successfully parsed text JSON but rejects malformed JSON and unsupported binary types', async () => {
    const textFetcher = new SafePageFetcher({
      fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response('{"safe":true}', { headers: { 'content-type': 'text/plain' } })),
      resolve: publicResolver
    });
    await expect(textFetcher.fetchJson('https://example.com/text-json')).resolves.toMatchObject({ data: { safe: true } });

    const malformed = new SafePageFetcher({
      fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response('{broken', { headers: { 'content-type': 'application/json' } })),
      resolve: publicResolver
    });
    await expect(malformed.fetchJson('https://example.com/broken')).rejects.toMatchObject({ code: 'WEB_JSON_INVALID' });

    const binary = new SafePageFetcher({
      fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response('binary', { headers: { 'content-type': 'application/octet-stream' } })),
      resolve: publicResolver
    });
    await expect(binary.fetchJson('https://example.com/binary')).rejects.toMatchObject({ code: 'WEB_CONTENT_UNSUPPORTED' });
  });

  it('enforces declared and streamed byte limits before parsing', async () => {
    const declared = new SafePageFetcher({
      fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', {
        headers: { 'content-type': 'application/json', 'content-length': '1000' }
      })),
      resolve: publicResolver,
      maxDownloadBytes: 100
    });
    await expect(declared.fetchJson('https://example.com/large')).rejects.toMatchObject({ code: 'WEB_FETCH_FAILED' });

    const streamed = new SafePageFetcher({
      fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ data: 'x'.repeat(200) }), {
        headers: { 'content-type': 'application/json' }
      })),
      resolve: publicResolver,
      maxDownloadBytes: 100
    });
    await expect(streamed.fetchJson('https://example.com/stream-large')).rejects.toMatchObject({ code: 'WEB_FETCH_FAILED' });
  });

  it('maps timeouts, cancellation, rate limits, and retryable server errors', async () => {
    const never = vi.fn<typeof fetch>(async (_url, init) => new Promise<Response>((_resolve, reject) => {
      if (init?.signal?.aborted) reject(new DOMException('aborted', 'AbortError'));
      else init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }));
    const timed = new SafePageFetcher({ fetch: never, resolve: publicResolver, timeoutMs: 5 });
    await expect(timed.fetchJson('https://example.com/slow')).rejects.toMatchObject({ code: 'WEB_FETCH_FAILED', retryable: true });

    const controller = new AbortController();
    const cancelled = new SafePageFetcher({ fetch: never, resolve: publicResolver, timeoutMs: 1_000 });
    const pending = cancelled.fetchJson('https://example.com/cancel', controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });

    const rateLimited = new SafePageFetcher({
      fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 429, headers: { 'retry-after': '12' } })),
      resolve: publicResolver
    });
    await expect(rateLimited.fetchJson('https://example.com/rate')).rejects.toMatchObject({
      code: 'WEB_RATE_LIMITED', retryable: true, details: { status: 429, retryAfter: '12' }
    });

    const serverError = new SafePageFetcher({
      fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 503 })),
      resolve: publicResolver
    });
    await expect(serverError.fetchJson('https://example.com/unavailable')).rejects.toMatchObject({
      code: 'WEB_FETCH_FAILED', retryable: true, details: { status: 503 }
    });
  });

  it('validates every redirect, direct destination, credentials, and DNS answer before fetch', async () => {
    const redirectFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, {
      status: 302,
      headers: { location: 'http://169.254.169.254/latest/meta-data/' }
    }));
    const redirecting = new SafePageFetcher({ fetch: redirectFetch, resolve: publicResolver });
    await expect(redirecting.fetchJson('https://example.com/start')).rejects.toMatchObject({ code: 'WEB_FETCH_BLOCKED' });
    expect(redirectFetch).toHaveBeenCalledTimes(1);

    const fetchMock = vi.fn<typeof fetch>();
    const blocked = new SafePageFetcher({ fetch: fetchMock, resolve: publicResolver });
    await expect(blocked.fetchJson('http://127.0.0.1/private')).rejects.toMatchObject({ code: 'WEB_FETCH_BLOCKED' });
    await expect(blocked.fetchJson('https://user:password@example.com/data')).rejects.toMatchObject({ code: 'WEB_FETCH_BLOCKED' });
    expect(fetchMock).not.toHaveBeenCalled();

    const mixedDns = new SafePageFetcher({
      fetch: fetchMock,
      resolve: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '10.0.0.2', family: 4 }
      ]
    });
    await expect(mixedDns.fetchJson('https://public-looking.example/data')).rejects.toMatchObject({ code: 'WEB_FETCH_BLOCKED' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('structurally bounds deep, wide, and long JSON deterministically', () => {
    const result = parseAndBoundJson(JSON.stringify({
      long: 'x'.repeat(30),
      wide: [1, 2, 3, 4],
      deep: { a: { b: { c: true } } }
    }), {
      maxDepth: 2,
      maxArrayEntries: 2,
      maxObjectEntries: 10,
      maxStringCharacters: 10,
      maxNodes: 100
    });
    expect(result.truncated).toBe(true);
    expect(result.data).toMatchObject({
      long: 'xxxxxxxxxx[TRUNCATED_STRING]',
      wide: [1, 2, { __gw2ccTruncatedItems: 2 }],
      deep: { a: { b: '[TRUNCATED_DEPTH]' } }
    });
  });
});
