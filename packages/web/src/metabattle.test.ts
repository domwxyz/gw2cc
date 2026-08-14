import { describe, expect, it, vi } from 'vitest';
import type { CachedResource, ResourceCache } from '@gw2cc/core';
import { SafePageFetcher } from './fetcher';
import { MetaBattleClient, metaBattlePageUrl } from './metabattle';

const publicResolver = async () => [{ address: '93.184.216.34' as const, family: 4 as const }];

class MemoryCache implements ResourceCache {
  resource: CachedResource<unknown> | null = null;
  readonly set = vi.fn(async <T>(resource: CachedResource<T>) => {
    this.resource = resource as CachedResource<unknown>;
  });
  async get<T>(): Promise<CachedResource<T> | null> {
    return this.resource as CachedResource<T> | null;
  }
  async deleteBySource(): Promise<void> {
    this.resource = null;
  }
}

function clientFor(fetchMock: typeof fetch, cache?: ResourceCache, now = 123): MetaBattleClient {
  return new MetaBattleClient(new SafePageFetcher({ fetch: fetchMock, resolve: publicResolver, now: () => now }), cache);
}

function parseResponse(revisionId: number, heal = 'Healing Turret'): object {
  return {
    parse: {
      title: 'Build:Scrapper - Power Scrapper',
      pageid: 290,
      revid: revisionId,
      displaytitle: 'Build:Scrapper - Power Scrapper',
      sections: [],
      wikitext: `{{Build|profession=engineer|specialization=scrapper}}\n==Skill Bar==\n{{Skill bar|healing=${heal}}}`
    }
  };
}

describe('MetaBattle MediaWiki API adapter', () => {
  it('parses bounded search results and canonical URLs with revision-adjacent timestamp provenance', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      query: {
        search: [{
          ns: 3000,
          title: 'Build:Scrapper - Power Scrapper',
          pageid: 290,
          snippet: 'Power <span class="searchmatch">Scrapper</span> &amp; quickness',
          timestamp: '2026-08-14T10:00:00Z'
        }]
      }
    }), { headers: { 'content-type': 'application/json' } }));
    const client = clientFor(fetchMock);
    const result = await client.search({ query: 'Power Scrapper', maxResults: 5 });
    expect(result).toMatchObject({
      trust: 'untrusted_external',
      source: 'metabattle_search',
      query: 'Power Scrapper',
      retrievedAt: 123,
      results: [{
        pageId: 290,
        title: 'Build:Scrapper - Power Scrapper',
        url: 'https://metabattle.com/wiki/Build%3AScrapper_-_Power_Scrapper',
        snippet: 'Power Scrapper & quickness',
        namespace: 3000,
        updatedAt: '2026-08-14T10:00:00Z',
        provenance: { sourceKind: 'metabattle_search_result', trust: 'untrusted_external' }
      }]
    });
    const requestUrl = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(requestUrl.origin + requestUrl.pathname).toBe('https://metabattle.com/wiki/api.php');
    expect(requestUrl.searchParams.get('list')).toBe('search');
    expect(requestUrl.searchParams.get('srsearch')).toBe('Power Scrapper');
    expect(requestUrl.searchParams.get('srnamespace')).toBe('3000|0|3002');
  });

  it('extracts revision metadata and reuses parsed cache only for the same revision', async () => {
    const cache = new MemoryCache();
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(parseResponse(100, 'First Heal')), { headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(parseResponse(100, 'Changed But Same Revision')), { headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(parseResponse(101, 'New Revision Heal')), { headers: { 'content-type': 'application/json' } }));
    const client = clientFor(fetchMock, cache);
    const first = await client.fetchBuild('Build:Scrapper - Power Scrapper');
    const cached = await client.fetchBuild('Build:Scrapper - Power Scrapper');
    const refreshed = await client.fetchBuild('Build:Scrapper - Power Scrapper');
    expect(first).toMatchObject({
      source: {
        pageId: 290,
        revisionId: 100,
        url: metaBattlePageUrl('Build:Scrapper - Power Scrapper'),
        provenance: { sourceKind: 'metabattle_wikitext' }
      },
      build: { skills: { heal: { name: 'First Heal' } } },
      provenance: { sourceKind: 'metabattle_build' }
    });
    expect(cached.build.skills.heal?.name).toBe('First Heal');
    expect(refreshed).toMatchObject({ source: { revisionId: 101 }, build: { skills: { heal: { name: 'New Revision Heal' } } } });
    expect(cache.set).toHaveBeenCalledTimes(2);
    expect(cache.resource).toMatchObject({ source: 'metabattle', schemaVersion: '101' });
  });

  it('maps missing pages, malformed payloads, API errors, rate limiting, and cancellation', async () => {
    const missing = clientFor(vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      error: { code: 'missingtitle', info: 'external text' }
    }), { headers: { 'content-type': 'application/json' } })));
    await expect(missing.fetchBuild('Build:Missing')).rejects.toMatchObject({ code: 'METABATTLE_PAGE_NOT_FOUND' });

    const malformed = clientFor(vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ query: {} }), {
      headers: { 'content-type': 'application/json' }
    })));
    await expect(malformed.search({ query: 'x', maxResults: 1 })).rejects.toMatchObject({ code: 'METABATTLE_API_ERROR' });

    const apiError = clientFor(vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      error: { code: 'badvalue', info: 'untrusted detail must not become the application message' }
    }), { headers: { 'content-type': 'application/json' } })));
    await expect(apiError.search({ query: 'x', maxResults: 1 })).rejects.toMatchObject({
      code: 'METABATTLE_API_ERROR', message: 'MetaBattle returned an API error.', details: { apiCode: 'badvalue' }
    });

    const rateLimited = clientFor(vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 429 })));
    await expect(rateLimited.search({ query: 'x', maxResults: 1 })).rejects.toMatchObject({ code: 'WEB_RATE_LIMITED' });

    const controller = new AbortController();
    controller.abort();
    const cancelled = clientFor(vi.fn<typeof fetch>());
    await expect(cancelled.search({ query: 'x', maxResults: 1 }, controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});
