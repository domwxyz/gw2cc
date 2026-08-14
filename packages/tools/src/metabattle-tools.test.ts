import { describe, expect, it, vi } from 'vitest';
import {
  InMemorySecretStore,
  ResearchService,
  type Gw2Gateway,
  type MetaBattleBuildResponse,
  type PublicGw2Definition,
  type PublicGw2ResourceKind
} from '@gw2cc/core';
import { FixtureGw2Gateway } from '@gw2cc/gw2';
import { FIXTURE_METABATTLE_TITLE, FixtureResearchGateway } from '@gw2cc/web';
import { enrichMetaBattleBuild, MetaBattleToolExecutor } from './metabattle-tools';

function createTools(): MetaBattleToolExecutor {
  return new MetaBattleToolExecutor(
    new ResearchService(new FixtureResearchGateway(() => 99), new InMemorySecretStore(null, true)),
    new FixtureGw2Gateway()
  );
}

async function fixtureBuild(): Promise<MetaBattleBuildResponse> {
  return new FixtureResearchGateway(() => 99).fetchMetaBattleBuild(FIXTURE_METABATTLE_TITLE);
}

function definitionGateway(
  specializations: PublicGw2Definition[],
  traits: PublicGw2Definition[]
): {
  gateway: Gw2Gateway;
  load: ReturnType<typeof vi.fn<(kind: PublicGw2ResourceKind, ids: readonly number[] | undefined) => Promise<PublicGw2Definition[]>>>;
} {
  const load = vi.fn(async (kind: PublicGw2ResourceKind, ids: readonly number[] | undefined) => {
    const definitions = kind === 'specializations' ? specializations : kind === 'traits' ? traits : [];
    return ids === undefined ? definitions : definitions.filter((entry) => ids.includes(entry.id));
  });
  return {
    gateway: {
      fixtureMode: true,
      validateKey: async () => { throw new Error('not used'); },
      getCharacterSnapshot: async () => { throw new Error('not used'); },
      get: async <T>() => [] as T,
      getPublicDefinitions: load
    },
    load
  };
}

describe('first-class MetaBattle tools', () => {
  it('registers direct community search/build tools with intentional source hierarchy descriptions', () => {
    const definitions = createTools().definitions();
    expect(definitions.map((definition) => definition.name)).toEqual(['metabattle_search', 'metabattle_build']);
    expect(definitions[0]?.description).toContain('not official ArenaNet guidance');
    expect(definitions[1]?.description).toContain('community-recommended skills');
  });

  it('returns bounded search activity with MetaBattle-specific untrusted provenance', async () => {
    const outcome = await createTools().execute(
      { id: 'search', name: 'metabattle_search', arguments: { query: 'Power Scrapper', maxResults: 3 } },
      { timeZone: 'UTC', signal: new AbortController().signal }
    );
    expect(outcome).toMatchObject({
      ok: true,
      summary: 'Found 1 MetaBattle result',
      truncated: false,
      value: {
        data: {
          trust: 'untrusted_external',
          source: 'metabattle_search',
          results: [{ title: FIXTURE_METABATTLE_TITLE, provenance: { sourceKind: 'metabattle_search_result' } }]
        }
      }
    });
  });

  it('returns structured build selections, revision provenance, and separately labeled direct-ID ArenaNet enrichment', async () => {
    const outcome = await createTools().execute(
      { id: 'build', name: 'metabattle_build', arguments: { title: FIXTURE_METABATTLE_TITLE } },
      { timeZone: 'UTC', signal: new AbortController().signal }
    );
    expect(outcome).toMatchObject({
      ok: true,
      summary: expect.stringContaining('revision 24676'),
      value: {
        data: {
          trust: 'untrusted_external',
          source: {
            revisionId: 24676,
            provenance: { sourceKind: 'metabattle_wikitext', trust: 'untrusted_external' }
          },
          build: {
            skills: {
              heal: { name: 'Healing Turret' },
              utilities: [{ name: 'Throw Mine' }, { name: 'Blast Gyro' }, { name: 'Shredder Gyro' }]
            },
            specializations: expect.arrayContaining([expect.objectContaining({ name: 'Scrapper', id: 43 })]),
            mentionedTraits: expect.arrayContaining([expect.objectContaining({ name: 'Impact Savant', id: 1877 })]),
            equipment: {
              runes: expect.arrayContaining([expect.objectContaining({ name: 'Superior Rune of the Scholar' })]),
              sigils: expect.arrayContaining([
                expect.objectContaining({ name: 'Superior Sigil of Force' }),
                expect.objectContaining({ name: 'Superior Sigil of Impact' })
              ]),
              relics: expect.arrayContaining([expect.objectContaining({ name: 'Relic of Fireworks' })])
            },
            buildTemplateCode: expect.stringMatching(/^\[&DQMm/)
          },
          provenance: { sourceKind: 'metabattle_build', trust: 'untrusted_external' },
          arenaNetEnrichment: {
            trust: 'official_arenanet_entity_definitions',
            resources: {
              skills: [{ id: 5806, name: 'Grenade Kit' }],
              traits: expect.arrayContaining([{ id: 1877, name: 'Impact Savant' }, { id: 2052, name: 'Kinetic Accelerators' }]),
              specializations: expect.arrayContaining([{ id: 43, name: 'Scrapper' }])
            },
            specializations: expect.arrayContaining([
              expect.objectContaining({
                sourceName: 'Scrapper',
                specializationId: 43,
                traits: [
                  expect.objectContaining({ position: 'top', tier: 1, traitId: 43_010 }),
                  expect.objectContaining({ position: 'bot', tier: 2, traitId: 43_022 }),
                  expect.objectContaining({ position: 'mid', tier: 3, traitId: 2052, name: 'Kinetic Accelerators' })
                ]
              })
            ]),
            note: expect.stringContaining('MetaBattle remains the source')
          }
        }
      }
    });
  });

  it('validates strict arguments and propagates structured not-found and cancellation errors', async () => {
    const tools = createTools();
    const invalid = await tools.execute(
      { id: 'bad', name: 'metabattle_search', arguments: { query: '', url: 'https://example.com' } },
      { timeZone: 'UTC', signal: new AbortController().signal }
    );
    expect(invalid).toMatchObject({ ok: false, value: { error: { code: 'VALIDATION_ERROR' } } });

    const missing = await tools.execute(
      { id: 'missing', name: 'metabattle_build', arguments: { title: 'Build:Missing' } },
      { timeZone: 'UTC', signal: new AbortController().signal }
    );
    expect(missing).toMatchObject({ ok: false, value: { error: { code: 'METABATTLE_PAGE_NOT_FOUND' } } });

    const controller = new AbortController();
    controller.abort();
    const cancelled = await tools.execute(
      { id: 'cancelled', name: 'metabattle_search', arguments: { query: 'Scrapper' } },
      { timeZone: 'UTC', signal: controller.signal }
    );
    expect(cancelled).toMatchObject({ ok: false, value: { error: { code: 'CANCELLED' } } });
  });
});

describe('MetaBattle positional trait enrichment', () => {
  it('resolves every top/mid/bot position across every Adept/Master/Grandmaster tier in one trait batch', async () => {
    const result = await fixtureBuild();
    const sourceChoices = [
      { name: 'alpha', traitChoices: ['top', 'mid', 'bot'] },
      { name: 'Beta', traitChoices: ['mid', 'bot', 'top'] },
      { name: 'Gamma', traitChoices: ['bot', 'top', 'mid'] }
    ];
    result.build.specializations = sourceChoices;
    result.build.mentionedTraits = [];
    const specializations: PublicGw2Definition[] = sourceChoices.map((entry, specializationIndex) => ({
      id: specializationIndex + 1,
      name: entry.name[0]!.toUpperCase() + entry.name.slice(1),
      majorTraitIds: [1, 2, 3].flatMap((tier) => [0, 1, 2].map((order) => (
        (specializationIndex + 1) * 100 + tier * 10 + order
      )))
    }));
    const traits = specializations.flatMap((specialization) => (
      [1, 2, 3].flatMap((tier) => [0, 1, 2].map((order) => ({
        id: specialization.id * 100 + tier * 10 + order,
        name: `${specialization.name} ${tier}-${order}`,
        specializationId: specialization.id,
        tier,
        order
      })))
    ));
    const { gateway, load } = definitionGateway(specializations, traits);

    const enrichment = await enrichMetaBattleBuild(result, gateway, new AbortController().signal);

    expect(enrichment?.specializations.map((entry) => entry.traits)).toEqual([
      [
        { position: 'top', tier: 1, traitId: 110, name: 'Alpha 1-0' },
        { position: 'mid', tier: 2, traitId: 121, name: 'Alpha 2-1' },
        { position: 'bot', tier: 3, traitId: 132, name: 'Alpha 3-2' }
      ],
      [
        { position: 'mid', tier: 1, traitId: 211, name: 'Beta 1-1' },
        { position: 'bot', tier: 2, traitId: 222, name: 'Beta 2-2' },
        { position: 'top', tier: 3, traitId: 230, name: 'Beta 3-0' }
      ],
      [
        { position: 'bot', tier: 1, traitId: 312, name: 'Gamma 1-2' },
        { position: 'top', tier: 2, traitId: 320, name: 'Gamma 2-0' },
        { position: 'mid', tier: 3, traitId: 331, name: 'Gamma 3-1' }
      ]
    ]);
    expect(load.mock.calls.filter(([kind]) => kind === 'specializations')).toHaveLength(1);
    expect(load.mock.calls.find(([kind]) => kind === 'specializations')?.[1]).toBeUndefined();
    expect(load.mock.calls.filter(([kind]) => kind === 'traits')).toHaveLength(1);
    expect(new Set(load.mock.calls.find(([kind]) => kind === 'traits')?.[1])).toEqual(
      new Set(traits.map((trait) => trait.id))
    );
  });

  it('preserves positions without fuzzy specialization matching or invented trait data when definitions are missing', async () => {
    const result = await fixtureBuild();
    result.build.specializations = [{ name: 'Alpha Plus', traitChoices: ['top', 'mid', 'bot'] }];
    result.build.mentionedTraits = [];
    const { gateway, load } = definitionGateway([
      { id: 1, name: 'Alpha', majorTraitIds: [110, 121, 132] }
    ], []);

    const enrichment = await enrichMetaBattleBuild(result, gateway, new AbortController().signal);

    expect(enrichment?.specializations).toEqual([{
      sourceName: 'Alpha Plus',
      traits: [
        { position: 'top', tier: 1 },
        { position: 'mid', tier: 2 },
        { position: 'bot', tier: 3 }
      ]
    }]);
    expect(load.mock.calls.some(([kind]) => kind === 'traits')).toBe(false);
  });

  it('partially enriches only explicit major-trait metadata from the resolved specialization', async () => {
    const result = await fixtureBuild();
    result.build.specializations = [{ name: 'Alpha', traitChoices: ['top', 'mid', 'bot'] }];
    result.build.mentionedTraits = [{ id: 888, sourceTemplate: 'Trait' }];
    const { gateway } = definitionGateway(
      [{ id: 1, name: 'Alpha', majorTraitIds: [110, 999, 132] }],
      [
        { id: 110, name: 'Adept Top', specializationId: 1, tier: 1, order: 0 },
        { id: 999, name: 'Wrong Specialization', specializationId: 2, tier: 2, order: 1 },
        { id: 888, name: 'Not A Major Trait', specializationId: 1, tier: 2, order: 1 },
        { id: 132, name: 'Grandmaster Bottom', specializationId: 1, tier: 3, order: 2 }
      ]
    );

    const enrichment = await enrichMetaBattleBuild(result, gateway, new AbortController().signal);

    expect(enrichment?.specializations[0]?.traits).toEqual([
      { position: 'top', tier: 1, traitId: 110, name: 'Adept Top' },
      { position: 'mid', tier: 2 },
      { position: 'bot', tier: 3, traitId: 132, name: 'Grandmaster Bottom' }
    ]);
  });

  it('keeps every positional choice when ArenaNet specialization enrichment is unavailable', async () => {
    const result = await fixtureBuild();
    result.build.specializations = [{ name: 'Alpha', traitChoices: ['top', 'mid', 'bot'] }];
    result.build.mentionedTraits = [];
    result.build.skills.other = [];
    const { gateway, load } = definitionGateway([], []);
    load.mockRejectedValue(new Error('definition service unavailable'));

    const enrichment = await enrichMetaBattleBuild(result, gateway, new AbortController().signal);

    expect(enrichment).toMatchObject({
      resources: {},
      unavailable: ['specializations'],
      specializations: [{
        sourceName: 'Alpha',
        traits: [
          { position: 'top', tier: 1 },
          { position: 'mid', tier: 2 },
          { position: 'bot', tier: 3 }
        ]
      }]
    });
  });
});
