import { describe, expect, it } from 'vitest';
import { InMemorySecretStore, ResearchService } from '@gw2cc/core';
import { FixtureGw2Gateway } from '@gw2cc/gw2';
import { MetaBattleToolExecutor } from '@gw2cc/tools';
import { LiveResearchGateway, MetaBattleClient, SafePageFetcher, TavilyClient } from '@gw2cc/web';
import { createPinnedWebNetworking } from './pinned-web-fetch';

const live = process.env.GW2CC_LIVE_METABATTLE === '1';

describe('live MetaBattle tool smoke', () => {
  it.runIf(live)('finds and parses the current Power Scrapper community build through pinned networking', async () => {
    const networking = createPinnedWebNetworking();
    try {
      const pages = new SafePageFetcher({ fetch: networking.fetch, resolve: networking.resolve });
      const gateway = new LiveResearchGateway(
        new TavilyClient(globalThis.fetch),
        pages,
        undefined,
        new MetaBattleClient(pages)
      );
      const tools = new MetaBattleToolExecutor(
        new ResearchService(gateway, new InMemorySecretStore()),
        new FixtureGw2Gateway()
      );
      const context = { timeZone: 'UTC', signal: new AbortController().signal };
      const search = await tools.execute({
        id: 'live-search',
        name: 'metabattle_search',
        arguments: { query: 'Power Scrapper', maxResults: 5 }
      }, context);
      expect(search.ok).toBe(true);
      const searchData = (search.value as any).data;
      const page = searchData.results.find((entry: any) => /power scrapper/i.test(entry.title));
      expect(page?.title).toBeTruthy();

      const build = await tools.execute({
        id: 'live-build',
        name: 'metabattle_build',
        arguments: { title: page.title }
      }, context);
      expect(build.ok).toBe(true);
      const data = (build.value as any).data;
      expect(data.build.skills.heal.name).toBe('Healing Turret');
      expect(data.build.skills.utilities.map((entry: any) => entry.name)).toEqual(expect.arrayContaining([
        'Throw Mine', 'Blast Gyro', 'Shredder Gyro'
      ]));
      expect(data.build.specializations.map((entry: any) => entry.name)).toContain('Scrapper');
      expect(data.build.mentionedTraits.map((entry: any) => entry.name)).toEqual(expect.arrayContaining([
        'Impact Savant', 'Kinetic Accelerators'
      ]));
      expect(data.build.equipment.runes.map((entry: any) => entry.name)).toContain('Superior Rune of the Scholar');
      expect(data.build.equipment.sigils.map((entry: any) => entry.name)).toEqual(expect.arrayContaining([
        'Superior Sigil of Force', 'Superior Sigil of Impact'
      ]));
      expect(data.build.equipment.relics.map((entry: any) => entry.name)).toContain('Relic of Fireworks');
      expect(data.build.buildTemplateCode).toMatch(/^\[&DQ/);
      expect(data.source).toMatchObject({
        url: expect.stringContaining('metabattle.com/wiki/'),
        revisionId: expect.any(Number)
      });
    } finally {
      networking.destroy();
    }
  }, 60_000);
});
