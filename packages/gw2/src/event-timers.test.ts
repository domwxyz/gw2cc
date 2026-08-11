import { describe, expect, it, vi } from 'vitest';
import {
  Gw2ccError,
  type CachedResource,
  type ResourceCache
} from '@gw2cc/core';
import {
  FixtureGw2EventTimerGateway,
  GW2_WIKI_EVENT_TIMER_CACHE_TTL_MS,
  GW2_WIKI_USER_AGENT,
  LiveGw2EventTimerGateway,
  WikiEventTimerClient,
  expandGw2EventTimerSchedule,
  parseWikiEventTimerResponse,
  type Gw2EventTimerQuery,
  type WikiEventTimerRecipeDocument
} from './event-timers';

const REVISION_SHA1 = '67d87dcfd5b156c8339e777acde3b9c0952e8546';

const auricRecipe = {
  config: { version: 'v-test' },
  events: {
    'hot-ab': {
      category: 'Heart of Thorns',
      name: 'Auric Basin',
      segments: {
        0: { name: '' },
        1: { name: 'Pylons', link: 'Defending Tarir', chatlink: '[&BN0HAAA=]' },
        2: { name: 'Challenges', link: 'Battle in Tarir', chatlink: '[&BGwIAAA=]' },
        3: { name: 'Octovine', link: 'Battle in Tarir', chatlink: '[&BAIIAAA=]' },
        4: { name: 'Reset', link: "A Moment's Rest" }
      },
      sequences: {
        partial: [{ r: 1, d: 45 }, { r: 2, d: 15 }, { r: 3, d: 20 }, { r: 4, d: 10 }],
        pattern: [{ r: 1, d: 75 }, { r: 2, d: 15 }, { r: 3, d: 20 }, { r: 4, d: 10 }]
      }
    }
  }
};

function mediaWikiResponse(recipe: unknown = auricRecipe, revisionId = 3_138_800) {
  return {
    batchcomplete: true,
    query: {
      pages: [{
        pageid: 386_688,
        ns: 274,
        title: 'Widget:Event timer/data.json',
        revisions: [{
          revid: revisionId,
          parentid: revisionId - 1,
          timestamp: '2026-05-12T23:49:52Z',
          sha1: REVISION_SHA1,
          slots: {
            main: {
              contentmodel: 'json',
              contentformat: 'application/json',
              content: JSON.stringify(recipe)
            }
          }
        }]
      }]
    }
  };
}

function parsedDocument(revisionId = 3_138_800): WikiEventTimerRecipeDocument {
  return parseWikiEventTimerResponse(mediaWikiResponse(auricRecipe, revisionId));
}

const defaultQuery: Gw2EventTimerQuery = {
  windowMinutes: 180,
  includeActive: true,
  limit: 40
};

class MemoryResourceCache implements ResourceCache {
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

describe('Guild Wars 2 Wiki event timer client and parser', () => {
  it('uses only the fixed MediaWiki request and identifying headers and captures revision provenance including SHA-1', async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      void input;
      void init;
      return new Response(JSON.stringify(mediaWikiResponse()), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    });
    const client = new WikiEventTimerClient({
      fetch: fetchMock as unknown as typeof globalThis.fetch,
      maxRetries: 0
    });

    const document = await client.fetchRecipe();

    expect(document).toMatchObject({
      page: 'Widget:Event timer/data.json',
      revisionId: 3_138_800,
      revisionTimestamp: '2026-05-12T23:49:52Z',
      revisionSha1: REVISION_SHA1,
      recipe: { config: { version: 'v-test' } }
    });
    const [requested, init] = fetchMock.mock.calls[0]!;
    const url = new URL(String(requested));
    expect(url.origin).toBe('https://wiki.guildwars2.com');
    expect(url.pathname).toBe('/api.php');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      action: 'query',
      prop: 'revisions',
      titles: 'Widget:Event timer/data.json',
      rvprop: 'ids|timestamp|sha1|content',
      rvslots: 'main',
      formatversion: '2',
      format: 'json'
    });
    expect(init).toMatchObject({ method: 'GET', redirect: 'error' });
    const headers = new Headers(init?.headers);
    expect(headers.get('accept')).toBe('application/json');
    expect(headers.get('user-agent')).toBe(GW2_WIKI_USER_AGENT);
    expect(headers.get('api-user-agent')).toBe(GW2_WIKI_USER_AGENT);
  });

  it('reports HTTP 403 as non-retryable access denial without implying rate limiting', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 403 }));
    const sleep = vi.fn(async () => {});
    const client = new WikiEventTimerClient({
      fetch: fetchMock as unknown as typeof globalThis.fetch,
      maxRetries: 2,
      sleep
    });

    const error = await client.fetchRecipe().then(
      () => undefined,
      (reason: unknown) => reason
    );
    expect(error).toMatchObject({
      code: 'GW2_UPSTREAM_UNAVAILABLE',
      retryable: false,
      message: expect.stringMatching(/denied access.*HTTP 403/i),
      details: { status: 403 }
    });
    expect((error as Error).message).not.toMatch(/rate.?limit/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('rejects responses that exceed declared or streamed byte limits', async () => {
    const declaredClient = new WikiEventTimerClient({
      fetch: (async () => new Response('small body', {
        status: 200,
        headers: { 'content-length': '101' }
      })) as typeof globalThis.fetch,
      maxResponseBytes: 100,
      maxRetries: 0
    });
    await expect(declaredClient.fetchRecipe()).rejects.toMatchObject({
      code: 'GW2_UPSTREAM_UNAVAILABLE',
      message: expect.stringMatching(/size limit/i)
    });

    const streamedClient = new WikiEventTimerClient({
      fetch: (async () => new Response('x'.repeat(101), { status: 200 })) as typeof globalThis.fetch,
      maxResponseBytes: 100,
      maxRetries: 0
    });
    await expect(streamedClient.fetchRecipe()).rejects.toMatchObject({
      code: 'GW2_UPSTREAM_UNAVAILABLE',
      message: expect.stringMatching(/size limit/i)
    });
  });

  it('rejects malformed MediaWiki data, malformed recipes, and missing segment references', () => {
    expect(() => parseWikiEventTimerResponse({ query: { pages: [] } })).toThrow(Gw2ccError);
    expect(() => parseWikiEventTimerResponse(mediaWikiResponse({ nope: true }))).toThrow(/malformed timer recipe/i);
    expect(() => parseWikiEventTimerResponse(mediaWikiResponse({
      ...auricRecipe,
      events: {
        broken: {
          ...auricRecipe.events['hot-ab'],
          sequences: { partial: [], pattern: [{ r: 99, d: 60 }] }
        }
      }
    }))).toThrow(/missing segment/i);
  });

  it('supports a full-day non-repeating partial schedule and rejects uncovered schedules', () => {
    const fullDay = parseWikiEventTimerResponse(mediaWikiResponse({
      config: { version: 'manual-day' },
      events: {
        manual: {
          category: 'Core Tyria',
          name: 'Hard world bosses',
          segments: { 0: { name: '' }, 1: { name: 'Tequatl' } },
          sequences: { partial: [{ r: 1, d: 30 }, { r: 0, d: 1_410 }], pattern: [] }
        }
      }
    }));
    expect(fullDay.recipe.events.manual?.sequences.pattern).toEqual([]);

    expect(() => parseWikiEventTimerResponse(mediaWikiResponse({
      config: { version: 'broken-day' },
      events: {
        manual: {
          category: 'Core Tyria', name: 'Hard world bosses', segments: { 1: { name: 'Tequatl' } },
          sequences: { partial: [{ r: 1, d: 30 }], pattern: [] }
        }
      }
    }))).toThrow(/cannot cover a UTC day/i);
  });

  it('retries transient failures and bounds cancellation and timeout', async () => {
    const retryingFetch = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(mediaWikiResponse()), { status: 200 }));
    const retryingClient = new WikiEventTimerClient({
      fetch: retryingFetch as typeof globalThis.fetch,
      maxRetries: 1,
      sleep: async () => {}
    });
    await expect(retryingClient.fetchRecipe()).resolves.toMatchObject({ revisionId: 3_138_800 });
    expect(retryingFetch).toHaveBeenCalledTimes(2);

    const hangingFetch = vi.fn((_url: URL | RequestInfo, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    const cancelledClient = new WikiEventTimerClient({
      fetch: hangingFetch as unknown as typeof globalThis.fetch,
      timeoutMs: 1_000,
      maxRetries: 0
    });
    const controller = new AbortController();
    const cancelled = cancelledClient.fetchRecipe(controller.signal);
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ code: 'CANCELLED' });

    const timeoutClient = new WikiEventTimerClient({
      fetch: hangingFetch as unknown as typeof globalThis.fetch,
      timeoutMs: 5,
      maxRetries: 0
    });
    await expect(timeoutClient.fetchRecipe()).rejects.toMatchObject({
      code: 'GW2_UPSTREAM_UNAVAILABLE',
      message: expect.stringMatching(/timed out/i)
    });
  });
});

describe('deterministic event timer schedule expansion', () => {
  const recipe = parsedDocument().recipe;

  it('merges an initial partial with the prior UTC day and calculates active/upcoming fields', () => {
    const now = Date.parse('2026-08-11T00:10:00Z');
    const events = expandGw2EventTimerSchedule(recipe, now, defaultQuery);
    expect(events[0]).toMatchObject({
      timerId: 'hot-ab',
      category: 'Heart of Thorns',
      map: 'Auric Basin',
      event: 'Pylons',
      status: 'active',
      startedAt: '2026-08-10T23:30:00.000Z',
      endsAt: '2026-08-11T00:45:00.000Z',
      remainingMinutes: 35,
      durationMinutes: 75,
      chatLink: '[&BN0HAAA=]',
      wikiPage: 'Defending Tarir'
    });
    expect(events.find((event) => event.event === 'Octovine')).toMatchObject({
      status: 'upcoming',
      startsAt: '2026-08-11T01:00:00.000Z',
      endsAt: '2026-08-11T01:20:00.000Z',
      startsInMinutes: 50,
      durationMinutes: 20
    });
  });

  it('repeats patterns across the UTC midnight boundary and can exclude active events', () => {
    const now = Date.parse('2026-08-11T23:50:00Z');
    const withActive = expandGw2EventTimerSchedule(recipe, now, { ...defaultQuery, windowMinutes: 30 });
    expect(withActive[0]).toMatchObject({
      event: 'Pylons',
      status: 'active',
      startedAt: '2026-08-11T23:30:00.000Z',
      endsAt: '2026-08-12T00:45:00.000Z',
      durationMinutes: 75
    });
    const upcomingOnly = expandGw2EventTimerSchedule(recipe, now, {
      ...defaultQuery,
      windowMinutes: 60,
      includeActive: false
    });
    expect(upcomingOnly.every((event) => event.status === 'upcoming')).toBe(true);
    expect(upcomingOnly[0]).toMatchObject({ event: 'Challenges', startsAt: '2026-08-12T00:45:00.000Z' });
  });

  it('filters natural event, map, category, timer-ID, and Wiki-page terms before limiting', () => {
    const now = Date.parse('2026-08-11T00:10:00Z');
    for (const filter of ['Octovine', 'Auric Basin', 'Heart of Thorns', 'HOT-AB', 'Battle in Tarir']) {
      const events = expandGw2EventTimerSchedule(recipe, now, { ...defaultQuery, filter, limit: 1 });
      expect(events).toHaveLength(1);
      if (filter === 'Octovine') expect(events[0]?.event).toBe('Octovine');
    }
  });

  it('suppresses idle segment 0 and blank event segments', () => {
    const idleRecipe = parseWikiEventTimerResponse(mediaWikiResponse({
      config: { version: 'idle-test' },
      events: {
        idle: {
          category: 'Test',
          name: 'Idle Map',
          segments: { 0: { name: 'Should still be idle' }, 1: { name: '' }, 2: { name: 'Real event' } },
          sequences: { partial: [], pattern: [{ r: 0, d: 30 }, { r: 1, d: 30 }, { r: 2, d: 30 }] }
        }
      }
    })).recipe;
    const events = expandGw2EventTimerSchedule(idleRecipe, Date.parse('2026-08-11T00:00:00Z'), defaultQuery);
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.event === 'Real event')).toBe(true);
  });
});

describe('event timer recipe cache and fixtures', () => {
  it('hits fresh cache, refreshes after roughly six hours, recalculates every call, and falls back stale', async () => {
    let now = Date.parse('2026-08-11T00:10:00Z');
    const first = parsedDocument(100);
    const second = parsedDocument(200);
    const client = {
      fetchRecipe: vi.fn()
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(second)
        .mockResolvedValueOnce({ ...second, recipe: { config: { version: 'invalid' }, events: {} } })
        .mockRejectedValueOnce(new Gw2ccError('GW2_UPSTREAM_UNAVAILABLE', 'refresh failed', { retryable: true }))
    };
    const cache = new MemoryResourceCache();
    const gateway = new LiveGw2EventTimerGateway(client, cache, { now: () => now });

    const loaded = await gateway.getEventTimers(defaultQuery);
    expect(loaded.source).toMatchObject({ revisionId: 100, stale: false, fetchedAt: '2026-08-11T00:10:00.000Z' });
    expect(client.fetchRecipe).toHaveBeenCalledTimes(1);

    now += 10 * 60_000;
    const cached = await gateway.getEventTimers(defaultQuery);
    expect(cached.generatedAt).toBe('2026-08-11T00:20:00.000Z');
    expect(cached.events).not.toEqual(loaded.events);
    expect(client.fetchRecipe).toHaveBeenCalledTimes(1);

    now += GW2_WIKI_EVENT_TIMER_CACHE_TTL_MS;
    const refreshed = await gateway.getEventTimers(defaultQuery);
    expect(refreshed.source).toMatchObject({ revisionId: 200, stale: false, fetchedAt: '2026-08-11T06:20:00.000Z' });
    expect(client.fetchRecipe).toHaveBeenCalledTimes(2);

    now += GW2_WIKI_EVENT_TIMER_CACHE_TTL_MS + 1;
    const stale = await gateway.getEventTimers(defaultQuery);
    expect(stale.source).toMatchObject({ revisionId: 200, stale: true, fetchedAt: '2026-08-11T06:20:00.000Z' });
    expect(cache.set).toHaveBeenCalledTimes(2);

    now += 1;
    const staleAfterFailure = await gateway.getEventTimers(defaultQuery);
    expect(staleAfterFailure.source).toMatchObject({ revisionId: 200, stale: true });
    expect(cache.set).toHaveBeenCalledTimes(2);
  });

  it('provides deterministic account-independent fixture timers including Dragonstorm', async () => {
    const gateway = new FixtureGw2EventTimerGateway({ now: () => Date.parse('2026-08-11T00:50:00Z') });
    const result = await gateway.getEventTimers({ ...defaultQuery, filter: 'Dragonstorm' });
    expect(gateway.fixtureMode).toBe(true);
    expect(result.source).toMatchObject({ dataVersion: 'fixture-v1', stale: false });
    expect(result.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'Dragonstorm', map: 'Eye of the North' })
    ]));
  });
});
