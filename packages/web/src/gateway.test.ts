import { describe, expect, it, vi } from 'vitest';
import { InMemorySecretStore, ResearchService } from '@gw2cc/core';
import { SafePageFetcher } from './fetcher';
import { LiveResearchGateway } from './gateway';
import { TavilyClient } from './tavily';

const resolvePublic = async () => [{ address: '93.184.216.34' as const, family: 4 as const }];

describe('Tavily research adapter and credential boundary', () => {
  it('sends the credential only in the fixed Tavily header and returns bounded structured search provenance', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      query: 'condition builds',
      results: [{ title: 'Guide', url: 'https://example.com/guide', content: 'x'.repeat(3_000), score: 0.91 }]
    }), { headers: { 'content-type': 'application/json' } }));
    const pages = new SafePageFetcher({ fetch: fetchMock, resolve: resolvePublic });
    const gateway = new LiveResearchGateway(new TavilyClient(fetchMock), pages, () => 123);
    const result = await gateway.search('tvly-test-credential', { query: 'condition builds', maxResults: 5 });
    const [, init] = fetchMock.mock.calls[0]!;
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer tvly-test-credential');
    expect(result).toMatchObject({
      trust: 'untrusted_external',
      source: 'tavily_search',
      results: [{ domain: 'example.com', provenance: { sourceKind: 'tavily_search_snippet' } }]
    });
    expect(result.results[0]?.snippet.length).toBe(2_500);
    expect(JSON.stringify(result)).not.toContain('tvly-test-credential');
  });

  it('validates before saving, exposes configured status only, and clears the Tavily secret', async () => {
    const search = vi.fn(async () => ({ trust: 'untrusted_external' as const, source: 'tavily_search' as const, query: 'q', results: [], retrievedAt: 1 }));
    const gateway = {
      fixtureMode: false,
      search,
      fetchUrl: vi.fn(),
      fetchJson: vi.fn(),
      searchMetaBattle: vi.fn(),
      fetchMetaBattleBuild: vi.fn()
    };
    const secrets = new InMemorySecretStore();
    const service = new ResearchService(gateway, secrets);
    const view = await service.setCredential('tvly-private-value');
    expect(search).toHaveBeenCalledWith('tvly-private-value', expect.any(Object), undefined);
    expect(view).toMatchObject({ credentialConfigured: true, searchAvailable: true });
    expect(JSON.stringify(view)).not.toContain('tvly-private-value');
    expect(await secrets.get('tavily-api-key')).toBe('tvly-private-value');
    await service.clearCredential();
    expect(await secrets.get('tavily-api-key')).toBeNull();
  });

  it('uses Tavily Extract only as a safe fallback for a prevalidated public URL', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('denied', { status: 403, headers: { 'content-type': 'text/plain' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        results: [{ url: 'https://example.com/guide', raw_content: '# Extracted guide\nUseful details.' }],
        failed_results: []
      }), { headers: { 'content-type': 'application/json' } }));
    const gateway = new LiveResearchGateway(
      new TavilyClient(fetchMock),
      new SafePageFetcher({ fetch: fetchMock, resolve: resolvePublic })
    );
    const result = await gateway.fetchUrl(
      { url: 'https://example.com/guide' },
      { tavilyApiKey: 'tvly-fallback' }
    );
    expect(result).toMatchObject({ extractionMethod: 'tavily_extract', trust: 'untrusted_external' });
    expect(result.content).toContain('Extracted guide');
  });

  it('retries Tavily rate limits once with bounded Retry-After handling', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '1' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ query: 'bank', results: [] }), { status: 200 }));
    const sleep = vi.fn(async () => {});
    const client = new TavilyClient(fetchMock, 20_000, 1, sleep);
    await expect(client.search('tvly-retry', { query: 'bank', maxResults: 1 })).resolves.toMatchObject({ query: 'bank' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1_000, expect.any(AbortSignal));
  });

  it('does not bypass a webpage rate limit through the extraction fallback', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('', {
      status: 429,
      headers: { 'retry-after': '60' }
    }));
    const gateway = new LiveResearchGateway(
      new TavilyClient(fetchMock),
      new SafePageFetcher({ fetch: fetchMock, resolve: resolvePublic })
    );
    await expect(gateway.fetchUrl(
      { url: 'https://example.com/rate-limited' },
      { tavilyApiKey: 'tvly-should-not-bypass' }
    )).rejects.toMatchObject({ code: 'WEB_RATE_LIMITED' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
