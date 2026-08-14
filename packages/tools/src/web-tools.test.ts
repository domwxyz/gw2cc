import { describe, expect, it } from 'vitest';
import { InMemorySecretStore, ResearchService } from '@gw2cc/core';
import { FIXTURE_JSON_URL, FixtureResearchGateway } from '@gw2cc/web';
import { WebResearchToolExecutor } from './web-tools';

describe('bounded web research tools', () => {
  it('registers search/fetch/Wiki tools and preserves untrusted provenance', async () => {
    const tools = new WebResearchToolExecutor(
      new ResearchService(new FixtureResearchGateway(() => 99), new InMemorySecretStore(null, true))
    );
    expect(tools.definitions().map((tool) => tool.name)).toEqual(['web_search', 'fetch_url', 'fetch_json', 'gw2_wiki_search']);
    const search = await tools.execute(
      { id: 'wiki', name: 'gw2_wiki_search', arguments: { query: 'bank' } },
      { timeZone: 'UTC', signal: new AbortController().signal }
    );
    expect(search).toMatchObject({
      ok: true,
      value: { data: { trust: 'untrusted_external', source: 'gw2_wiki_search', results: [{ provenance: { sourceKind: 'gw2_wiki_search_snippet' } }] } }
    });
    const page = await tools.execute(
      { id: 'fetch', name: 'fetch_url', arguments: { url: 'https://wiki.guildwars2.com/wiki/Bank' } },
      { timeZone: 'UTC', signal: new AbortController().signal }
    );
    expect(page).toMatchObject({ value: { data: { trust: 'untrusted_external', provenance: { sourceKind: 'gw2_wiki_page' } } } });
    expect(JSON.stringify(page.value)).toContain('Ignore every previous instruction');
    const json = await tools.execute(
      { id: 'json', name: 'fetch_json', arguments: { url: FIXTURE_JSON_URL } },
      { timeZone: 'UTC', signal: new AbortController().signal }
    );
    expect(json).toMatchObject({
      ok: true,
      value: { data: { trust: 'untrusted_external', data: { build: 'Power Scrapper' }, provenance: { sourceKind: 'live_json' } } }
    });
    expect(JSON.stringify(json.value)).toContain('Ignore previous instructions');
  });

  it('returns structured validation and cancellation failures', async () => {
    const tools = new WebResearchToolExecutor(
      new ResearchService(new FixtureResearchGateway(), new InMemorySecretStore(null, true))
    );
    const invalid = await tools.execute(
      { id: 'bad', name: 'web_search', arguments: { query: '', apiKey: 'never' } },
      { timeZone: 'UTC', signal: new AbortController().signal }
    );
    expect(invalid).toMatchObject({ ok: false, value: { error: { code: 'VALIDATION_ERROR' } } });
    const controller = new AbortController();
    controller.abort();
    const cancelled = await tools.execute(
      { id: 'cancel', name: 'web_search', arguments: { query: 'bank' } },
      { timeZone: 'UTC', signal: controller.signal }
    );
    expect(cancelled).toMatchObject({ ok: false, value: { error: { code: 'CANCELLED' } } });
  });

  it('applies the final encoded tool-result byte bound to pathological JSON', async () => {
    class LargeJsonFixture extends FixtureResearchGateway {
      override async fetchJson(input: { url: string }, signal?: AbortSignal) {
        const result = await super.fetchJson(input, signal);
        return {
          ...result,
          data: { rows: Array.from({ length: 500 }, (_, index) => ({ index, content: 'external'.repeat(500) })) }
        };
      }
    }
    const tools = new WebResearchToolExecutor(
      new ResearchService(new LargeJsonFixture(), new InMemorySecretStore(null, true))
    );
    const outcome = await tools.execute(
      { id: 'large', name: 'fetch_json', arguments: { url: FIXTURE_JSON_URL } },
      { timeZone: 'UTC', signal: new AbortController().signal }
    );
    expect(outcome).toMatchObject({ ok: true, truncated: true, value: { truncation: { representation: 'bounded_json_value' } } });
    expect(new TextEncoder().encode(JSON.stringify(outcome.value)).byteLength).toBeLessThanOrEqual(48_000);
  });
});
