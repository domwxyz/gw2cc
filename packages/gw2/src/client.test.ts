import { describe, expect, it, vi } from 'vitest';
import { Gw2ccError } from '@gw2cc/core';
import { GW2_SCHEMA_VERSION, Gw2HttpClient, validateGw2V2Path } from './client';

describe('GW2 HTTP client', () => {
  it('fixes the host, pins the schema, safely encodes query data, and attaches auth internally', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
      headers: { 'content-type': 'application/json' }
    }));
    const client = new Gw2HttpClient({ fetch: fetchMock });
    await expect(client.get('/v2/characters/Test%20Character/core', 'private-key', { ids: [1, 2] }))
      .resolves.toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('api.guildwars2.com/v2/characters/Test%20Character/core');
    expect(String(url)).toContain(`v=${encodeURIComponent(GW2_SCHEMA_VERSION)}`);
    expect(String(url)).toContain('ids=1%2C2');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer private-key');
  });

  it.each(['/v1/items', '/v2/../account', '/v2/items?ids=1', '//evil.example/v2/items']) (
    'rejects unsafe paths: %s',
    (path) => expect(() => validateGw2V2Path(path)).toThrow(Gw2ccError)
  );

  it('maps permission and malformed payload failures into structured errors', async () => {
    const forbidden = new Gw2HttpClient({
      fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ text: 'requires scope builds' }), { status: 403 }))
    });
    await expect(forbidden.get('/v2/characters/Test/buildtabs/active', 'key')).rejects.toMatchObject({
      code: 'GW2_PERMISSION_MISSING'
    });
  });

  it('reports authentication-required responses as disconnected when no key was sent', async () => {
    const unauthorized = new Gw2HttpClient({
      fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 401 }))
    });
    await expect(unauthorized.get('/v2/account')).rejects.toMatchObject({
      code: 'GW2_NOT_CONNECTED',
      message: expect.stringContaining('requires a connected API key')
    });
  });

  it('does not allow callers to override the pinned schema or inject credentials through query data', async () => {
    const client = new Gw2HttpClient({ fetch: vi.fn<typeof fetch>() });
    await expect(client.get('/v2/account', 'internal-key', { v: 'latest' }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(client.get('/v2/account', 'internal-key', { access_token: 'model-supplied' }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('retries bounded transient and 429 responses, respects Retry-After, and does not retry permanent failures', async () => {
    const sleep = vi.fn(async () => {});
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '1' } }))
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const client = new Gw2HttpClient({ fetch: fetchMock, maxRetries: 2, sleep, maxRetryDelayMs: 1_500 });
    await expect(client.get('/v2/account', 'key')).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 1_000, expect.any(AbortSignal));
    expect(sleep).toHaveBeenNthCalledWith(2, 500, expect.any(AbortSignal));

    const forbiddenFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 403 }));
    const forbidden = new Gw2HttpClient({ fetch: forbiddenFetch, maxRetries: 2, sleep });
    await expect(forbidden.get('/v2/account/bank', 'key')).rejects.toMatchObject({ code: 'GW2_PERMISSION_MISSING' });
    expect(forbiddenFetch).toHaveBeenCalledTimes(1);
  });

  it('cancels during retry backoff without issuing another request', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 503 }));
    const client = new Gw2HttpClient({
      fetch: fetchMock,
      maxRetries: 2,
      sleep: async (_milliseconds, signal) => {
        controller.abort();
        if (signal.aborted) throw new Gw2ccError('CANCELLED', 'cancelled');
      }
    });
    await expect(client.get('/v2/account', 'key', {}, controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
